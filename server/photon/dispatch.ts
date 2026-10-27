import { randomUUID } from "node:crypto";

import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { z } from "zod";

import {
  PHOTON_DISPATCH_PATH,
  PHOTON_RETIRE_PATH,
  type PhotonConfig,
} from "./config.js";
import {
  dispatchResultSchema,
  type PhotonDispatchResult,
  type PhotonEventEnvelope,
} from "./contracts.js";
import {
  bindingIdFor,
  dispatchKeyFor,
  eveAddressFor,
  handleKey,
  intentIdFor,
  normalizeHandle,
  parseActorKey,
  photonPrincipalId,
  sha256Hex,
} from "./identity.js";
import { matchInboundToInteractions } from "./interactions.js";
import {
  admitGroup,
  admitSender,
  applyMembershipDelta,
  classifyScope,
  groupActorAuthorized,
  toConversationState,
} from "./policy.js";
import type { ConversationRow, InboxRow, IntentRow, PhotonDb } from "./store.js";
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

export interface DispatcherDeps {
  readonly store: PhotonDb;
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
      // A rejected credential means our call never reached the route's
      // contract — that is a transport failure, not a content rejection.
      if (response.status === 401 || response.status === 403)
        return { kind: "retryable", reason: `internal route auth failed (${response.status})` };
      // 5xx and rate limits are retryable; other 4xx are durable rejections.
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable)
        return { kind: "ok", result: { status: "rejected", reason: `internal_route_${response.status}` } };
      return { kind: "retryable", reason: `internal route returned ${response.status}` };
    }
    const parsed = dispatchResultSchema.safeParse(JSON.parse(text || "{}"));
    if (!parsed.success) return { kind: "retryable", reason: "internal route returned an unreadable result" };
    return { kind: "ok", result: parsed.data };
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
    // session state can never alias the new conversation. Scope classifies
    // the chat, not the retired generation — the prior row still counts as
    // group evidence for the rebinding.
    const scope = classifyScope(config, existing, chatGuid);
    const generation = (existing?.generation ?? 0) + 1;
    const bindingId = bindingIdFor(sourceId, chatGuid, generation);
    const handle = parseActorKey(envelope.actor);
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
    if (!binding) return;
    const next = applyMembershipDelta(binding.membership, envelope.event);
    if (next) await store.updateMembership(binding.bindingId, next);
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
    const scope = classifyScope(config, binding, chatGuid);
    const handle = parseActorKey(row.actor);
    if (scope === "group") {
      if (!admitGroup(config, chatGuid)) return "group_not_admitted";
      const state = toConversationState(binding, "group")!;
      if (!groupActorAuthorized(state, handle)) return "actor_not_in_membership";
    } else if (!admitSender(config, handle)) {
      // Allowlists are re-checked at delivery time: config may have
      // narrowed since the event was admitted.
      return "sender_not_allowed";
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
        // The failed attempt is recorded on the inbox row too so delivery
        // telemetry survives between the row's captured and settled states.
        if (row) await store.markInboxProcessing(row, "captured", outcome.reason);
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
        // The failed attempt is recorded on the inbox row too so delivery
        // telemetry survives between the row's captured and settled states.
        if (row) await store.markInboxProcessing(row, "captured", result.reason);
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
        intentId: intentIdFor(dispatchKey),
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
    const boundary = await store.activationBoundary(sourceId);
    // Chat scopes (null = chat-less state rows) with any dispatchable row.
    // Rows inside one scope keep provider sequence order; the scopes
    // themselves are independent, so they run in parallel — a stalled chat
    // (one postInternal can burn a 15s timeout) never blocks the others.
    const scopes = await store.dispatchableChatScopes(sourceId, deps.batchSize);
    const perScope = await Promise.all(scopes.map(async (chatGuid) => {
      let settled = 0;
      try {
        for (const row of await store.dispatchableForChat(sourceId, chatGuid, deps.batchSize)) {
          if (await processRow(row, boundary)) settled++;
          else break; // undelivered head preserves this chat's ordering
        }
      } catch (error) {
        log({
          level: "error", msg: "photon_dispatch_chat_failed", chatGuid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return settled;
    }));
    // Retry deliveries whose intents outlived a crashed attempt — the same
    // independent-work shape, so the same bounded-parallel structure.
    const retried = await Promise.all(
      (await store.pendingIntents(sourceId, deps.batchSize)).map(async (intent) => {
        try {
          const row = await store.getInboxRow(intent);
          const outcome = await deliverIntent(intent);
          return await settleIntent(intent, outcome, row);
        } catch (error) {
          log({
            level: "error", msg: "photon_intent_retry_failed", intentId: intent.intentId,
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      }),
    );
    return perScope.reduce((total, n) => total + n, 0)
      + retried.filter(Boolean).length;
  }

  return { runOnce };
}

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
    if (!response.ok) {
      // A non-success status means the session was NOT retired — a rejected
      // credential (401/403) or other 4xx must keep the deadline open so a
      // misconfiguration alarms through retries instead of silently
      // dropping the deadline while the session keeps living.
      console.error(JSON.stringify({
        event: "photon.retire_rejected", eveSessionId, status: response.status,
      }));
      return "retryable";
    }
    const parsed = z.object({ status: z.enum(["retired", "already_retired", "retryable"]) })
      .safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data.status : "retryable";
  } catch (error) {
    // Same alarm story as a rejected call: the deadline stays open and every
    // sweep logs — a permanently failing route surfaces instead of silently
    // leaking the session.
    console.error(JSON.stringify({
      event: "photon.retire_failed",
      eveSessionId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return "retryable";
  }
}

/**
 * Bounded retirement sweep: every due deadline goes through the private
 * retire route (never a bare cancellation), then the deadline and its
 * binding are marked retired. Retirements are independent — they run in
 * parallel within the batch so one hung route cannot serialize the sweep's
 * timeout budget. Retryable route outcomes leave the deadline open for the
 * next sweep.
 */
export async function retireDueSessions(
  db: PhotonDb,
  config: PhotonConfig,
  options?: { fetch?: typeof fetch; now?: () => Date; batchSize?: number },
): Promise<{ retired: number; retried: number }> {
  const fetcher = options?.fetch ?? fetch;
  const now = options?.now ?? (() => new Date());
  const batchSize = options?.batchSize ?? 64;
  const outcomes = await Promise.all(
    (await db.dueDeadlines(now(), batchSize)).map(async (deadline) => {
      const result = await retireViaInternalRoute(
        config, deadline.eveSessionId, "absolute_deadline", fetcher,
      );
      if (result === "retryable") return false;
      await db.markDeadlineRetired(deadline.eveSessionId, "absolute_deadline");
      if (deadline.bindingId) await db.retireConversation(deadline.bindingId);
      return true;
    }),
  );
  const retired = outcomes.filter(Boolean).length;
  return { retired, retried: outcomes.length - retired };
}
