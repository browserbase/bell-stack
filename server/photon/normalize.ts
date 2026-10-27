import type {
  CatchUpEvent,
  LiveEvent,
  Message,
  MessageReaction,
  SharedFriendLocationUpdated,
  SingleServiceAddressInfo,
  StickerPlacement,
} from "@photon-ai/advanced-imessage/grpc";

import {
  ENVELOPE_VERSION,
  type PhotonEventEnvelope,
  type PhotonNormalizedEvent,
} from "./contracts.js";
import { handleKey, normalizeHandle, sha256Hex } from "./identity.js";

/**
 * Exhaustive mapping of the pinned SDK's typed events into Bell's versioned
 * normalized union. Pure functions only — persistence lives in events.ts.
 *
 * Unknown or future variants return `null` so the transport can persist a
 * sequence tombstone instead of losing coverage. Structurally invalid input
 * (including a non-safe-integer provider sequence) raises NormalizationError
 * so ingestion fails closed rather than truncating losslessly-stored data.
 */
export class NormalizationError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`Photon event normalization failed: ${detail}`);
    this.name = "NormalizationError";
    this.detail = detail;
  }
}

/** Provider sequences must remain exact; an unsafe number is a hard failure. */
function providerSequence(value: unknown, field = "sequence"): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new NormalizationError(`${field} is not a safe nonnegative integer (${String(value)}).`);
  return String(value);
}

function isoOf(value: unknown, field: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new NormalizationError(`${field} is not a valid Date (${String(value)}).`);
  return value.toISOString();
}

function optionalIso(value: unknown): string | undefined {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined;
}

function actorKeyOf(actor: SingleServiceAddressInfo | undefined): string | undefined {
  const handle = normalizeHandle(actor?.address);
  return handle ? handleKey(handle) : undefined;
}

function requireField<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined) throw new NormalizationError(`missing ${field}.`);
  return value;
}

interface EventContextLike {
  readonly actor?: SingleServiceAddressInfo;
  readonly chatGuid: string;
  readonly isFromMe: boolean;
  readonly occurredAt: Date;
}

function envelope(
  ctx: EventContextLike | undefined,
  sequence: string,
  event: PhotonNormalizedEvent,
  sourceKind: "live" | "catchup",
  receivedAt: string,
): PhotonEventEnvelope {
  return {
    version: ENVELOPE_VERSION,
    sequence,
    chatGuid: ctx?.chatGuid,
    isFromMe: ctx?.isFromMe,
    occurredAt: optionalIso(ctx?.occurredAt),
    receivedAt,
    sourceKind,
    actor: actorKeyOf(ctx?.actor),
    event,
  };
}

const CHAT_EVENT_TYPES = new Set([
  "backgroundChanged", "backgroundRemoved", "markedRead", "archived", "unarchived",
]);

function isLocationUpdate(raw: unknown): raw is SharedFriendLocationUpdated {
  return typeof raw === "object" && raw !== null
    && "sourceSequence" in raw && "location" in raw && !("type" in raw);
}

/**
 * Maps one SDK event to a normalized envelope. `SharedFriendLocationUpdated`
 * (locations.watch) lives outside the durable log: its sequence is the
 * separate watch `sourceSequence` namespaced `loc:` so it can never collide
 * with durable-log sequences in the inbox primary key.
 */
export function normalizeLiveEvent(
  raw: LiveEvent | CatchUpEvent | SharedFriendLocationUpdated,
  sourceKind: "live" | "catchup",
  receivedAt: string,
): PhotonEventEnvelope | null {
  if (isLocationUpdate(raw)) {
    const sourceSequence = providerSequence(raw.sourceSequence, "sourceSequence");
    return envelope(undefined, `loc:${sourceSequence}`, {
      family: "location",
      type: "updated",
      location: raw.location,
      sourceSequence,
    }, sourceKind, receivedAt);
  }

  const typed = raw as LiveEvent | CatchUpEvent;
  if (typeof typed !== "object" || typed === null || typeof typed.type !== "string") return null;

  if (typed.type === "catchup.complete") {
    return envelope(undefined, providerSequence(typed.headSequence, "headSequence"), {
      family: "catchup",
      type: "complete",
      headSequence: providerSequence(typed.headSequence, "headSequence"),
    }, sourceKind, receivedAt);
  }

  const ctx = typed as unknown as EventContextLike & { readonly type: string; readonly sequence: number };
  const sequence = providerSequence(ctx.sequence);
  requireField(ctx.chatGuid, "chatGuid");

  if (ctx.type.startsWith("message.")) {
    const subtype = ctx.type.slice("message.".length);
    const event = messageEvent(ctx, subtype);
    return event === null ? null : envelope(ctx, sequence, event, sourceKind, receivedAt);
  }
  if (ctx.type.startsWith("chat.")) {
    const subtype = ctx.type.slice("chat.".length);
    if (!CHAT_EVENT_TYPES.has(subtype)) return null;
    return envelope(ctx, sequence, {
      family: "chat", type: subtype,
    } as PhotonNormalizedEvent, sourceKind, receivedAt);
  }
  if (ctx.type === "group.changed") {
    const change = (ctx as { change?: { type: string } }).change;
    const event = groupEvent(change);
    return event === null ? null : envelope(ctx, sequence, event, sourceKind, receivedAt);
  }
  if (ctx.type === "poll.changed") {
    const event = pollEvent(ctx);
    return event === null ? null : envelope(ctx, sequence, event, sourceKind, receivedAt);
  }
  return null;
}

function messageEvent(
  ctx: EventContextLike & { readonly type: string },
  subtype: string,
): PhotonNormalizedEvent | null {
  const raw = ctx as unknown as Record<string, unknown>;
  switch (subtype) {
    case "received":
      return {
        family: "message", type: "received",
        message: requireField(raw.message, "message") as Message,
      };
    case "edited":
      return {
        family: "message", type: "edited",
        messageGuid: requireField(raw.messageGuid, "messageGuid") as string,
        content: raw.content as Message["content"],
        editedAt: isoOf(raw.editedAt, "editedAt"),
      };
    case "read":
      return {
        family: "message", type: "read",
        messageGuid: requireField(raw.messageGuid, "messageGuid") as string,
        readAt: isoOf(raw.readAt, "readAt"),
      };
    case "unsent":
      return {
        family: "message", type: "unsent",
        messageGuid: requireField(raw.messageGuid, "messageGuid") as string,
        retractedAt: isoOf(raw.retractedAt, "retractedAt"),
      };
    case "reactionAdded":
    case "reactionRemoved":
      return {
        family: "message", type: subtype,
        messageGuid: requireField(raw.messageGuid, "messageGuid") as string,
        reaction: requireField(raw.reaction, "reaction") as MessageReaction,
        targetPartIndex: raw.targetPartIndex as number | undefined,
      };
    case "stickerPlaced":
      return {
        family: "message", type: "stickerPlaced",
        messageGuid: requireField(raw.messageGuid, "messageGuid") as string,
        sticker: raw.sticker as Message["placedStickers"][number]["sticker"],
        placement: raw.placement as StickerPlacement | undefined,
        targetPartIndex: raw.targetPartIndex as number | undefined,
      };
    default:
      return null;
  }
}

function groupEvent(change: { type: string } | undefined): PhotonNormalizedEvent | null {
  if (!change || typeof change.type !== "string") return null;
  switch (change.type) {
    case "displayNameChanged":
      return {
        family: "group", type: "displayNameChanged",
        displayName: (change as { displayName?: string }).displayName ?? "",
      };
    case "participantAdded":
    case "participantRemoved":
    case "participantLeft": {
      const participant = (change as { participant?: SingleServiceAddressInfo }).participant;
      if (!participant) throw new NormalizationError(`group.${change.type} missing participant.`);
      return { family: "group", type: change.type, participant };
    }
    case "iconChanged":
    case "iconRemoved":
      return { family: "group", type: change.type };
    default:
      return null;
  }
}

function pollEvent(ctx: EventContextLike & { readonly type: string }): PhotonNormalizedEvent | null {
  const raw = ctx as unknown as { pollMessageGuid?: string; delta?: { type: string } };
  const delta = requireField(raw.delta, "delta");
  const pollMessageGuid = requireField(raw.pollMessageGuid, "pollMessageGuid");
  switch (delta.type) {
    case "created":
    case "optionAdded":
    case "voted":
    case "unvoted":
      return {
        family: "poll", type: delta.type, pollMessageGuid, delta,
      } as PhotonNormalizedEvent;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Canonical payload hashing                                            */
/* ------------------------------------------------------------------ */

/**
 * Deterministic JSON serialization: object keys sorted, Date -> ISO,
 * Uint8Array -> tagged base64, undefined object members dropped. Used for
 * the inbox integrity hash so the same provider payload always hashes
 * identically regardless of transport source or receipt metadata. (This is
 * the deep serializer; identity.ts's `canonicalTupleJson` is the shallow
 * identity-tuple form.)
 */
export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value instanceof Uint8Array)
    return `{"$bytes":"${Buffer.from(value).toString("base64")}"}`;
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha256 of the canonical provider event payload — family, type, context
 * identifiers and the full normalized event. Bell's live/catch-up label,
 * receipt timestamp, lease and normalization metadata are deliberately
 * excluded so the same provider event hashes identically on live delivery
 * and replay (per PRD §7.2).
 */
export function computePayloadHash(envelope: PhotonEventEnvelope): string {
  return sha256Hex(stableJson([
    envelope.version,
    envelope.event.family,
    envelope.event.type,
    envelope.chatGuid ?? null,
    envelope.actor ?? null,
    envelope.isFromMe ?? null,
    envelope.occurredAt ?? null,
    envelope.event,
  ]));
}

/** Native target identifier for inbox indexing and ordering diagnostics. */
export function eventTargetGuid(envelope: PhotonEventEnvelope): string | undefined {
  const event = envelope.event;
  switch (event.family) {
    case "message":
      if (event.type === "received") return event.message.guid;
      return "messageGuid" in event ? event.messageGuid : undefined;
    case "poll":
      return event.pollMessageGuid;
    default:
      return undefined;
  }
}
