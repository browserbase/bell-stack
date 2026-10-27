import { randomUUID } from "node:crypto";

import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { z } from "zod";

import {
  PHOTON_DISPATCH_PATH,
  PHOTON_RETIRE_PATH,
  type PhotonConfig,
} from "./config.js";
import type { PhotonDispatchResult, PhotonEventEnvelope } from "./contracts.js";
import {
  bindingIdFor,
  dispatchKeyFor,
  eveAddressFor,
  handleKey,
  normalizeHandle,
  photonPrincipalId,
  sha256Hex,
} from "./identity.js";
import { matchInboundToInteractions } from "./interactions.js";
import { admitGroup, admitSender, groupActorAuthorized, type ConversationState } from "./policy.js";
import type { ConversationRow, InboxRow, IntentRow, PhotonStore } from "./store.js";
import { stableJson } from "./normalize.js";

/**
 * Inbox -> Eve bridge. Admitted rows dispatch in per-chat sequence order to
 * the fixed internal route; state-only rows apply membership/interaction
 * side effects and never open an agent turn. Every attempted delivery is a
 * durable intent so a crash mid-request resumes without duplicating.
 */

/** Bell's maximum conversation lifetime preserved from the Linq channel. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Deliveries that keep failing quarantine instead of spinning forever. */
const MAX_INTENT_ATTEMPTS = 12;

const dispatchResultSchema = z.object({
  status: z.enum(["dispatched", "duplicate", "state_applied", "rejected", "retryable"]),
  sessionId: z.string().optional(),
  deliveryId: z.string().optional(),
  reason: z.string().optional(),
}).strict();

export interface DispatcherDeps {
  readonly store: PhotonStore;
  readonly config: PhotonConfig;
  readonly sourceId: string;
  readonly logEpoch: string;
  /** Optional SDK client used to prime group membership at binding time. */
  readonly client?: AdvancedIMessage;
  readonly fetcher?: typeof fetch;
  readonly batchSize: number;
  readonly log?: (entry: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

export interface PhotonDispatcher {
  /** One scan/deliver round; returns rows that reached a terminal state. */
  runOnce(): Promise<number>;
}

interface PostOutcome {
  readonly kind: "ok" | "retryable";
  readonly result?: PhotonDispatchResult;
  readonly reason?: string;
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

export function createDispatcher(deps: DispatcherDeps): PhotonDispatcher {
  const { store, config, sourceId, logEpoch } = deps;
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);

  /* ---------------------------------------------------------------- */
  /* Internal route POST                                               */
  /* ---------------------------------------------------------------- */

  async function postInternal(path: string, body: unknown): Promise<PostOutcome> {
    let response: Response;
    try {
      response = await fetcher(`${config.internalOrigin}${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${config.internalSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return { kind: "retryable", reason: error instanceof Error ? error.message : String(error) };
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      // 5xx and rate limits are retryable; a 4xx is a durable rejection.
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable)
        return { kind: "ok", result: { status: "rejected", reason: `internal_route_${response.status}` } };
      return { kind: "retryable", reason: `internal route returned ${response.status}` };
    }
    const parsed = dispatchResultSchema.safeParse(JSON.parse(text || "{}"));
    if (!parsed.success) return { kind: "retryable", reason: "internal route returned an unreadable result" };
    const { status, sessionId, deliveryId, reason } = parsed.data;
    return {
      kind: "ok",
      result: status === "dispatched"
        ? { status, sessionId: sessionId ?? "", deliveryId }
        : status === "duplicate"
          ? { status, sessionId, deliveryId }
          : status === "rejected" || status === "retryable"
            ? { status, reason: reason ?? status }
            : { status },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Conversation binding                                              */
  /* ---------------------------------------------------------------- */

  /** Best-effort membership snapshot when a group binding is created. */
  async function primeGroupMembership(chatGuid: string): Promise<string[]> {
    if (!deps.client) return [];
    try {
      const chat = await deps.client.chats.get(chatGuid);
      const keys: string[] = [];
      for (const participant of chat.participants) {
        const handle = normalizeHandle(participant.address);
        if (handle) keys.push(handleKey(handle));
      }
      return keys;
    } catch {
      return [];
    }
  }

  async function ensureBinding(
    envelope: PhotonEventEnvelope,
    existing: ConversationRow | undefined,
  ): Promise<ConversationRow | undefined> {
    const chatGuid = envelope.chatGuid;
    if (!chatGuid) return undefined;
    if (existing && !existing.retiredAt) return existing;
    // A retired binding's next inbound starts a fresh generation so stale
    // session state can never alias the new conversation.
    const scope = admitGroup(config, chatGuid) ? "group" : "direct";
    const generation = (existing?.generation ?? 0) + 1;
    const bindingId = bindingIdFor(sourceId, chatGuid, generation);
    const handle = normalizeHandle(envelope.actor?.slice(envelope.actor.indexOf(":") + 1));
    const initiatingPrincipal = handle ? photonPrincipalId(config.projectId, handle) : undefined;
    const membership = scope === "group" ? await primeGroupMembership(chatGuid) : [];
    return store.upsertConversation({
      bindingId, sourceId, chatGuid, generation, scope,
      eveAddress: eveAddressFor(bindingId),
      initiatingPrincipal,
      membership,
    });
  }

  /** Membership side effects for group state events, in sequence order. */
  async function applyMembership(
    envelope: PhotonEventEnvelope,
    binding: ConversationRow | undefined,
  ): Promise<void> {
    const event = envelope.event;
    if (!binding || event.family !== "group") return;
    if (event.type !== "participantAdded" && event.type !== "participantRemoved" && event.type !== "participantLeft")
      return;
    const handle = normalizeHandle(event.participant.address);
    if (!handle) return;
    const key = handleKey(handle);
    const membership = new Set(binding.membership);
    if (event.type === "participantAdded") membership.add(key);
    else membership.delete(key);
    await store.updateMembership(binding.bindingId, [...membership]);
  }

  /* ---------------------------------------------------------------- */
  /* Row processing                                                    */
  /* ---------------------------------------------------------------- */

  async function quarantine(row: InboxRow, reason: string): Promise<void> {
    await store.updateDisposition(row, "quarantined", reason);
    await store.markInboxProcessing(row, "quarantined", reason);
    log({ level: "warn", msg: "photon_inbox_quarantined", sequence: row.sequence, reason });
  }

  /**
   * Re-verifies authorization at dispatch time. Admission ran at capture;
   * membership can change between the two, and a retired binding must never
   * deliver again.
   */
  function dispatchGate(
    row: InboxRow,
    binding: ConversationRow | undefined,
  ): string | undefined {
    const chatGuid = row.chatGuid;
    if (!chatGuid) return undefined;
    if (binding?.retiredAt) return "conversation_retired";
    const scope = binding?.scope ?? (admitGroup(config, chatGuid) ? "group" : "direct");
    if (scope === "group") {
      if (!admitGroup(config, chatGuid)) return "group_not_admitted";
      const handle = normalizeHandle(row.actor?.slice(row.actor.indexOf(":") + 1));
      const state = toConversationState(binding) ?? {
        scope: "group" as const, generation: 1, membership: [], membershipVersion: 0,
      };
      if (!groupActorAuthorized(state, handle)) return "actor_not_in_membership";
    } else {
      // Allowlists are re-checked at delivery time: config may have
      // narrowed since the event was admitted.
      const handle = normalizeHandle(row.actor?.slice(row.actor.indexOf(":") + 1));
      if (!admitSender(config, handle)) return "sender_not_allowed";
    }
    return undefined;
  }

  function intentAction(stateOnly: boolean, contractResolved: boolean): IntentRow["action"] {
    // A resolved durable contract is an input resolution for Eve regardless
    // of how the event otherwise classifies.
    if (contractResolved) return "respond";
    return stateOnly ? "state_apply" : "send";
  }

  async function deliverIntent(intent: IntentRow): Promise<PostOutcome> {
    return postInternal(PHOTON_DISPATCH_PATH, {
      inboxId: { sourceId: intent.sourceId, logEpoch: intent.logEpoch, sequence: intent.sequence },
      correlationId: randomUUID(),
    });
  }

  async function settleIntent(intent: IntentRow, outcome: PostOutcome, row?: InboxRow): Promise<boolean> {
    if (outcome.kind === "retryable") {
      if (intent.attempts + 1 >= MAX_INTENT_ATTEMPTS) {
        await store.updateIntent(intent.intentId, { status: "ambiguous", lastError: outcome.reason });
        if (row) await store.markInboxProcessing(row, "failed", "delivery exhausted; outcome ambiguous");
      } else {
        await store.updateIntent(intent.intentId, { lastError: outcome.reason });
      }
      return false;
    }
    const result = outcome.result;
    if (!result) return false;
    switch (result.status) {
      case "dispatched":
      case "duplicate": {
        const patch = {
          status: "accepted" as const,
          eveSessionId: "sessionId" in result ? result.sessionId : undefined,
          deliveryId: result.deliveryId,
        };
        await store.updateIntent(intent.intentId, patch);
        if (result.status === "dispatched" && result.sessionId) {
          const binding = row?.chatGuid
            ? await store.getConversation(sourceId, row.chatGuid)
            : undefined;
          if (binding && binding.eveSessionId !== result.sessionId) {
            await store.bindEveSession(binding.bindingId, result.sessionId);
            await store.registerDeadline(
              result.sessionId, binding.bindingId, new Date(now().getTime() + SESSION_TTL_MS),
            );
          }
          if (binding) await store.touchConversation(binding.bindingId);
        }
        if (row) await store.markInboxProcessing(row, "dispatched");
        return true;
      }
      case "state_applied":
        await store.updateIntent(intent.intentId, { status: "accepted" });
        if (row) await store.markInboxProcessing(row, "settled");
        return true;
      case "rejected":
        await store.updateIntent(intent.intentId, { status: "rejected", lastError: result.reason });
        if (row) await quarantine(row, result.reason ?? "rejected");
        return true;
      case "retryable":
        await store.updateIntent(intent.intentId, { lastError: result.reason });
        return false;
    }
  }

  /** Replay below the activation boundary hydrates state, never replies. */
  function belowActivationBoundary(row: InboxRow, boundary: string | undefined): boolean {
    if (boundary === undefined) return false;
    try {
      return BigInt(row.sequenceNum) <= BigInt(boundary);
    } catch {
      return false;
    }
  }

  async function processRow(row: InboxRow, boundary: string | undefined): Promise<boolean> {
    const envelope = row.envelope;
    // Admitted rows replayed from before the activation boundary downgrade
    // to state-only: they hydrate bindings and membership but must never
    // open a fresh agent turn.
    const stateOnly = row.disposition === "state_only"
      || (row.disposition === "admitted" && belowActivationBoundary(row, boundary));
    // A state-only row with no envelope (location update, denied-adjacent
    // tombstone) still settles: its durable record is already the state.
    if (stateOnly && !envelope) {
      await store.markInboxProcessing(row, "settled", "no_envelope");
      return true;
    }
    if (!envelope) {
      await quarantine(row, "missing_envelope");
      return true;
    }

    const existing = row.chatGuid
      ? await store.getConversation(sourceId, row.chatGuid)
      : undefined;
    const binding = row.disposition === "admitted"
      ? await ensureBinding(envelope, existing)
      : existing;

    if (stateOnly) {
      await applyMembership(envelope, binding ?? existing);
    } else {
      const gated = dispatchGate(row, binding);
      if (gated) {
        await quarantine(row, gated);
        return true;
      }
    }

    const matched = await matchInboundToInteractions(
      store, sourceId, envelope, toConversationState(binding ?? existing),
    );
    const action = intentAction(stateOnly, matched.contractResolved);
    const dispatchKey = dispatchKeyFor(sourceId, logEpoch, row.sequence, action);
    const inputDigest = sha256Hex(stableJson([action, row.payloadHash, binding?.bindingId ?? null]));
    const intent = (await store.getIntentByKey(dispatchKey))
      ?? await store.upsertIntent({
        intentId: `intent:${sha256Hex(dispatchKey).slice(0, 48)}`,
        sourceId, logEpoch, sequence: row.sequence, action,
        eveSessionId: binding?.eveSessionId,
        dispatchKey, inputDigest,
      });
    if (intent.status !== "pending") {
      // A settled intent means a previous delivery attempt already reached
      // a terminal state — the row just follows it.
      if (intent.status === "accepted")
        await store.markInboxProcessing(row, action === "state_apply" ? "settled" : "dispatched");
      else await quarantine(row, `intent_${intent.status}`);
      return true;
    }
    const outcome = await deliverIntent(intent);
    return settleIntent(intent, outcome, row);
  }

  /* ---------------------------------------------------------------- */

  async function runOnce(): Promise<number> {
    let settled = 0;
    const boundary = await store.activationBoundary(sourceId);
    // Distinct chat scopes with any dispatchable row; per-chat queues keep
    // admitted and state-only events in provider sequence order while a
    // stalled chat never blocks an independent one.
    for (const chatGuid of await pendingChatScopes()) {
      try {
        for (const row of await pendingRowsForChat(chatGuid)) {
          if (await processRow(row, boundary)) settled++;
          else break; // undelivered head preserves this chat's ordering
        }
      } catch (error) {
        log({
          level: "error", msg: "photon_dispatch_chat_failed", chatGuid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Retry deliveries whose intents outlived a crashed attempt.
    for (const intent of await store.pendingIntents(sourceId, deps.batchSize)) {
      try {
        const row = await store.getInboxRow(intent);
        const outcome = await deliverIntent(intent);
        if (await settleIntent(intent, outcome, row)) settled++;
      } catch (error) {
        log({
          level: "error", msg: "photon_intent_retry_failed", intentId: intent.intentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return settled;
  }

  /** Chat scopes ("" = no chat) holding any captured dispatchable row. */
  async function pendingChatScopes(): Promise<string[]> {
    const result = await store.pool.query<{ chat_guid: string | null }>(
      `SELECT DISTINCT chat_guid FROM bell_photon_inbox
       WHERE source_id = $1
         AND disposition IN ('admitted', 'state_only') AND processing_state = 'captured'
       ORDER BY chat_guid NULLS LAST LIMIT $2`,
      [sourceId, deps.batchSize],
    );
    return result.rows.map((row) => row.chat_guid ?? "");
  }

  /** Per-chat pending rows of both dispatchable dispositions, in order. */
  async function pendingRowsForChat(chatGuid: string): Promise<InboxRow[]> {
    const result = chatGuid === ""
      ? await store.pool.query(
        `SELECT * FROM bell_photon_inbox
         WHERE source_id = $1 AND chat_guid IS NULL
           AND disposition = 'state_only' AND processing_state = 'captured'
         ORDER BY sequence_num ASC LIMIT $2`,
        [sourceId, deps.batchSize],
      )
      : await store.pool.query(
        `SELECT * FROM bell_photon_inbox
         WHERE source_id = $1 AND chat_guid = $2
           AND disposition IN ('admitted', 'state_only') AND processing_state = 'captured'
         ORDER BY sequence_num ASC LIMIT $3`,
        [sourceId, chatGuid, deps.batchSize],
      );
    return result.rows.map(mapRow);
  }

  return { runOnce };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapRow(row: any): InboxRow {
  return {
    sourceId: row.source_id, logEpoch: row.log_epoch, sequence: row.sequence,
    sequenceNum: String(row.sequence_num), payloadHash: row.payload_hash,
    envelope: row.envelope ?? undefined, tombstone: row.tombstone,
    eventFamily: row.event_family ?? undefined, eventType: row.event_type ?? undefined,
    chatGuid: row.chat_guid ?? undefined, actor: row.actor ?? undefined,
    targetGuid: row.target_guid ?? undefined, isFromMe: row.is_from_me ?? undefined,
    occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : undefined,
    receivedAt: new Date(row.received_at).toISOString(),
    sourceKind: row.source_kind, disposition: row.disposition,
    processingState: row.processing_state, attempts: row.attempts,
    lastError: row.last_error ?? undefined,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Retire one due Eve session via the internal route; used by the deadline sweep. */
export async function retireViaInternalRoute(
  config: PhotonConfig,
  eveSessionId: string,
  reason: string,
  fetcher: typeof fetch = fetch,
): Promise<"retired" | "already_retired" | "retryable"> {
  try {
    const response = await fetcher(`${config.internalOrigin}${PHOTON_RETIRE_PATH}`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${config.internalSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ eveSessionId, reason }),
    });
    if (!response.ok)
      return response.status === 408 || response.status === 429 || response.status >= 500 ? "retryable" : "retired";
    const parsed = z.object({ status: z.enum(["retired", "already_retired", "retryable"]) })
      .safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data.status : "retryable";
  } catch {
    return "retryable";
  }
}
