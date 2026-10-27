/**
 * Dispatch pipeline: durable intents, the internal route contract, and the
 * fixed-session binding. Store-level behaviors run now; the worker's
 * `dispatchPending` state machine is a parallel workstream module — those
 * describes skip while `server/photon/dispatch.ts` is absent.
 */
import { describe, expect, it, vi } from "vitest";

import {
  PHOTON_DISPATCH_PATH,
  type PhotonConfig,
} from "../../server/photon/config";
import type { PhotonEventEnvelope, PhotonDispatchResult } from "../../server/photon/contracts";
import {
  bindingIdFor,
  dispatchKeyFor,
  eveAddressFor,
  sourceIdFor,
} from "../../server/photon/identity";
import type { PhotonDb } from "../../server/photon/store";

import { envelope, inMemoryDb, optionalModule, payloadHashFor, testConfig } from "./fixtures/harness";
import * as fx from "./fixtures/sdk-events";

const SOURCE_ID = sourceIdFor("test-project-0001", "inst-aaaa-bbbb", fx.RECEIVING_LINE);
const EPOCH = "epoch-1";

async function seededDb() {
  const db = inMemoryDb();
  await db.enrollSource({
    sourceId: SOURCE_ID, projectId: "test-project-0001", instanceId: "inst-aaaa-bbbb",
    accountScope: "acct", phoneNumber: fx.RECEIVING_LINE, endpoint: "x:443", logEpoch: EPOCH,
  });
  return db;
}

async function capture(db: PhotonDb, seq: number, env: PhotonEventEnvelope, disposition: "admitted" | "state_only" | "denied" = "admitted") {
  return db.captureEvent({
    sourceId: SOURCE_ID, logEpoch: EPOCH, sequence: String(seq), sequenceNum: String(seq),
    payloadHash: payloadHashFor(env), envelope: env,
    eventFamily: env.event.family, eventType: env.event.type,
    chatGuid: env.chatGuid, actor: env.actor, isFromMe: env.isFromMe,
    occurredAt: env.occurredAt, sourceKind: env.sourceKind, disposition,
  });
}

function admittedEnvelope(seq: number, chatGuid = fx.DIRECT_CHAT): PhotonEventEnvelope {
  return envelope(
    { family: "message", type: "received", message: fx.message({ guid: `m-${seq}`, chatGuids: [chatGuid] }) },
    { sequence: String(seq), chatGuid },
  );
}

/* ------------------------------------------------------------------ */
/* Intent ledger — frozen store contract                               */
/* ------------------------------------------------------------------ */

describe("dispatch intent ledger", () => {
  it("deduplicates on the deterministic dispatch key, not the intent id", async () => {
    const db = await seededDb();
    await capture(db, 1, admittedEnvelope(1));
    const key = dispatchKeyFor(SOURCE_ID, EPOCH, "1", "send");
    const first = await db.upsertIntent({
      intentId: "i-1", sourceId: SOURCE_ID, logEpoch: EPOCH, sequence: "1",
      action: "send", dispatchKey: key, inputDigest: "d1",
    });
    const retry = await db.upsertIntent({
      intentId: "i-2", sourceId: SOURCE_ID, logEpoch: EPOCH, sequence: "1",
      action: "send", dispatchKey: key, inputDigest: "d1",
    });
    expect(retry.intentId).toBe(first.intentId);
    // Distinct actions on the same inbox row remain distinct intents.
    const respond = await db.upsertIntent({
      intentId: "i-3", sourceId: SOURCE_ID, logEpoch: EPOCH, sequence: "1",
      action: "respond", dispatchKey: dispatchKeyFor(SOURCE_ID, EPOCH, "1", "respond"), inputDigest: "d1",
    });
    expect(respond.intentId).not.toBe(first.intentId);
  });

  it("orders pending intents by provider sequence per conversation", async () => {
    const db = await seededDb();
    for (const seq of [30, 10, 20]) await capture(db, seq, admittedEnvelope(seq));
    for (const seq of [30, 10, 20]) {
      await db.upsertIntent({
        intentId: `i-${seq}`, sourceId: SOURCE_ID, logEpoch: EPOCH, sequence: String(seq),
        action: "send", dispatchKey: dispatchKeyFor(SOURCE_ID, EPOCH, String(seq), "send"), inputDigest: "d",
      });
    }
    const pending = await db.pendingIntents(SOURCE_ID, 10);
    expect(pending.map((row) => row.sequence)).toEqual(["10", "20", "30"]);
    await db.updateIntent(pending[0].intentId, { status: "accepted", deliveryId: "eve-delivery-1" });
    expect((await db.getIntentByKey(dispatchKeyFor(SOURCE_ID, EPOCH, "10", "send")))?.status).toBe("accepted");
    expect((await db.pendingIntents(SOURCE_ID, 10)).map((row) => row.sequence)).toEqual(["20", "30"]);
  });

  it("binds one Eve session to a conversation and never rebinds implicitly", async () => {
    const db = await seededDb();
    const bindingId = bindingIdFor(SOURCE_ID, fx.DIRECT_CHAT, 1);
    await db.upsertConversation({
      bindingId, sourceId: SOURCE_ID, chatGuid: fx.DIRECT_CHAT, generation: 1,
      scope: "direct", eveAddress: eveAddressFor(bindingId),
    });
    await db.bindEveSession(bindingId, "eve-session-1");
    expect((await db.getConversationById(bindingId))?.eveSessionId).toBe("eve-session-1");
    expect((await db.findConversationBySession("eve-session-1"))?.bindingId).toBe(bindingId);
    // Retire marks the generation closed; late events cannot reopen it.
    await db.retireConversation(bindingId);
    expect((await db.getConversationById(bindingId))?.retiredAt).toBeTruthy();
    expect(await db.activeConversations(SOURCE_ID)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* dispatchPending — transport workstream module                       */
/* ------------------------------------------------------------------ */

interface DispatchModule {
  dispatchPending(
    db: PhotonDb,
    config: PhotonConfig,
    options?: {
      fetch?: typeof fetch;
      batchSize?: number;
      now?: () => Date;
      correlationId?: string;
    },
  ): Promise<{ dispatched: number; stateApplied: number; retried: number; rejected: number }>;
}

const dispatch = await optionalModule<DispatchModule>("../../../server/photon/dispatch.ts");

describe.skipIf(!dispatch)("dispatchPending (server/photon/dispatch.ts)", () => {
  const config = testConfig();

  function fakeDispatch(result: PhotonDispatchResult) {
    return vi.fn<typeof fetch>(async () => Response.json(result));
  }

  it("POSTs an admitted row to the private route and records the durable result", async () => {
    const db = await seededDb();
    const env = admittedEnvelope(1);
    await capture(db, 1, env);
    const fetcher = fakeDispatch({ status: "dispatched", sessionId: "eve-session-1", deliveryId: "del-1" });
    await dispatch!.dispatchPending(db, config, { fetch: fetcher });

    expect(fetcher).toHaveBeenCalledOnce();
    const [input, init] = fetcher.mock.calls[0];
    const url = input instanceof Request ? input.url : String(input);
    expect(url).toBe(`${config.internalOrigin}${PHOTON_DISPATCH_PATH}`);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${config.internalSecret}`);
    const body = JSON.parse(String(init?.body));
    expect(body.inboxId).toEqual({ sourceId: SOURCE_ID, logEpoch: EPOCH, sequence: "1" });
    expect(body.correlationId).toBeTruthy();
    // The route must not receive trusted sender text or session ids.
    expect(body.message).toBeUndefined();
    expect(body.sessionId).toBeUndefined();
    expect(body.actor).toBeUndefined();

    const row = await db.getInboxRow({ sourceId: SOURCE_ID, logEpoch: EPOCH, sequence: "1" });
    expect(row?.processingState).toBe("dispatched");
  });

  it("keeps a retryable dispatch pending with attempts incremented", async () => {
    const db = await seededDb();
    await capture(db, 2, admittedEnvelope(2));
    const fetcher = fakeDispatch({ status: "retryable", reason: "eve busy" });
    await dispatch!.dispatchPending(db, config, { fetch: fetcher });
    const row = await db.getInboxRow({ sourceId: SOURCE_ID, logEpoch: EPOCH, sequence: "2" });
    expect(row?.processingState).toBe("captured");
    expect(row?.attempts ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("quarantines a rejected dispatch with the reason recorded", async () => {
    const db = await seededDb();
    await capture(db, 3, admittedEnvelope(3));
    const fetcher = fakeDispatch({ status: "rejected", reason: "retired session" });
    await dispatch!.dispatchPending(db, config, { fetch: fetcher });
    const row = await db.getInboxRow({ sourceId: SOURCE_ID, logEpoch: EPOCH, sequence: "3" });
    expect(["quarantined", "failed"]).toContain(row?.processingState);
  });

  it("applies state_only events without ever calling the dispatch route", async () => {
    const db = await seededDb();
    const stateEvent = envelope(
      { family: "chat", type: "markedRead" },
      { sequence: "4", chatGuid: fx.DIRECT_CHAT },
    );
    await capture(db, 4, stateEvent, "state_only");
    const fetcher = fakeDispatch({ status: "dispatched", sessionId: "s" });
    const result = await dispatch!.dispatchPending(db, config, { fetch: fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(0);
    expect(result.stateApplied).toBeGreaterThanOrEqual(1);
    const row = await db.getInboxRow({ sourceId: SOURCE_ID, logEpoch: EPOCH, sequence: "4" });
    expect(["settled", "dispatched"]).toContain(row?.processingState);
  });

  it("refreshes membership before dispatch for a participant join", async () => {
    const db = await seededDb();
    const bindingId = bindingIdFor(SOURCE_ID, fx.GROUP_CHAT, 1);
    await db.upsertConversation({
      bindingId, sourceId: SOURCE_ID, chatGuid: fx.GROUP_CHAT, generation: 1,
      scope: "group", eveAddress: eveAddressFor(bindingId), membership: [`phone:${fx.OPERATOR_PHONE}`],
    });
    const joined = envelope(
      { family: "group", type: "participantAdded", participant: fx.phone(fx.STRANGER_PHONE) },
      { sequence: "5", chatGuid: fx.GROUP_CHAT },
    );
    await capture(db, 5, joined, "state_only");
    const fetcher = fakeDispatch({ status: "state_applied" });
    await dispatch!.dispatchPending(db, groupConfigSeam(), { fetch: fetcher });
    const conversation = await db.getConversationById(bindingId);
    expect(conversation?.membership).toContain(`phone:${fx.STRANGER_PHONE}`);
    expect(fetcher).not.toHaveBeenCalled();

    function groupConfigSeam() {
      return testConfig({ allowedGroups: [fx.GROUP_CHAT] });
    }
  });

  it("rejects a late event for a retired conversation instead of reopening it", async () => {
    const db = await seededDb();
    const bindingId = bindingIdFor(SOURCE_ID, fx.DIRECT_CHAT, 1);
    await db.upsertConversation({
      bindingId, sourceId: SOURCE_ID, chatGuid: fx.DIRECT_CHAT, generation: 1,
      scope: "direct", eveAddress: eveAddressFor(bindingId), eveSessionId: "eve-old",
    });
    await db.retireConversation(bindingId);
    await capture(db, 6, admittedEnvelope(6));
    const fetcher = fakeDispatch({ status: "dispatched", sessionId: "eve-new" });
    await dispatch!.dispatchPending(db, config, { fetch: fetcher });
    // Either no request left the worker, or the route rejected and the row was
    // quarantined — it must never rebind a retired generation silently.
    if (fetcher.mock.calls.length > 0) {
      const row = await db.getInboxRow({ sourceId: SOURCE_ID, logEpoch: EPOCH, sequence: "6" });
      expect(["quarantined", "failed"]).toContain(row?.processingState);
    }
    expect((await db.getConversationById(bindingId))?.eveSessionId).toBe("eve-old");
  });
});
