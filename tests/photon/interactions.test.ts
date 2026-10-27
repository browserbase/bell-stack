/**
 * Durable interaction contracts: a poll vote, reaction, prompt or card event
 * may resolve exactly one pending request, for the exact permitted actor and
 * target, before its expiry. Store semantics run now; the matching policy is
 * a parallel workstream module (`server/photon/interactions.ts`) that skips
 * while absent.
 */
import { describe, expect, it } from "vitest";

import type { PhotonEventEnvelope } from "../../server/photon/contracts";
import { sourceIdFor } from "../../server/photon/identity";
import type { InteractionRow, PhotonDb } from "../../server/photon/store";

import { envelope, inMemoryDb, optionalModule } from "./fixtures/harness";
import * as fx from "./fixtures/sdk-events";

const SOURCE_ID = sourceIdFor("test-project-0001", "inst-aaaa-bbbb", fx.RECEIVING_LINE);
const ACTOR = `phone:${fx.OPERATOR_PHONE}`;
const STRANGER = `phone:${fx.STRANGER_PHONE}`;

async function seededDb() {
  const db = inMemoryDb();
  await db.enrollSource({
    sourceId: SOURCE_ID, projectId: "test-project-0001", instanceId: "inst-aaaa-bbbb",
    accountScope: "acct", phoneNumber: fx.RECEIVING_LINE, endpoint: "x:443", logEpoch: "epoch-1",
  });
  return db;
}

function reactionEnvelope(actor: string | undefined, messageGuid = "msg-1"): PhotonEventEnvelope {
  return envelope(
    { family: "message", type: "reactionAdded", messageGuid, reaction: { kind: "love" } },
    { sequence: "1", chatGuid: fx.DIRECT_CHAT, actor },
  );
}

/* ------------------------------------------------------------------ */
/* Interaction ledger — frozen store contract                          */
/* ------------------------------------------------------------------ */

describe("pending interaction ledger", () => {
  it("creates a deterministic interaction id and ignores duplicate creation", async () => {
    const db = await seededDb();
    const input = {
      sourceId: SOURCE_ID, chatGuid: fx.DIRECT_CHAT, kind: "prompt" as const,
      requestRef: "req-1", permittedActor: ACTOR,
      target: { messageGuid: "msg-1" }, expiresAt: new Date("2026-10-28T00:00:00Z"),
    };
    const first = await db.createInteraction(input);
    const again = await db.createInteraction(input);
    expect(again).toBe(first);
    const open = await db.openInteractions(SOURCE_ID, fx.DIRECT_CHAT);
    expect(open).toHaveLength(1);
    expect(open[0].permittedActor).toBe(ACTOR);
  });

  it("lists only pending interactions for the exact chat", async () => {
    const db = await seededDb();
    await db.createInteraction({
      sourceId: SOURCE_ID, chatGuid: fx.DIRECT_CHAT, kind: "poll",
      requestRef: "req-a", target: { pollMessageGuid: fx.POLL_GUID },
    });
    await db.createInteraction({
      sourceId: SOURCE_ID, chatGuid: "iMessage;-;+12025550177", kind: "poll",
      requestRef: "req-b", target: { pollMessageGuid: fx.POLL_GUID },
    });
    expect(await db.openInteractions(SOURCE_ID, fx.DIRECT_CHAT)).toHaveLength(1);
    expect(await db.openInteractions(SOURCE_ID, "iMessage;-;+12025550177")).toHaveLength(1);
  });

  it("resolves once and records the resolving actor and payload", async () => {
    const db = await seededDb();
    const id = await db.createInteraction({
      sourceId: SOURCE_ID, chatGuid: fx.DIRECT_CHAT, kind: "authorization",
      requestRef: "req-1", permittedActor: ACTOR,
    });
    expect(await db.resolveInteraction(id, ACTOR, { approved: true })).toBe(true);
    // Second resolution is refused — one-time resolution is durable.
    expect(await db.resolveInteraction(id, STRANGER, { approved: false })).toBe(false);
    const open = await db.openInteractions(SOURCE_ID, fx.DIRECT_CHAT);
    expect(open).toHaveLength(0);
  });

  it("expires stale interactions in a bounded sweep", async () => {
    const db = await seededDb();
    const now = new Date("2026-10-27T12:00:00Z");
    await db.createInteraction({
      sourceId: SOURCE_ID, chatGuid: fx.DIRECT_CHAT, kind: "prompt",
      requestRef: "old", expiresAt: new Date(now.getTime() - 1_000),
    });
    await db.createInteraction({
      sourceId: SOURCE_ID, chatGuid: fx.DIRECT_CHAT, kind: "prompt",
      requestRef: "fresh", expiresAt: new Date(now.getTime() + 60_000),
    });
    await db.createInteraction({
      sourceId: SOURCE_ID, chatGuid: fx.DIRECT_CHAT, kind: "prompt",
      requestRef: "unbounded",
    });
    expect(await db.expireInteractions(now)).toBe(1);
    const open = await db.openInteractions(SOURCE_ID, fx.DIRECT_CHAT);
    expect(open.map((row) => row.requestRef).sort()).toEqual(["fresh", "unbounded"]);
  });
});

/* ------------------------------------------------------------------ */
/* Event-to-interaction matching — parallel workstream module          */
/* ------------------------------------------------------------------ */

interface InteractionsModule {
  matchInteraction(
    open: readonly InteractionRow[],
    probe: { kind?: InteractionRow["kind"]; targetMessageGuid?: string; pollMessageGuid?: string; actor?: string },
  ): InteractionRow | undefined;
  resolveForEvent?(
    db: PhotonDb,
    env: PhotonEventEnvelope,
    options?: { actor?: string },
  ): Promise<"resolved" | "state_only" | "none">;
}

const interactions = await optionalModule<InteractionsModule>("../../../server/photon/interactions.ts");

function openRow(overrides: Partial<InteractionRow> = {}): InteractionRow {
  return {
    interactionId: "int:1",
    sourceId: SOURCE_ID,
    chatGuid: fx.DIRECT_CHAT,
    generation: 1,
    kind: "reaction_contract",
    requestRef: "req-1",
    target: { messageGuid: "msg-1" },
    responseMapping: { love: "approve" },
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    ...overrides,
  };
}

describe.skipIf(!interactions)("interaction matching (server/photon/interactions.ts)", () => {
  const m = interactions!;

  it("matches by kind, target and permitted actor", () => {
    const rows = [openRow()];
    expect(m.matchInteraction(rows, { kind: "reaction_contract", targetMessageGuid: "msg-1", actor: ACTOR })).toBe(rows[0]);
  });

  it("refuses a different actor — arbitrary emoji never authorizes an action", () => {
    const rows = [openRow({ permittedActor: ACTOR })];
    expect(m.matchInteraction(rows, { kind: "reaction_contract", targetMessageGuid: "msg-1", actor: STRANGER })).toBeUndefined();
    // An unrestricted interaction may still resolve for any verified actor.
    const open = [openRow({ permittedActor: undefined })];
    const match = m.matchInteraction(open, { kind: "reaction_contract", targetMessageGuid: "msg-1", actor: STRANGER });
    if (match !== undefined) expect(match).toBe(open[0]);
  });

  it("never resolves on the wrong target or kind", () => {
    const rows = [openRow()];
    expect(m.matchInteraction(rows, { kind: "reaction_contract", targetMessageGuid: "msg-2", actor: ACTOR })).toBeUndefined();
    expect(m.matchInteraction(rows, { kind: "poll", targetMessageGuid: "msg-1", actor: ACTOR })).toBeUndefined();
  });

  it("missing actor means state-only: a replayed or unattributed vote cannot resolve", async () => {
    if (!m.resolveForEvent) return;
    const db = await seededDb();
    await db.createInteraction({
      sourceId: SOURCE_ID, chatGuid: fx.DIRECT_CHAT, kind: "reaction_contract",
      requestRef: "req-1", permittedActor: ACTOR, target: { messageGuid: "msg-1" },
    });
    const outcome = await m.resolveForEvent(db, reactionEnvelope(undefined), {});
    expect(outcome).not.toBe("resolved");
    expect(await db.openInteractions(SOURCE_ID, fx.DIRECT_CHAT)).toHaveLength(1);
  });

  it("an expired contract cannot resolve even for the right actor", async () => {
    if (!m.resolveForEvent) return;
    const db = await seededDb();
    await db.createInteraction({
      sourceId: SOURCE_ID, chatGuid: fx.DIRECT_CHAT, kind: "reaction_contract",
      requestRef: "req-1", permittedActor: ACTOR, target: { messageGuid: "msg-1" },
      expiresAt: new Date(Date.now() - 1_000),
    });
    const outcome = await m.resolveForEvent(db, reactionEnvelope(ACTOR), { actor: ACTOR });
    expect(outcome).not.toBe("resolved");
  });

  it("a replayed vote resolves at most once", async () => {
    if (!m.resolveForEvent) return;
    const db = await seededDb();
    await db.createInteraction({
      sourceId: SOURCE_ID, chatGuid: fx.DIRECT_CHAT, kind: "reaction_contract",
      requestRef: "req-1", permittedActor: ACTOR, target: { messageGuid: "msg-1" },
    });
    const first = await m.resolveForEvent(db, reactionEnvelope(ACTOR), { actor: ACTOR });
    const second = await m.resolveForEvent(db, reactionEnvelope(ACTOR), { actor: ACTOR });
    expect(first).toBe("resolved");
    expect(second).not.toBe("resolved");
    expect(await db.openInteractions(SOURCE_ID, fx.DIRECT_CHAT)).toHaveLength(0);
  });
});
