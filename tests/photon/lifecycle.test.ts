/**
 * Absolute conversation lifetime: Bell's pre-upgrade 24-hour maximum is
 * preserved by a persisted deadline record and a bounded retirement sweep —
 * Eve 0.82's idle timeout and `ctx.cancel()` alone are not retirement.
 * Deadline store semantics and the worker's `retireDueSessions` sweep both
 * run against the in-memory PhotonDb seam.
 */
import { describe, expect, it, vi } from "vitest";

import { PHOTON_RETIRE_PATH } from "../../server/photon/config";
import { bindingIdFor, eveAddressFor, sourceIdFor } from "../../server/photon/identity";
import { retireDueSessions } from "../../server/photon/worker";

import { inMemoryDb, testConfig } from "./fixtures/harness";
import * as fx from "./fixtures/sdk-events";

const SOURCE_ID = sourceIdFor("test-project-0001", "inst-aaaa-bbbb", fx.RECEIVING_LINE);
const DAY_MS = 24 * 60 * 60 * 1000;

async function seededDb() {
  const db = inMemoryDb();
  await db.enrollSource({
    sourceId: SOURCE_ID, projectId: "test-project-0001", instanceId: "inst-aaaa-bbbb",
    accountScope: "acct", phoneNumber: fx.RECEIVING_LINE, endpoint: "x:443", logEpoch: "epoch-1",
  });
  return db;
}

/* ------------------------------------------------------------------ */
/* Deadline ledger — frozen store contract                             */
/* ------------------------------------------------------------------ */

describe("session deadline ledger", () => {
  it("registers an absolute deadline and returns it when due", async () => {
    const db = await seededDb();
    const deadline = new Date(Date.now() + DAY_MS);
    await db.registerDeadline("eve-1", "binding-1", deadline);
    const row = await db.getDeadline("eve-1");
    expect(row?.deadlineAt.getTime()).toBe(deadline.getTime());
    expect(row?.bindingId).toBe("binding-1");
    // Not yet due.
    expect(await db.dueDeadlines(new Date(), 10)).toHaveLength(0);
    // Due at the deadline instant.
    const due = await db.dueDeadlines(new Date(deadline.getTime() + 1), 10);
    expect(due.map((row) => row.eveSessionId)).toEqual(["eve-1"]);
  });

  it("keeps the first deadline — re-registration never extends the clock", async () => {
    const db = await seededDb();
    const first = new Date(Date.now() + DAY_MS);
    await db.registerDeadline("eve-2", "binding-2", first);
    await db.registerDeadline("eve-2", "binding-2", new Date(Date.now() + 48 * 60 * 60 * 1000));
    expect((await db.getDeadline("eve-2"))?.deadlineAt.getTime()).toBe(first.getTime());
  });

  it("orders due deadlines oldest first and excludes retired sessions", async () => {
    const db = await seededDb();
    const now = Date.now();
    await db.registerDeadline("eve-b", "b", new Date(now - 5_000));
    await db.registerDeadline("eve-a", "a", new Date(now - 10_000));
    await db.registerDeadline("eve-future", "f", new Date(now + DAY_MS));
    await db.markDeadlineRetired("eve-b", "test");
    const due = await db.dueDeadlines(new Date(now), 10);
    expect(due.map((row) => row.eveSessionId)).toEqual(["eve-a"]);
    expect((await db.getDeadline("eve-b"))?.retiredAt).toBeTruthy();
    expect((await db.getDeadline("eve-b"))?.retirementReason).toBe("test");
  });

  it("survives a store restart — the deadline is re-read, not re-remembered", async () => {
    const db = await seededDb();
    const deadline = new Date(Date.now() + DAY_MS);
    await db.registerDeadline("eve-persist", "binding-p", deadline);
    // A second read path stands in for a process restart against durable rows.
    const reread = await db.getDeadline("eve-persist");
    expect(reread?.deadlineAt.getTime()).toBe(deadline.getTime());
    expect(reread?.retiredAt).toBeUndefined();
  });

  it("a retired conversation rejects further work and drops from the active set", async () => {
    const db = await seededDb();
    const bindingId = bindingIdFor(SOURCE_ID, fx.DIRECT_CHAT, 1);
    await db.upsertConversation({
      bindingId, sourceId: SOURCE_ID, chatGuid: fx.DIRECT_CHAT, generation: 1,
      scope: "direct", eveAddress: eveAddressFor(bindingId), eveSessionId: "eve-1",
    });
    expect(await db.activeConversations(SOURCE_ID)).toHaveLength(1);
    await db.retireConversation(bindingId);
    expect(await db.activeConversations(SOURCE_ID)).toHaveLength(0);
    expect((await db.getConversationById(bindingId))?.retiredAt).toBeTruthy();
    // Idempotent: retiring twice does not resurrect or move the timestamp.
    const retiredAt = (await db.getConversationById(bindingId))?.retiredAt;
    await db.retireConversation(bindingId);
    expect((await db.getConversationById(bindingId))?.retiredAt).toBe(retiredAt);
  });
});

/* ------------------------------------------------------------------ */
/* Retirement sweep — transport workstream module                      */
/* ------------------------------------------------------------------ */

const lifecycle = { retireDueSessions };

describe("retirement sweep", () => {
  const config = testConfig();

  it("calls the private retire route, then marks the deadline retired", async () => {
    const db = await seededDb();
    await db.registerDeadline("eve-old", "binding-old", new Date(Date.now() - 1_000));
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ status: "retired" }));
    await lifecycle!.retireDueSessions(db, config, { fetch: fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
    const [input] = fetcher.mock.calls[0];
    const url = input instanceof Request ? input.url : String(input);
    expect(url).toBe(`${config.internalOrigin}${PHOTON_RETIRE_PATH}`);
    expect((await db.getDeadline("eve-old"))?.retiredAt).toBeTruthy();
  });

  it("leaves the deadline open when the route reports a retryable failure", async () => {
    const db = await seededDb();
    await db.registerDeadline("eve-busy", "b", new Date(Date.now() - 1_000));
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ status: "retryable", reason: "eve restarting" }));
    await lifecycle!.retireDueSessions(db, config, { fetch: fetcher });
    expect((await db.getDeadline("eve-busy"))?.retiredAt).toBeUndefined();
    expect(await db.dueDeadlines(new Date(Date.now() + 60_000), 10)).toHaveLength(1);
  });

  it("treats an already_retired response as settled work", async () => {
    const db = await seededDb();
    await db.registerDeadline("eve-done", "b", new Date(Date.now() - 1_000));
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ status: "already_retired" }));
    const result = await lifecycle!.retireDueSessions(db, config, { fetch: fetcher });
    expect(result.retired).toBeGreaterThanOrEqual(1);
    expect((await db.getDeadline("eve-done"))?.retiredAt).toBeTruthy();
  });

  it("uses the retire/reset path — mere cancellation is not retirement", async () => {
    // PRD §16.2: `ctx.cancel()` alone must never satisfy the absolute deadline;
    // the supported fixed-session retire route is the evidence.
    const db = await seededDb();
    await db.registerDeadline("eve-cancel", "b", new Date(Date.now() - 1_000));
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toContain(PHOTON_RETIRE_PATH);
      return Response.json({ status: "retired" });
    });
    await lifecycle!.retireDueSessions(db, config, { fetch: fetcher });
    expect(fetcher).toHaveBeenCalled();
  });
});
