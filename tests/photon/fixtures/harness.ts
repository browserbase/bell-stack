/**
 * Shared Photon test harness: a valid config, envelope builders, a fake
 * TypedEventStream, an in-memory PhotonDb seam, and the optional-module
 * loader used to test pipeline modules that parallel workstreams are still
 * implementing (their describes skip when the module is absent).
 */
import { createHash } from "node:crypto";

import type { PhotonConfig } from "../../../server/photon/config";
import {
  ENVELOPE_VERSION,
  type PhotonEventEnvelope,
  type PhotonNormalizedEvent,
} from "../../../server/photon/contracts";
import { sha256Hex } from "../../../server/photon/identity";
import type {
  ArtifactInsert,
  ArtifactRow,
  CommandPatch,
  CommandRow,
  ConversationRow,
  ConversationUpsert,
  DeadlineRow,
  InboxCapture,
  InboxInsert,
  InboxRef,
  InboxRow,
  IntentInsert,
  IntentPatch,
  IntentRow,
  InteractionInsert,
  InteractionRow,
  PhotonDb,
  ProjectorRow,
  ResourceKind,
  ResourceRow,
  SourceEnrollment,
  SourceRow,
  SourceStatus,
} from "../../../server/photon/store";

import { GROUP_CHAT, OPERATOR_PHONE, RECEIVING_LINE } from "./sdk-events";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export const TEST_PROJECT_ID = "test-project-0001";
export const TEST_INSTANCE_ID = "inst-aaaa-bbbb";

/** A fully valid enabled channel config; override fields per test. */
export function testConfig(overrides: Partial<PhotonConfig> = {}): PhotonConfig {
  return {
    projectId: TEST_PROJECT_ID,
    projectSecret: "test-project-secret",
    phoneNumber: RECEIVING_LINE,
    allowedSenders: [OPERATOR_PHONE],
    allowedEmailSenders: [],
    allowedGroups: [],
    internalSecret: "test-internal-secret-0123456789abcdef",
    internalOrigin: "http://127.0.0.1:4274",
    databaseUrl: "postgres://unused.invalid/bell",
    publicUrl: "https://bell.example",
    worker: {
      leaseMs: 30_000,
      heartbeatStaleMs: 90_000,
      commandBatchSize: 8,
      dispatchBatchSize: 8,
      commandPollMs: 500,
      dispatchPollMs: 500,
      projectionPollMs: 1_000,
      reconciliationMs: 300_000,
      shutdownMs: 15_000,
      maxArtifactBytes: 24 * 1024 * 1024,
    },
    ...overrides,
  };
}

export function groupConfig(overrides: Partial<PhotonConfig> = {}): PhotonConfig {
  return testConfig({ allowedGroups: [GROUP_CHAT], ...overrides });
}

/* ------------------------------------------------------------------ */
/* Envelopes                                                           */
/* ------------------------------------------------------------------ */

export interface EnvelopeInput {
  readonly sequence?: string;
  readonly chatGuid?: string;
  readonly isFromMe?: boolean;
  readonly occurredAt?: string;
  readonly receivedAt?: string;
  readonly sourceKind?: "live" | "catchup";
  readonly actor?: string;
}

export function envelope(event: PhotonNormalizedEvent, input: EnvelopeInput = {}): PhotonEventEnvelope {
  return {
    version: ENVELOPE_VERSION,
    sequence: input.sequence ?? "1",
    chatGuid: input.chatGuid,
    isFromMe: input.isFromMe,
    occurredAt: input.occurredAt ?? "2026-10-27T12:00:00.000Z",
    receivedAt: input.receivedAt ?? "2026-10-27T12:00:01.000Z",
    sourceKind: input.sourceKind ?? "live",
    actor: input.actor,
    event,
  };
}

/** Canonical payload hash over the durable envelope minus transport metadata. */
export function payloadHashFor(env: PhotonEventEnvelope): string {
  // Transport-only fields are dropped by JSON.stringify so replays and
  // redeliveries hash identically.
  return sha256Hex(JSON.stringify({ ...env, receivedAt: undefined, sourceKind: undefined }));
}

/* ------------------------------------------------------------------ */
/* Fake TypedEventStream                                               */
/* ------------------------------------------------------------------ */

export interface FakeStream<T> extends AsyncIterable<T> {
  on(callback: (event: T) => void | Promise<void>, onError?: (error: unknown) => void): () => void;
  filter(predicate: (event: T) => boolean): FakeStream<T>;
  map<U>(transform: (event: T) => U): FakeStream<U>;
  take(count: number): FakeStream<T>;
  close(): Promise<void>;
}

/**
 * An async-iterable event stream mirroring the SDK's TypedEventStream surface
 * (`for await`, `.on()`, `.filter()`, `.map()`, `.take()`, `.close()`).
 * `opts.error` is thrown after every queued event was delivered, simulating a
 * mid-stream disconnect.
 */
export function fakeStream<T>(events: readonly T[], opts: { error?: unknown } = {}): FakeStream<T> {
  const queue = [...events];
  let closed = false;
  let consuming = false;
  let onCancel: (() => void) | undefined;

  async function* iterate(source: readonly T[]): AsyncGenerator<T> {
    for (const event of source) {
      if (closed) return;
      yield event;
      await new Promise<void>((resolve) => { onCancel = resolve; setTimeout(resolve, 0); });
    }
    if (opts.error !== undefined && !closed) throw opts.error;
  }

  const stream: FakeStream<T> = {
    async *[Symbol.asyncIterator]() {
      if (consuming) throw new Error("stream already consumed");
      consuming = true;
      yield* iterate(queue);
    },
    on(callback, onError) {
      if (consuming) throw new Error("stream already consumed");
      consuming = true;
      let running = true;
      void (async () => {
        try {
          for await (const event of iterate(queue)) {
            if (!running) break;
            await callback(event);
          }
        } catch (error) {
          if (running) onError?.(error);
        }
      })();
      return () => { running = false; };
    },
    filter(predicate) {
      return fakeStream(queue.filter(predicate), opts);
    },
    map(transform) {
      return fakeStream(queue.map(transform), opts);
    },
    take(count) {
      return fakeStream(queue.slice(0, Math.max(0, count)), opts);
    },
    async close() {
      closed = true;
      onCancel?.();
    },
  };
  return stream;
}

/* ------------------------------------------------------------------ */
/* Optional module loader                                              */
/* ------------------------------------------------------------------ */

/**
 * Imports a pipeline module by path, returning `undefined` when it does not
 * exist yet in this worktree. The indirection keeps TypeScript from
 * statically resolving a module that parallel workstreams have not landed.
 * Specifiers resolve relative to this file (`tests/photon/fixtures/`).
 */
export function optionalModule<T>(specifier: string): Promise<T | undefined> {
  const load = (path: string): Promise<T> => import(path) as Promise<T>;
  return load(specifier).catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/* In-memory PhotonDb seam                                             */
/* ------------------------------------------------------------------ */

function refKey(ref: InboxRef): string {
  return `${ref.sourceId}${ref.logEpoch}${ref.sequence}`;
}

function num(value: string): bigint {
  return BigInt(value);
}

/**
 * An in-memory implementation of the frozen `PhotonDb` contract. It mirrors
 * the SQL semantics in `server/photon/store.ts`: PK dedup, hash-checked
 * integrity conflicts, per-chat ordering, SKIP-LOCKED-style command claims,
 * COALESCE patches, and one-time interaction resolution. Tests use it as the
 * seam between pure pipeline logic and PostgreSQL.
 */
export function inMemoryDb(): PhotonDb & {
  readonly inbox: Map<string, InboxRow>;
  readonly intents: Map<string, IntentRow>;
  readonly commands: Map<string, CommandRow>;
  readonly conversations: Map<string, ConversationRow>;
  readonly sources: Map<string, SourceRow>;
  readonly interactions: Map<string, InteractionRow>;
  readonly deadlines: Map<string, DeadlineRow>;
} {
  const sources = new Map<string, SourceRow>();
  const inbox = new Map<string, InboxRow>();
  const conversations = new Map<string, ConversationRow>();
  const intents = new Map<string, IntentRow>();
  const commands = new Map<string, CommandRow>();
  const commandsBySemanticKey = new Map<string, CommandRow>();
  const resources = new Map<string, ResourceRow>();
  const artifacts = new Map<string, ArtifactRow>();
  const interactions = new Map<string, InteractionRow>();
  const projectors = new Map<string, ProjectorRow>();
  const deadlines = new Map<string, DeadlineRow>();

  function mapSourceRow(row: SourceRow): SourceRow {
    return { ...row };
  }

  function requireSource(sourceId: string): SourceRow {
    const source = sources.get(sourceId);
    if (!source) throw new Error(`in-memory source ${sourceId} is not enrolled`);
    return source;
  }

  const db: PhotonDb = {
    /* ------------------------------ sources ------------------------------ */
    async enrollSource(input: SourceEnrollment) {
      const existing = sources.get(input.sourceId);
      if (existing) {
        existing.phoneNumber = input.phoneNumber;
        existing.endpoint = input.endpoint;
        return mapSourceRow(existing);
      }
      const row: SourceRow = {
        ...input,
        coverage: {},
        health: {},
        leaseEpoch: 0,
        status: "pending",
      };
      sources.set(input.sourceId, row);
      return mapSourceRow(row);
    },
    async getSource(sourceId) {
      const row = sources.get(sourceId);
      return row ? mapSourceRow(row) : undefined;
    },
    async setSourceStatus(sourceId, status: SourceStatus) {
      requireSource(sourceId).status = status;
    },
    async updateCaptureCursor(sourceId, cursor, coverage) {
      const source = requireSource(sourceId);
      source.captureCursor = cursor;
      if (coverage) source.coverage = { ...coverage };
    },
    async acquireLease(sourceId, ownerToken, leaseMs) {
      const source = requireSource(sourceId);
      const expired = !source.leaseExpiresAt || source.leaseExpiresAt.getTime() <= Date.now();
      if (source.ownerToken && source.ownerToken !== ownerToken && !expired)
        return { acquired: false, owner: source.ownerToken } as const;
      source.ownerToken = ownerToken;
      source.leaseEpoch += 1;
      source.leaseExpiresAt = new Date(Date.now() + leaseMs);
      return { acquired: true, epoch: source.leaseEpoch } as const;
    },
    async renewLease(sourceId, ownerToken, epoch, leaseMs) {
      const source = requireSource(sourceId);
      if (source.ownerToken !== ownerToken || source.leaseEpoch !== epoch) return false;
      source.leaseExpiresAt = new Date(Date.now() + leaseMs);
      return true;
    },
    async releaseLease(sourceId, ownerToken, epoch) {
      const source = requireSource(sourceId);
      if (source.ownerToken === ownerToken && source.leaseEpoch === epoch) {
        source.ownerToken = undefined;
        source.leaseExpiresAt = undefined;
      }
    },
    async updateSourceHealth(sourceId, health) {
      requireSource(sourceId).health = { ...health };
    },
    async updateCredentialExpiry(sourceId, expiresAt) {
      requireSource(sourceId).credentialExpiresAt = expiresAt;
    },

    /* ------------------------------- inbox ------------------------------- */
    async captureEvent(input: InboxInsert): Promise<InboxCapture> {
      const ref = { sourceId: input.sourceId, logEpoch: input.logEpoch, sequence: input.sequence };
      const key = refKey(ref);
      const existing = inbox.get(key);
      if (!existing) {
        inbox.set(key, {
          ...ref,
          sequenceNum: input.sequenceNum,
          payloadHash: input.payloadHash,
          envelope: input.envelope,
          tombstone: input.tombstone ?? false,
          eventFamily: input.eventFamily,
          eventType: input.eventType,
          chatGuid: input.chatGuid,
          actor: input.actor,
          targetGuid: input.targetGuid,
          isFromMe: input.isFromMe,
          occurredAt: input.occurredAt,
          receivedAt: new Date().toISOString(),
          sourceKind: input.sourceKind,
          disposition: input.disposition ?? "pending",
          processingState: "captured",
          attempts: 0,
        });
        return { kind: "inserted", ref };
      }
      if (existing.payloadHash !== input.payloadHash)
        return { kind: "integrity_conflict", ref, existingHash: existing.payloadHash };
      return { kind: "duplicate", ref };
    },
    async getInboxRow(ref) {
      return inbox.get(refKey(ref));
    },
    async updateDisposition(ref, disposition, lastError) {
      const row = inbox.get(refKey(ref));
      if (!row) return;
      row.disposition = disposition;
      if (lastError !== undefined) row.lastError = lastError;
    },
    async markInboxProcessing(ref, state, lastError) {
      const row = inbox.get(refKey(ref));
      if (!row) return;
      row.processingState = state;
      row.attempts += 1;
      if (lastError !== undefined) row.lastError = lastError;
    },
    async pendingForChat(sourceId, chatGuid, limit) {
      return [...inbox.values()]
        .filter((row) => row.sourceId === sourceId && row.chatGuid === chatGuid
          && row.disposition === "admitted" && row.processingState === "captured")
        .sort((a, b) => (num(a.sequenceNum) < num(b.sequenceNum) ? -1 : 1))
        .slice(0, limit);
    },
    async pendingDispatch(sourceId, limit) {
      const firstByChat = new Map<string, InboxRow>();
      const ordered = [...inbox.values()]
        .filter((row) => row.sourceId === sourceId && row.disposition === "admitted" && row.processingState === "captured")
        .sort((a, b) => (num(a.sequenceNum) < num(b.sequenceNum) ? -1 : 1));
      for (const row of ordered) {
        const key = row.chatGuid ?? "";
        if (!firstByChat.has(key)) firstByChat.set(key, row);
      }
      return [...firstByChat.values()].slice(0, limit);
    },
    async dispatchableChatScopes(sourceId, limit) {
      const firstSeqByScope = new Map<string | null, bigint>();
      for (const row of inbox.values()) {
        if (row.sourceId !== sourceId || row.processingState !== "captured") continue;
        if (row.disposition !== "admitted" && row.disposition !== "state_only") continue;
        const scope = row.chatGuid ?? null;
        const seq = num(row.sequenceNum);
        const existing = firstSeqByScope.get(scope);
        if (existing === undefined || seq < existing) firstSeqByScope.set(scope, seq);
      }
      return [...firstSeqByScope.entries()]
        .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
        .slice(0, limit)
        .map(([scope]) => scope);
    },
    async dispatchableForChat(sourceId, chatGuid, limit) {
      return [...inbox.values()]
        .filter((row) => {
          if (row.sourceId !== sourceId || row.processingState !== "captured") return false;
          if (chatGuid === null)
            return row.chatGuid === undefined && row.disposition === "state_only";
          return row.chatGuid === chatGuid
            && (row.disposition === "admitted" || row.disposition === "state_only");
        })
        .sort((a, b) => (num(a.sequenceNum) < num(b.sequenceNum) ? -1 : 1))
        .slice(0, limit);
    },
    async maxSequenceNum(sourceId, logEpoch) {
      let max: bigint | undefined;
      for (const row of inbox.values()) {
        if (row.sourceId !== sourceId || row.logEpoch !== logEpoch) continue;
        const value = num(row.sequenceNum);
        if (max === undefined || value > max) max = value;
      }
      return max?.toString();
    },
    async activationBoundary(sourceId) {
      return requireSource(sourceId).activationBoundary;
    },
    async setActivationBoundary(sourceId, boundary) {
      const source = requireSource(sourceId);
      if (source.activationBoundary === undefined) source.activationBoundary = boundary;
    },
    async inboxStats(sourceId) {
      const pending = [...inbox.values()].filter(
        (row) => row.sourceId === sourceId && row.disposition === "admitted" && row.processingState === "captured",
      );
      return {
        pending: pending.length,
        quarantined: [...inbox.values()].filter((row) => row.sourceId === sourceId && row.processingState === "quarantined").length,
        oldestPendingAgeSec: null,
      };
    },

    /* --------------------------- conversations --------------------------- */
    async getConversation(sourceId, chatGuid) {
      const matches = [...conversations.values()]
        .filter((row) => row.sourceId === sourceId && row.chatGuid === chatGuid)
        .sort((a, b) => b.generation - a.generation);
      return matches[0];
    },
    async getConversationById(bindingId) {
      return conversations.get(bindingId);
    },
    async upsertConversation(input: ConversationUpsert) {
      const existing = conversations.get(input.bindingId);
      if (existing) {
        if (input.membership !== undefined) existing.membership = [...input.membership];
        return existing;
      }
      const row: ConversationRow = {
        bindingId: input.bindingId,
        sourceId: input.sourceId,
        chatGuid: input.chatGuid,
        generation: input.generation,
        scope: input.scope,
        eveAddress: input.eveAddress,
        eveSessionId: input.eveSessionId,
        initiatingPrincipal: input.initiatingPrincipal,
        membershipVersion: 0,
        membership: [...(input.membership ?? [])],
        createdAt: new Date().toISOString(),
      };
      conversations.set(input.bindingId, row);
      return row;
    },
    async bindEveSession(bindingId, eveSessionId) {
      const row = conversations.get(bindingId);
      if (row) row.eveSessionId = eveSessionId;
    },
    async updateMembership(bindingId, membership) {
      const row = conversations.get(bindingId);
      if (!row) return;
      row.membership = [...membership];
      row.membershipVersion += 1;
    },
    async touchConversation(bindingId) {
      const row = conversations.get(bindingId);
      if (row) row.lastTurnAt = new Date().toISOString();
    },
    async retireConversation(bindingId) {
      const row = conversations.get(bindingId);
      if (row && !row.retiredAt) row.retiredAt = new Date().toISOString();
    },
    async activeConversations(sourceId) {
      return [...conversations.values()].filter((row) => row.sourceId === sourceId && !row.retiredAt);
    },
    async findConversationBySession(eveSessionId) {
      return [...conversations.values()].find((row) => row.eveSessionId === eveSessionId);
    },

    /* --------------------------- dispatch intents ------------------------ */
    async upsertIntent(input: IntentInsert) {
      const existing = [...intents.values()].find((row) => row.dispatchKey === input.dispatchKey);
      if (existing) return existing;
      const row: IntentRow = { ...input, status: "pending", attempts: 0, createdAt: new Date().toISOString() };
      intents.set(input.intentId, row);
      return row;
    },
    async getIntentByKey(dispatchKey) {
      return [...intents.values()].find((row) => row.dispatchKey === dispatchKey);
    },
    async updateIntent(intentId, patch: IntentPatch) {
      const row = intents.get(intentId);
      if (!row) return;
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.eveSessionId !== undefined) row.eveSessionId = patch.eveSessionId;
      if (patch.deliveryId !== undefined) row.deliveryId = patch.deliveryId;
      if (patch.lastError !== undefined) row.lastError = patch.lastError;
      row.attempts += 1;
    },
    async pendingIntents(sourceId, limit) {
      return [...intents.values()]
        .filter((row) => row.sourceId === sourceId && row.status === "pending")
        .sort((a, b) => {
          const seqA = num(inbox.get(refKey(a))?.sequenceNum ?? "0");
          const seqB = num(inbox.get(refKey(b))?.sequenceNum ?? "0");
          return seqA < seqB ? -1 : 1;
        })
        .slice(0, limit);
    },

    /* ------------------------------ commands ----------------------------- */
    async enqueueCommand(command) {
      const byKey = commandsBySemanticKey.get(command.semanticKey);
      if (byKey) {
        if (byKey.argsDigest !== command.argsDigest)
          throw new Error(`semantic_key ${command.semanticKey} already exists with different arguments.`);
        return { commandId: byKey.commandId, deduplicated: true };
      }
      if (commands.has(command.commandId))
        throw new Error(`duplicate command_id ${command.commandId}`);
      const row: CommandRow = {
        commandId: command.commandId,
        operation: command.operation,
        args: { ...command.args },
        argsDigest: command.argsDigest,
        initiatorPrincipal: command.initiatorPrincipal,
        audience: command.audience,
        sourceId: command.sourceId,
        chatGuid: command.chatGuid,
        target: command.target ? { ...command.target } : undefined,
        providerKey: command.providerKey,
        semanticKey: command.semanticKey,
        dependsOn: [...command.dependsOn],
        status: "queued",
        attemptCount: 0,
        nextAttemptAt: new Date(),
        expiresAt: command.expiresAt ? new Date(command.expiresAt) : undefined,
        createdAt: new Date(),
      };
      commands.set(row.commandId, row);
      commandsBySemanticKey.set(row.semanticKey, row);
      return { commandId: row.commandId, deduplicated: false };
    },
    async getCommand(commandId) {
      return commands.get(commandId);
    },
    async getCommandBySemanticKey(semanticKey) {
      return commandsBySemanticKey.get(semanticKey);
    },
    async claimCommands(workerId, limit) {
      const now = Date.now();
      const ready = [...commands.values()]
        .filter((row) => row.status === "queued" && row.nextAttemptAt.getTime() <= now)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit);
      for (const row of ready) {
        row.status = "in_flight";
        row.claimedBy = workerId;
        row.attemptCount += 1;
      }
      return ready;
    },
    async completeCommand(commandId, status, patch: CommandPatch) {
      const row = commands.get(commandId);
      if (!row) return;
      row.status = status;
      if (patch.result !== undefined) row.result = patch.result;
      if (patch.providerReceipt !== undefined) row.providerReceipt = patch.providerReceipt;
      if (patch.errorCode !== undefined) row.errorCode = patch.errorCode;
      if (patch.errorDetail !== undefined) row.errorDetail = patch.errorDetail;
      if (patch.nextAttemptAt !== undefined) row.nextAttemptAt = patch.nextAttemptAt;
      if (patch.providerKey !== undefined) row.providerKey = patch.providerKey;
      row.claimedBy = patch.claimedBy === undefined ? undefined : (patch.claimedBy ?? undefined);
    },
    async commandStats(sourceId) {
      const rows = [...commands.values()].filter((row) => row.sourceId === sourceId);
      return {
        queued: rows.filter((row) => row.status === "queued").length,
        inFlight: rows.filter((row) => row.status === "in_flight").length,
        ambiguous: rows.filter((row) => row.status === "ambiguous").length,
      };
    },

    /* ------------------------------ resources ---------------------------- */
    async upsertResource(sourceId, kind: ResourceKind, resourceId, data, opts) {
      const key = `${sourceId}${kind}${resourceId}`;
      const existing = resources.get(key);
      if (existing && opts?.expectedRevision !== undefined && existing.revision !== opts.expectedRevision)
        return;
      resources.set(key, {
        sourceId,
        kind,
        resourceId,
        data: { ...data },
        revision: (existing?.revision ?? 0) + 1,
        tombstone: opts?.tombstone ?? false,
        updatedAt: new Date(),
      });
    },
    async getResource(sourceId, kind, resourceId) {
      return resources.get(`${sourceId}${kind}${resourceId}`);
    },

    /* ------------------------------ artifacts ---------------------------- */
    async putArtifact(input: ArtifactInsert) {
      const artifactId = `art:${createHash("sha256").update(JSON.stringify([input.sourceId, input.chatGuid, artifacts.size])).digest("hex")}`;
      artifacts.set(artifactId, {
        ...input,
        artifactId,
        byteSize: input.data.byteLength,
        createdAt: new Date(),
      });
      return artifactId;
    },
    async getArtifact(artifactId) {
      return artifacts.get(artifactId);
    },

    /* -------------------------- pending interactions --------------------- */
    async createInteraction(input: InteractionInsert) {
      const interactionId = `int:${sha256Hex(JSON.stringify([input.sourceId, input.chatGuid, input.requestRef, input.kind]))}`;
      if (interactions.has(interactionId)) return interactionId;
      interactions.set(interactionId, {
        ...input,
        interactionId,
        status: "pending",
        createdAt: new Date(),
      });
      return interactionId;
    },
    async openInteractions(sourceId, chatGuid) {
      return [...interactions.values()]
        .filter((row) => row.sourceId === sourceId && row.chatGuid === chatGuid && row.status === "pending")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async resolveInteraction(interactionId, actor, resolution) {
      const row = interactions.get(interactionId);
      if (!row || row.status !== "pending") return false;
      row.status = "resolved";
      row.resolvedActor = actor;
      row.resolvedAt = new Date();
      row.resolution = { ...resolution };
      return true;
    },
    async expireInteractions(now) {
      let count = 0;
      for (const row of interactions.values()) {
        if (row.status === "pending" && row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
          row.status = "expired";
          count += 1;
        }
      }
      return count;
    },

    /* --------------------------- projector offsets ------------------------ */
    async getProjectorOffset(sourceId, eveSessionId) {
      return projectors.get(`${sourceId}${eveSessionId}`);
    },
    async advanceProjector(input) {
      const key = `${input.sourceId}${input.eveSessionId}`;
      const existing = projectors.get(key);
      projectors.set(key, {
        ...input,
        streamPosition: existing ? Math.max(existing.streamPosition, input.streamPosition) : input.streamPosition,
        materializedKeys: [...input.materializedKeys],
        updatedAt: new Date(),
      });
    },

    /* --------------------------- session deadlines ------------------------ */
    async registerDeadline(eveSessionId, bindingId, deadlineAt) {
      if (deadlines.has(eveSessionId)) return;
      deadlines.set(eveSessionId, { eveSessionId, bindingId, deadlineAt });
    },
    async dueDeadlines(now, limit) {
      return [...deadlines.values()]
        .filter((row) => !row.retiredAt && row.deadlineAt.getTime() <= now.getTime())
        .sort((a, b) => a.deadlineAt.getTime() - b.deadlineAt.getTime())
        .slice(0, limit);
    },
    async markDeadlineRetired(eveSessionId, reason) {
      const row = deadlines.get(eveSessionId);
      if (row && !row.retiredAt) {
        row.retiredAt = new Date();
        row.retirementReason = reason;
      }
    },
    async getDeadline(eveSessionId) {
      return deadlines.get(eveSessionId);
    },
  };

  return Object.assign(db, { inbox, intents, commands, conversations, sources, interactions, deadlines });
}
