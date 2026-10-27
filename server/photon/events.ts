import type {
  AdvancedIMessage,
  CatchUpEvent,
  LiveEvent,
  SharedFriendLocationUpdated,
  TypedEventStream,
} from "@photon-ai/advanced-imessage/grpc";

import type { PhotonConfig } from "./config.js";
import type { PhotonEventEnvelope } from "./contracts.js";
import {
  NormalizationError,
  computePayloadHash,
  eventTargetGuid,
  normalizeLiveEvent,
} from "./normalize.js";
import { admitEvent, type ConversationState } from "./policy.js";
import type { ConversationRow, PhotonStore } from "./store.js";

/**
 * Transport supervisor for ONE enrolled source. Owns the four unfiltered
 * durable event streams, concurrent + periodic catch-up replay, bounded
 * live location watches, heartbeat staleness detection, and reconnect
 * supervision. Persistence-only: policy runs at capture, dispatch and
 * outbound effects live elsewhere.
 */

export interface StreamBeat {
  readonly lastBeat?: string;
  readonly lastEvent?: string;
  readonly ok: boolean;
  readonly restarts: number;
}

export interface TransportHealth {
  readonly streams: Record<string, StreamBeat>;
  readonly lastCatchUpAt?: string;
  readonly catchUpHeadSequence?: string;
  readonly integrityConflicts: number;
  readonly normalizationFailures: number;
  readonly tombstoned: number;
  readonly locationWatches: readonly string[];
}

export interface PhotonTransport {
  readonly sourceId: string;
  health(): TransportHealth;
  /** Serialized catch-up replay from the durable watermark. */
  runCatchUp(): Promise<void>;
  /** Start/stop a live location watch (bounded set, outside the durable log). */
  setLocationWatch(address: string | undefined, start: boolean): Promise<boolean>;
  stop(): Promise<void>;
}

export interface TransportDeps {
  readonly client: AdvancedIMessage;
  readonly store: PhotonStore;
  readonly config: PhotonConfig;
  readonly sourceId: string;
  readonly logEpoch: string;
  readonly log?: (entry: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

type StreamEvent = LiveEvent | CatchUpEvent | SharedFriendLocationUpdated;
type AnyStream = TypedEventStream<StreamEvent>;

const DURABLE_STREAMS = ["messages", "chats", "groups", "polls"] as const;
type DurableStreamName = (typeof DURABLE_STREAMS)[number];

/** Bound on simultaneous live location watches (Bell subscription layer). */
const MAX_LOCATION_WATCHES = 32;
const MAX_BACKOFF_MS = 30_000;

function sleep(ms: number): Promise<void> {
  // Unref'd: a pending backoff must never hold the process open past stop().
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function backoff(failures: number): number {
  const exp = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(failures, 6));
  return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

function toConversationState(row: ConversationRow | undefined): ConversationState | undefined {
  if (!row) return undefined;
  return {
    bindingId: row.bindingId,
    scope: row.scope,
    generation: row.generation,
    membership: row.membership,
    membershipVersion: row.membershipVersion,
    initiatingPrincipal: row.initiatingPrincipal,
    retiredAt: row.retiredAt,
  };
}

/** Location envelopes live outside the durable sequence domain. */
function inboxSequenceNum(envelope: PhotonEventEnvelope): string {
  return envelope.event.family === "location" ? "-1" : envelope.sequence;
}

export function startTransport(deps: TransportDeps): PhotonTransport {
  const { client, store, config, sourceId, logEpoch } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));

  let stopped = false;
  const beats = new Map<string, { lastBeat?: number; lastEvent?: number; openedAt: number; ok: boolean; restarts: number }>();
  const liveStreams = new Map<string, AnyStream>();
  const tasks: Promise<void>[] = [];
  const locationWatches = new Map<string, { address?: string; stream?: AnyStream }>();
  let integrityConflicts = 0;
  let normalizationFailures = 0;
  let tombstoned = 0;
  let lastCatchUpAt: string | undefined;
  let catchUpHeadSequence: string | undefined;
  let catchUpChain: Promise<void> = Promise.resolve();

  /* ---------------------------------------------------------------- */
  /* Ingest                                                            */
  /* ---------------------------------------------------------------- */

  function beat(name: string, kind: "beat" | "event" | "open"): void {
    const entry = beats.get(name) ?? { ok: false, restarts: 0, openedAt: 0 };
    const t = now().getTime();
    if (kind === "beat") entry.lastBeat = t;
    else if (kind === "event") entry.lastEvent = t;
    else { entry.openedAt = t; entry.ok = true; }
    beats.set(name, entry);
  }

  /** Minimal sequence tombstone so unknown/broken variants leave no gap. */
  async function captureTombstone(
    raw: StreamEvent,
    sourceKind: "live" | "catchup",
    reason: string,
  ): Promise<void> {
    const sequence = typeof raw === "object" && raw !== null && "sequence" in raw
      && typeof raw.sequence === "number" && Number.isSafeInteger(raw.sequence) && raw.sequence >= 0
      ? String(raw.sequence)
      : undefined;
    if (!sequence) {
      normalizationFailures++;
      log({ level: "warn", msg: "photon_event_unkeyable", reason });
      return;
    }
    try {
      const capture = await store.captureEvent({
        sourceId, logEpoch, sequence, sequenceNum: sequence,
        payloadHash: `tombstone:${sequence}:${reason}`,
        tombstone: true,
        eventType: typeof raw === "object" && raw !== null && "type" in raw ? String(raw.type) : "unknown",
        chatGuid: typeof raw === "object" && raw !== null && "chatGuid" in raw ? String(raw.chatGuid) : undefined,
        sourceKind,
        disposition: "tombstone",
      });
      if (capture.kind === "inserted") {
        tombstoned++;
        await store.markInboxProcessing(capture.ref, "settled", reason);
      }
    } catch (error) {
      log({ level: "error", msg: "photon_tombstone_failed", sequence, error: String(error) });
    }
  }

  async function ingest(raw: StreamEvent, sourceKind: "live" | "catchup"): Promise<void> {
    const receivedAt = now().toISOString();
    let envelope: PhotonEventEnvelope | null;
    try {
      envelope = normalizeLiveEvent(raw, sourceKind, receivedAt);
    } catch (error) {
      if (error instanceof NormalizationError) {
        normalizationFailures++;
        await captureTombstone(raw, sourceKind, error.detail);
        return;
      }
      throw error;
    }
    if (!envelope) {
      await captureTombstone(raw, sourceKind, "unrecognized_variant");
      return;
    }
    // Replay control markers are consumed by the catch-up loop, never stored
    // in the inbox (they would collide with real sequences).
    if (envelope.event.family === "catchup") return;

    const conversation = envelope.chatGuid
      ? await store.getConversation(sourceId, envelope.chatGuid)
      : undefined;
    const decision = admitEvent(config, envelope, toConversationState(conversation));
    const denied = decision.disposition === "denied" || decision.disposition === "quarantined";
    const capture = await store.captureEvent({
      sourceId,
      logEpoch,
      sequence: envelope.sequence,
      sequenceNum: inboxSequenceNum(envelope),
      payloadHash: computePayloadHash(envelope),
      // Policy-denied events persist as minimal tombstones; rejected users'
      // message bodies are never written.
      envelope: denied ? undefined : envelope,
      tombstone: denied,
      eventFamily: envelope.event.family,
      eventType: envelope.event.type,
      chatGuid: envelope.chatGuid,
      actor: envelope.actor,
      targetGuid: eventTargetGuid(envelope),
      isFromMe: envelope.isFromMe,
      occurredAt: envelope.occurredAt,
      sourceKind,
      disposition: decision.disposition,
    });
    if (capture.kind === "integrity_conflict") {
      integrityConflicts++;
      log({
        level: "error", msg: "photon_integrity_conflict", sequence: envelope.sequence,
        existingHash: capture.existingHash,
      });
      return;
    }
    if (capture.kind === "duplicate") return;
    if (denied) await store.markInboxProcessing(capture.ref, "settled", decision.reason);
  }

  /* ---------------------------------------------------------------- */
  /* Durable catch-up                                                   */
  /* ---------------------------------------------------------------- */

  function safeSince(watermark: string | undefined): number | undefined {
    if (watermark === undefined) return undefined;
    const value = Number(watermark);
    if (!Number.isSafeInteger(value))
      throw new NormalizationError(`capture cursor ${watermark} exceeds the safe sequence domain.`);
    return value;
  }

  async function doCatchUp(): Promise<void> {
    const watermark = await store.maxSequenceNum(sourceId, logEpoch);
    const since = safeSince(watermark);
    const stream = client.events.catchUp(since);
    liveStreams.set("catchup", stream);
    beat("catchup", "open");
    let headSequence: string | undefined;
    let replayed = 0;
    try {
      for await (const event of stream) {
        if (stopped) break;
        beat("catchup", "event");
        if (typeof event === "object" && event !== null && event.type === "catchup.complete") {
          const normalized = normalizeLiveEvent(event, "catchup", now().toISOString());
          if (normalized?.event.family === "catchup") headSequence = normalized.event.headSequence;
          continue;
        }
        await ingest(event, "catchup");
        replayed++;
      }
      // The cursor may only advance across catch-up coverage after every
      // returned record is durably stored (PRD §7.2).
      if (headSequence !== undefined && !stopped) {
        await store.updateCaptureCursor(sourceId, headSequence, {
          lastCatchUpAt: now().toISOString(),
          replayed,
          since: watermark ?? null,
        });
        // First activation boundary: retained history before it hydrates
        // state but never triggers replies (idempotent — first write wins).
        await store.setActivationBoundary(sourceId, headSequence);
        catchUpHeadSequence = headSequence;
        lastCatchUpAt = now().toISOString();
      }
    } finally {
      const catchupBeat = beats.get("catchup");
      if (catchupBeat) catchupBeat.ok = false;
      liveStreams.delete("catchup");
      await stream.close().catch(() => undefined);
    }
  }

  /** Serializes catch-up runs; reconnects and the periodic sweep share it. */
  function runCatchUp(): Promise<void> {
    if (stopped) return Promise.resolve();
    const next = catchUpChain.then(doCatchUp, doCatchUp);
    catchUpChain = next.then(() => undefined, () => undefined);
    return next;
  }

  /* ---------------------------------------------------------------- */
  /* Stream supervision                                                 */
  /* ---------------------------------------------------------------- */

  function openDurableStream(name: DurableStreamName): AnyStream {
    const onHeartbeat = () => beat(name, "beat");
    switch (name) {
      case "messages": return client.messages.subscribeEvents({ onHeartbeat });
      case "chats": return client.chats.subscribeEvents({ onHeartbeat });
      case "groups": return client.groups.subscribeEvents({ onHeartbeat });
      case "polls": return client.polls.subscribeEvents({ onHeartbeat });
    }
  }

  async function supervise(name: DurableStreamName): Promise<void> {
    let failures = 0;
    while (!stopped) {
      try {
        // Replay first: the live subscription accepts no replay cursor, so
        // every reconnect must re-establish coverage through catch-up.
        await runCatchUp();
        if (stopped) break;
        const stream = openDurableStream(name);
        liveStreams.set(name, stream);
        beat(name, "open");
        failures = 0;
        for await (const event of stream) {
          if (stopped) break;
          beat(name, "event");
          await ingest(event, "live");
        }
      } catch (error) {
        failures++;
        log({
          level: "warn", msg: "photon_stream_failed", stream: name,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        const entry = beats.get(name);
        if (entry) entry.ok = false;
        liveStreams.delete(name);
      }
      if (stopped) break;
      const entry = beats.get(name);
      if (entry) entry.restarts++;
      await sleep(backoff(failures));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Location watches (separate sequence space, live only)              */
  /* ---------------------------------------------------------------- */

  async function watchLocation(key: string, address: string | undefined): Promise<void> {
    let failures = 0;
    const name = `location:${key}`;
    while (!stopped && locationWatches.has(key)) {
      try {
        const stream = client.locations.watch(address, { onHeartbeat: () => beat(name, "beat") });
        const watch = locationWatches.get(key);
        if (!watch) { await stream.close(); break; }
        watch.stream = stream;
        beat(name, "open");
        failures = 0;
        for await (const update of stream) {
          if (stopped || !locationWatches.has(key)) break;
          beat(name, "event");
          await ingest(update, "live");
        }
      } catch (error) {
        failures++;
        log({
          level: "warn", msg: "photon_location_watch_failed", address: address ?? "account",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (stopped || !locationWatches.has(key)) break;
      await sleep(backoff(failures));
    }
  }

  async function setLocationWatch(address: string | undefined, start: boolean): Promise<boolean> {
    const key = address ?? "";
    if (!start) {
      const watch = locationWatches.get(key);
      if (!watch) return false;
      locationWatches.delete(key);
      await watch.stream?.close().catch(() => undefined);
      return true;
    }
    if (locationWatches.has(key)) return true;
    if (locationWatches.size >= MAX_LOCATION_WATCHES) return false;
    locationWatches.set(key, { address });
    tasks.push(watchLocation(key, address));
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Heartbeat watchdog                                                 */
  /* ---------------------------------------------------------------- */

  const watchdog = setInterval(() => {
    if (stopped) return;
    const t = now().getTime();
    for (const [name, stream] of liveStreams) {
      if (name === "catchup") continue;
      const entry = beats.get(name);
      const lastActivity = Math.max(entry?.lastBeat ?? 0, entry?.lastEvent ?? 0, entry?.openedAt ?? 0);
      if (lastActivity > 0 && t - lastActivity > config.worker.heartbeatStaleMs) {
        log({ level: "warn", msg: "photon_stream_stale", stream: name });
        stream.close().catch(() => undefined);
      }
    }
  }, Math.max(1_000, Math.floor(config.worker.heartbeatStaleMs / 4)));
  watchdog.unref?.();

  for (const name of DURABLE_STREAMS) {
    beats.set(name, { ok: false, restarts: 0, openedAt: 0 });
    tasks.push(supervise(name));
  }
  // Initial replay runs concurrently with the live streams per PRD §7.2.
  tasks.push(runCatchUp().catch((error) => {
    log({ level: "error", msg: "photon_initial_catchup_failed", error: String(error) });
  }));

  /* ---------------------------------------------------------------- */

  return {
    sourceId,
    health() {
      const streams: Record<string, StreamBeat> = {};
      for (const [name, entry] of beats) {
        streams[name] = {
          lastBeat: entry.lastBeat ? new Date(entry.lastBeat).toISOString() : undefined,
          lastEvent: entry.lastEvent ? new Date(entry.lastEvent).toISOString() : undefined,
          ok: entry.ok,
          restarts: entry.restarts,
        };
      }
      return {
        streams,
        lastCatchUpAt,
        catchUpHeadSequence,
        integrityConflicts,
        normalizationFailures,
        tombstoned,
        locationWatches: [...locationWatches.keys()],
      };
    },
    runCatchUp,
    setLocationWatch,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(watchdog);
      const closers = [...liveStreams.values()].map((stream) => stream.close().catch(() => undefined));
      for (const watch of locationWatches.values())
        closers.push(watch.stream?.close().catch(() => undefined) ?? Promise.resolve());
      locationWatches.clear();
      await Promise.allSettled(closers);
      await Promise.allSettled(tasks);
    },
  };
}
