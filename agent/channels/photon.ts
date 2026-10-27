import {
  defineChannel,
  GET,
  POST,
  SessionStrandedError,
  type RouteHandlerArgs,
} from "eve/channels";
import type { SessionAuthContext } from "eve/context";

import {
  loadPhotonConfig,
  PHOTON_DISPATCH_PATH,
  PHOTON_EVENTS_PATH,
  PHOTON_HEALTH_PATH,
  PHOTON_RETIRE_PATH,
  PhotonConfigError,
  type PhotonConfig,
} from "../../server/photon/config.js";
import {
  dispatchRequestSchema,
  eventsReadRequestSchema,
  retireRequestSchema,
  type PhotonDispatchResult,
  type PhotonEventEnvelope,
  type PhotonEventsReadResult,
  type PhotonHealthReport,
  type PhotonRetireResult,
} from "../../server/photon/contracts.js";
import {
  bindingIdFor,
  canonicalJson,
  dispatchKeyFor,
  eveAddressFor,
  handleKey,
  isPhotonAuth,
  normalizeHandle,
  photonPrincipalId,
  sha256Hex,
  type CanonicalHandle,
} from "../../server/photon/identity.js";
import { admitEvent, type ConversationState } from "../../server/photon/policy.js";
import {
  createPhotonStore,
  type ConversationRow,
  type InboxRow,
  type InteractionRow,
  type PhotonStore,
} from "../../server/photon/store.js";
import {
  PHOTON_ATTR_AUDIENCE,
  PHOTON_ATTR_BINDING,
  PHOTON_ATTR_CHAT,
  PHOTON_ATTR_SOURCE,
} from "../lib/messaging-auth";
import {
  describeInboundMessage,
  photonAttribute,
  photonBrowserEvents,
  photonContextStrings,
  photonDispatchAuth,
  postSessionNotice,
  verifyInternalAuth,
  type PhotonChannelContext,
} from "../lib/photon";
import { enrollDeadlineOnDispatch, isSessionExpired } from "../lib/session-lifetime";

/**
 * Bell's raw Advanced gRPC channel. All routes are private: they mount
 * verbatim on the loopback Eve origin, are never proxied through the public
 * Next origin (withEve rewrites only `/eve/v1/*`), and require the separate
 * high-entropy internal secret. Request bodies carry inbox references only —
 * identity, authorization and message content always come from the durable
 * channel store, never from payload claims.
 */

const MAX_BODY_BYTES = 16 * 1024;
const MAX_EVENTS_PER_READ = 5_000;

interface PhotonRuntime {
  readonly config: PhotonConfig;
  readonly store: PhotonStore;
}

let cachedRuntime: PhotonRuntime | undefined;

/**
 * Lazily loads config and opens the channel store. `loadPhotonConfig`
 * returns null when the channel is disabled and throws PhotonConfigError on
 * malformed configuration — both reach the route handlers, never module
 * import time, so `eve build` works without provider credentials.
 */
function photonRuntime(): PhotonRuntime | null {
  const config = loadPhotonConfig();
  if (!config) return null;
  if (cachedRuntime?.config.databaseUrl === config.databaseUrl) return cachedRuntime;
  cachedRuntime = { config, store: createPhotonStore(config.databaseUrl) };
  return cachedRuntime;
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

async function readJsonBody(req: Request): Promise<unknown | undefined> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/**
 * Shared route prelude: resolves runtime config, enforces the internal
 * bearer credential and (for JSON routes) content type and size bounds.
 * Returns the runtime, or the failure response to send immediately.
 */
function routePrelude(
  req: Request,
  options: { readonly json: boolean },
): { readonly runtime: PhotonRuntime } | { readonly response: Response } {
  let runtime: PhotonRuntime | null;
  try {
    runtime = photonRuntime();
  } catch (error) {
    if (error instanceof PhotonConfigError)
      return { response: json({ status: "retryable", reason: "photon_misconfigured" }, 503) };
    throw error;
  }
  if (!runtime) return { response: json({ status: "retryable", reason: "photon_disabled" }, 503) };
  if (!verifyInternalAuth(req, runtime.config.internalSecret))
    return { response: json({ status: "rejected", reason: "unauthorized" }, 401) };
  if (options.json) {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json"))
      return { response: json({ status: "rejected", reason: "content_type_not_json" }, 415) };
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
      return { response: json({ status: "rejected", reason: "payload_too_large" }, 413) };
  }
  return { runtime };
}

function conversationState(
  row: ConversationRow | undefined,
  scope: "direct" | "group",
): ConversationState {
  return {
    bindingId: row?.bindingId,
    scope: row?.scope ?? scope,
    generation: row?.generation ?? 1,
    membership: row?.membership ?? [],
    membershipVersion: row?.membershipVersion ?? 0,
    initiatingPrincipal: row?.initiatingPrincipal,
    retiredAt: row?.retiredAt,
  };
}

/**
 * Applies a state-only event to the local projection without starting a
 * model turn. Membership deltas apply only onto a populated baseline — an
 * empty roster means the roster was never hydrated, and applying one delta
 * there would wrongly deny the other admitted members.
 */
async function applyProjectionState(
  store: PhotonStore,
  row: InboxRow,
  envelope: PhotonEventEnvelope,
  updatesMembership: boolean,
  conversation: ConversationRow | undefined,
): Promise<void> {
  const event = envelope.event;
  const chatGuid = envelope.chatGuid ?? row.chatGuid ?? conversation?.chatGuid;
  if (event.family === "group" && chatGuid) {
    if (event.type === "displayNameChanged" || event.type === "iconChanged"
      || event.type === "iconRemoved") {
      await store.upsertResource(row.sourceId, "chat", chatGuid, {
        displayName: event.type === "displayNameChanged" ? event.displayName : undefined,
        icon: event.type === "iconChanged" ? "custom" : "none",
        sequence: envelope.sequence,
      });
    }
    if (updatesMembership && conversation && conversation.membership.length > 0
      && (event.type === "participantAdded" || event.type === "participantRemoved"
        || event.type === "participantLeft")) {
      const participant = normalizeHandle(event.participant?.address);
      if (participant) {
        const key = handleKey(participant);
        const membership = event.type === "participantAdded"
          ? [...new Set([...conversation.membership, key])]
          : conversation.membership.filter((member) => member !== key);
        await store.updateMembership(conversation.bindingId, membership);
      }
    }
  }
  if (event.family === "message" && event.type === "unsent") {
    await store.upsertResource(row.sourceId, "message", event.messageGuid,
      { retractedAt: event.retractedAt, sequence: envelope.sequence }, { tombstone: true });
  }
  if (event.family === "message" && event.type === "edited") {
    await store.upsertResource(row.sourceId, "message", event.messageGuid, {
      content: event.content, editedAt: event.editedAt, sequence: envelope.sequence,
    });
  }
  if (event.family === "poll") {
    await store.upsertResource(row.sourceId, "poll", event.pollMessageGuid, {
      type: event.type, delta: event.delta, sequence: envelope.sequence,
    });
  }
}

type InputResponseDraft =
  | { readonly requestId: string; readonly text: string }
  | { readonly requestId: string; readonly optionId: string };

interface PromptResponseMapping {
  readonly allowFreeform?: boolean;
  readonly options?: readonly { readonly id?: unknown; readonly label?: unknown }[];
}

/**
 * Maps an inbound text reply onto an open pending prompt interaction. The
 * pending row carries the Eve request id in `requestRef` and, for select
 * prompts, the presented option ids/labels in `responseMapping`. Strict
 * selects with no matching option and expired prompts are left alone —
 * their event falls through to a normal `steer` send.
 */
function mapPromptResponse(
  interaction: InteractionRow,
  text: string,
): InputResponseDraft | undefined {
  const mapping = interaction.responseMapping as PromptResponseMapping | undefined;
  const normalized = text.toLowerCase();
  for (const option of mapping?.options ?? []) {
    const id = typeof option?.id === "string" ? option.id : undefined;
    const label = typeof option?.label === "string" ? option.label : undefined;
    if (id && (normalized === id.toLowerCase() || (label !== undefined && normalized === label.toLowerCase())))
      return { requestId: interaction.requestRef, optionId: id };
  }
  if (mapping?.options?.length && mapping.allowFreeform === false) return undefined;
  return { requestId: interaction.requestRef, text };
}

async function pendingPromptResponse(
  store: PhotonStore,
  sourceId: string,
  chatGuid: string,
  actor: CanonicalHandle,
  text: string,
): Promise<{ readonly interactionId: string; readonly response: InputResponseDraft } | undefined> {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const now = Date.now();
  const actorKey = handleKey(actor);
  for (const interaction of await store.openInteractions(sourceId, chatGuid)) {
    if (interaction.kind !== "prompt") continue;
    if (interaction.permittedActor && interaction.permittedActor !== actorKey) continue;
    if (interaction.expiresAt && interaction.expiresAt.getTime() <= now) continue;
    const response = mapPromptResponse(interaction, trimmed);
    if (response) return { interactionId: interaction.interactionId, response };
  }
  return undefined;
}

function conversationTitle(scope: "direct" | "group", actor: CanonicalHandle, chatGuid: string): string {
  return scope === "group" ? `Photon group ${chatGuid}` : `Photon DM ${handleKey(actor)}`;
}

/**
 * Creates or resolves the canonical session for one continuation address.
 * When a stranded session still owns the address, it is retired first —
 * once — then creation is retried so uncertain retries never cross into a
 * replacement session unnoticed.
 */
async function createConversationSession(
  args: RouteHandlerArgs,
  eveAddress: string,
  auth: SessionAuthContext,
  title: string,
) {
  try {
    return await args.from(eveAddress).create({ auth, initiatorAuth: auth, title });
  } catch (error) {
    if (!(error instanceof SessionStrandedError)) throw error;
    await args.from(eveAddress).reset({ reason: "stranded_address_owner" });
    return await args.from(eveAddress).create({ auth, initiatorAuth: auth, title });
  }
}

/**
 * Terminally resets one bound session and marks the store's deadline and
 * conversation rows retired. `SessionStrandedError` and `no_active_session`
 * both mean the session can no longer execute — the durable rows are still
 * marked so nothing reopens it.
 */
async function retireBoundSession(
  args: RouteHandlerArgs,
  store: PhotonStore,
  eveSessionId: string,
  bindingId: string | undefined,
  reason: string,
): Promise<"reset" | "gone"> {
  let outcome: "reset" | "gone" = "gone";
  try {
    const result = await args.attachSession(eveSessionId).reset({ reason });
    outcome = result.status === "reset" ? "reset" : "gone";
  } catch (error) {
    if (!(error instanceof SessionStrandedError)) throw error;
  }
  await store.markDeadlineRetired(eveSessionId, reason);
  if (bindingId) await store.retireConversation(bindingId);
  return outcome;
}

async function handleDispatch(req: Request, args: RouteHandlerArgs): Promise<Response> {
  const gate = routePrelude(req, { json: true });
  if ("response" in gate) return gate.response;
  try {
    return await dispatchInboxRow(req, gate.runtime, args);
  } catch (error) {
    console.error("Photon dispatch route failed:", error instanceof Error ? error.message : error);
    return json({ status: "retryable", reason: "internal_error" } satisfies PhotonDispatchResult, 500);
  }
}

async function dispatchInboxRow(
  req: Request,
  runtime: PhotonRuntime,
  args: RouteHandlerArgs,
): Promise<Response> {
  const body = await readJsonBody(req);
  const parsed = body === undefined ? undefined : dispatchRequestSchema.safeParse(body);
  if (!parsed?.success)
    return json({ status: "rejected", reason: "invalid_request" } satisfies PhotonDispatchResult, 400);
  const { inboxId } = parsed.data;
  const store = runtime.store;

  const row = await store.getInboxRow(inboxId);
  if (!row || row.disposition === "pending")
    return json({ status: "rejected", reason: row ? "inbox_pending_adjudication" : "unknown_inbox" });
  if (row.tombstone || !row.envelope)
    return json({ status: "rejected", reason: "no_envelope" });
  if (row.disposition === "denied" || row.disposition === "quarantined" || row.disposition === "tombstone")
    return json({ status: "rejected", reason: `disposition_${row.disposition}` });

  const envelope = row.envelope;
  const chatGuid = envelope.chatGuid ?? row.chatGuid;
  const existing = chatGuid ? await store.getConversation(row.sourceId, chatGuid) : undefined;
  const derivedScope = chatGuid && runtime.config.allowedGroups.includes(chatGuid) ? "group" : "direct";

  // Defense in depth: admission is re-verified against current conversation
  // state even though the worker pre-adjudicated the row. A fresh denial
  // rejects; either side saying state-only applies projection state without
  // a model turn; only an admitted row on both checks dispatches.
  const decision = admitEvent(runtime.config, envelope, conversationState(existing, derivedScope));
  if (decision.disposition === "state_only" || row.disposition === "state_only") {
    await applyProjectionState(store, row, envelope, decision.updatesMembership === true, existing);
    await store.markInboxProcessing(inboxId, "settled");
    return json({ status: "state_applied" } satisfies PhotonDispatchResult);
  }
  if (decision.disposition !== "admitted")
    return json({ status: "rejected", reason: decision.reason } satisfies PhotonDispatchResult);

  const event = envelope.event;
  const actor = decision.actor;
  if (!actor || !chatGuid || event.family !== "message" || event.type !== "received")
    return json({ status: "rejected", reason: "actor_or_chat_unverified" });
  const scope = decision.scope ?? existing?.scope ?? derivedScope;

  // A retired binding starts a fresh generation with a new immutable
  // initiating principal; its membership roster carries forward because it
  // describes the chat, not the retired task.
  const conversation = existing?.retiredAt ? undefined : existing;
  const generation = existing?.retiredAt ? existing.generation + 1 : existing?.generation ?? 1;
  const bindingId = conversation?.bindingId ?? bindingIdFor(row.sourceId, chatGuid, generation);
  const bound = conversation ?? await store.upsertConversation({
    bindingId,
    sourceId: row.sourceId,
    chatGuid,
    generation,
    scope,
    eveAddress: eveAddressFor(bindingId),
    initiatingPrincipal: photonPrincipalId(runtime.config.projectId, actor),
    membership: existing?.membership.length ? existing.membership : undefined,
  });

  // An expired absolute deadline retires the bound session rather than
  // reopening finished sensitive work for a late-arriving event.
  if (bound.eveSessionId && await isSessionExpired(store, bound.eveSessionId)) {
    await retireBoundSession(args, store, bound.eveSessionId, bound.bindingId, "session_deadline_expired");
    return json({ status: "rejected", reason: "session_deadline_expired" } satisfies PhotonDispatchResult);
  }

  const auth = photonDispatchAuth({
    projectId: runtime.config.projectId,
    actor,
    scope,
    chatGuid,
    sourceId: row.sourceId,
    bindingId: bound.bindingId,
  });

  // Resolve the canonical session before the first send; retries then go
  // through the fixed `attachSession` handle and can never drift into a
  // replacement session.
  let sessionId = bound.eveSessionId;
  if (!sessionId) {
    const created = await createConversationSession(
      args, bound.eveAddress, auth, conversationTitle(scope, actor, chatGuid),
    );
    sessionId = created.session.id;
    await store.bindEveSession(bound.bindingId, sessionId);
  }

  const text = describeInboundMessage(event.message);
  const respondCandidate = bound.eveSessionId
    ? await pendingPromptResponse(store, row.sourceId, chatGuid, actor, text)
    : undefined;
  const action = respondCandidate ? "respond" : "send";
  const dispatchKey = dispatchKeyFor(row.sourceId, row.logEpoch, row.sequence, action);
  // The action is part of the key, so an accepted delivery under the sibling
  // action (e.g. a send accepted before a prompt existed) already settles
  // this inbox row — a retry must not deliver the same event twice.
  const sibling = await store.getIntentByKey(
    dispatchKeyFor(row.sourceId, row.logEpoch, row.sequence, action === "send" ? "respond" : "send"),
  );
  if (sibling?.status === "accepted")
    return json({
      status: "duplicate",
      sessionId: sibling.eveSessionId ?? sessionId,
      deliveryId: sibling.deliveryId,
    } satisfies PhotonDispatchResult);
  const intent = await store.upsertIntent({
    intentId: `intent:${sha256Hex(dispatchKey)}`,
    sourceId: row.sourceId,
    logEpoch: row.logEpoch,
    sequence: row.sequence,
    action,
    eveSessionId: sessionId,
    dispatchKey,
    inputDigest: sha256Hex(canonicalJson(
      respondCandidate ? ["respond", respondCandidate.response] : ["send", text],
    )),
  });
  if (intent.status === "accepted")
    return json({
      status: "duplicate",
      sessionId: intent.eveSessionId ?? sessionId,
      deliveryId: intent.deliveryId,
    } satisfies PhotonDispatchResult);
  if (intent.status === "rejected")
    return json({ status: "rejected", reason: "intent_rejected" } satisfies PhotonDispatchResult);
  // Ambiguous or quarantined intents are reconciled by the worker — never
  // blind-replayed, which would duplicate an effect that may have landed.
  if (intent.status === "ambiguous" || intent.status === "quarantined")
    return json({ status: "retryable", reason: `intent_${intent.status}` });

  const session = args.attachSession(sessionId);
  try {
    const result = respondCandidate
      ? await session.respond([respondCandidate.response], {
          auth,
          idempotencyKey: dispatchKey,
          context: photonContextStrings(scope),
        })
      : await session.send(text, {
          auth,
          idempotencyKey: dispatchKey,
          context: photonContextStrings(scope),
          turnPolicy: "steer",
        });
    if (result.status !== "accepted") {
      // session_not_active requires reconciliation; a retry must not slip
      // the same event into a different address-resolved session.
      await store.updateIntent(intent.intentId, {
        status: "ambiguous", lastError: "session_not_active",
      });
      return json({ status: "retryable", reason: "session_not_active" } satisfies PhotonDispatchResult);
    }
    if (respondCandidate)
      await store.resolveInteraction(
        respondCandidate.interactionId, handleKey(actor), { ...respondCandidate.response },
      );
    await store.updateIntent(intent.intentId, {
      status: "accepted", eveSessionId: sessionId, deliveryId: result.deliveryId,
    });
    // The absolute 24h deadline starts at the first durably accepted turn;
    // the insert is a no-op once registered so retries never extend it.
    await enrollDeadlineOnDispatch(store, sessionId, bound.bindingId);
    await store.markInboxProcessing(inboxId, "dispatched");
    await store.touchConversation(bound.bindingId);
    return json({ status: "dispatched", sessionId, deliveryId: result.deliveryId } satisfies PhotonDispatchResult);
  } catch (error) {
    if (error instanceof SessionStrandedError) {
      await store.updateIntent(intent.intentId, {
        status: "ambiguous", lastError: "session_stranded",
      });
      return json({ status: "retryable", reason: "session_stranded" } satisfies PhotonDispatchResult);
    }
    throw error;
  }
}

async function handleEvents(req: Request, args: RouteHandlerArgs): Promise<Response> {
  const gate = routePrelude(req, { json: true });
  if ("response" in gate) return gate.response;
  try {
    return await readSessionEvents(req, gate.runtime, args);
  } catch (error) {
    console.error("Photon events route failed:", error instanceof Error ? error.message : error);
    return json({ status: "rejected", reason: "internal_error" }, 500);
  }
}

async function readSessionEvents(
  req: Request,
  runtime: PhotonRuntime,
  args: RouteHandlerArgs,
): Promise<Response> {
  const body = await readJsonBody(req);
  const parsed = body === undefined ? undefined : eventsReadRequestSchema.safeParse(body);
  if (!parsed?.success) return json({ status: "rejected", reason: "invalid_request" }, 400);
  const { sessionId, startIndex } = parsed.data;

  // The projector may read event streams only for photon-bound sessions.
  const bound = await runtime.store.findConversationBySession(sessionId);
  if (!bound) return json({ status: "rejected", reason: "session_not_bound" }, 403);

  const session = args.attachSession(sessionId);
  try {
    const stream = await session.getEventStream({ startIndex, follow: false });
    const events: unknown[] = [];
    const reader = stream.getReader();
    try {
      while (events.length < MAX_EVENTS_PER_READ) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(value);
      }
      if (events.length === MAX_EVENTS_PER_READ)
        await reader.cancel().catch(() => undefined);
    } finally {
      reader.releaseLock();
    }
    const tailIndex = await session.getStreamTailIndex();
    return json({ events, tailIndex } satisfies PhotonEventsReadResult);
  } catch (error) {
    if (error instanceof SessionStrandedError)
      return json({ events: [], tailIndex: startIndex, stranded: true } satisfies PhotonEventsReadResult);
    throw error;
  }
}

async function handleRetire(req: Request, args: RouteHandlerArgs): Promise<Response> {
  const gate = routePrelude(req, { json: true });
  if ("response" in gate) return gate.response;
  try {
    return await retireSession(req, gate.runtime, args);
  } catch (error) {
    console.error("Photon retire route failed:", error instanceof Error ? error.message : error);
    return json({ status: "retryable", reason: "internal_error" } satisfies PhotonRetireResult, 500);
  }
}

async function retireSession(
  req: Request,
  runtime: PhotonRuntime,
  args: RouteHandlerArgs,
): Promise<Response> {
  const body = await readJsonBody(req);
  const parsed = body === undefined ? undefined : retireRequestSchema.safeParse(body);
  if (!parsed?.success) return json({ status: "rejected", reason: "invalid_request" }, 400);
  const { eveSessionId, reason } = parsed.data;

  const [conversation, deadline] = await Promise.all([
    runtime.store.findConversationBySession(eveSessionId),
    runtime.store.getDeadline(eveSessionId),
  ]);
  if (!conversation && !deadline)
    return json({ status: "already_retired" } satisfies PhotonRetireResult);
  if (deadline?.retiredAt && (!conversation || conversation.retiredAt))
    return json({ status: "already_retired" } satisfies PhotonRetireResult);

  const outcome = await retireBoundSession(
    args, runtime.store, eveSessionId, conversation?.bindingId, reason,
  );
  return json({
    status: outcome === "reset" ? "retired" : "already_retired",
  } satisfies PhotonRetireResult);
}

async function handleHealth(req: Request): Promise<Response> {
  const gate = routePrelude(req, { json: false });
  if ("response" in gate) {
    // The health probe reports disabled/misconfigured as a failing check,
    // not as a retryable dispatch result.
    return json({ ok: false } satisfies PhotonHealthReport, gate.response.status);
  }
  try {
    return await photonHealth(gate.runtime);
  } catch (error) {
    console.error("Photon health route failed:", error instanceof Error ? error.message : error);
    return json({ ok: false } satisfies PhotonHealthReport, 503);
  }
}

async function photonHealth(runtime: PhotonRuntime): Promise<Response> {
  const sources = await runtime.store.pool.query<{
    source_id: string;
    status: string;
    lease_epoch: string;
    lease_expires_at: Date | null;
    capture_cursor: string | null;
    health: Record<string, unknown>;
  }>(
    `SELECT source_id, status, lease_epoch, lease_expires_at, capture_cursor, health
       FROM bell_photon_sources
      WHERE project_id = $1
      ORDER BY updated_at DESC
      LIMIT 1`,
    [runtime.config.projectId],
  );
  const source = sources.rows[0];
  if (!source) return json({ ok: false } satisfies PhotonHealthReport);
  const [inbox, commands] = await Promise.all([
    runtime.store.inboxStats(source.source_id),
    runtime.store.commandStats(source.source_id),
  ]);
  const leaseExpiresAt = source.lease_expires_at?.toISOString();
  const rawStreams = source.health && typeof source.health === "object"
    ? source.health["streams"] : undefined;
  const streams = rawStreams && typeof rawStreams === "object" && !Array.isArray(rawStreams)
    ? rawStreams as Record<string, { readonly lastBeat?: string; readonly ok: boolean }>
    : undefined;
  const alive = source.status === "active" && !!leaseExpiresAt && Date.parse(leaseExpiresAt) > Date.now();
  return json({
    ok: alive,
    worker: {
      alive,
      leaseEpoch: Number(source.lease_epoch),
      leaseExpiresAt,
      streams,
      captureCursor: source.capture_cursor ?? undefined,
      inboxLagSeconds: inbox.oldestPendingAgeSec ?? undefined,
      outboxPending: commands.queued + commands.inFlight,
      ambiguous: commands.ambiguous,
    },
  } satisfies PhotonHealthReport);
}

export default defineChannel({
  turnPolicy: "steer",
  audience: () => "private",
  context(_state, session): PhotonChannelContext {
    return {
      thread: {
        post: async (text: string) => {
          const runtime = photonRuntime();
          if (runtime) await postSessionNotice(runtime.store, session.id, text);
        },
      },
    };
  },
  events: photonBrowserEvents,
  async receive(input, ctx) {
    const auth = input.auth;
    if (!auth || !isPhotonAuth(auth))
      throw new Error("The photon channel only accepts verified photon session auth.");
    // Group audiences never accept a cross-channel handoff: a private
    // credential continuation belongs in the verified private conversation.
    if (photonAttribute(auth, PHOTON_ATTR_AUDIENCE) === "group")
      throw new Error("Group photon sessions cannot receive cross-channel handoffs.");
    const bindingId = photonAttribute(auth, PHOTON_ATTR_BINDING);
    const targetBinding = typeof input.target?.bindingId === "string"
      ? input.target.bindingId
      : bindingId;
    if (!targetBinding || (bindingId && bindingId !== targetBinding))
      throw new Error("A photon handoff can only continue the session's own bound conversation.");
    const runtime = photonRuntime();
    if (!runtime) throw new Error("The photon channel is disabled.");
    const conversation = await runtime.store.getConversationById(targetBinding);
    if (!conversation || conversation.retiredAt)
      throw new Error("No active photon conversation binding for the requested target.");
    if (photonAttribute(auth, PHOTON_ATTR_SOURCE) !== conversation.sourceId
      || photonAttribute(auth, PHOTON_ATTR_CHAT) !== conversation.chatGuid)
      throw new Error("Photon auth attributes do not match the requested conversation binding.");
    return ctx.from(conversation.eveAddress).send(input.message, {
      auth,
      turnPolicy: "steer",
    });
  },
  routes: [
    POST(PHOTON_DISPATCH_PATH, handleDispatch),
    POST(PHOTON_EVENTS_PATH, handleEvents),
    POST(PHOTON_RETIRE_PATH, handleRetire),
    GET(PHOTON_HEALTH_PATH, handleHealth),
  ],
});
