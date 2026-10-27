/**
 * Durable ingestion and recovery: the inbox dedup key, payload-hash
 * integrity, per-chat sequence ordering, activation boundary, and the
 * cold-restart watermark. Runs twice — against the in-memory PhotonDb seam
 * (always) and against the real PostgreSQL store + migration 004 when
 * TEST_PHOTON_DATABASE_URL (or DATABASE_URL) is set.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PhotonEventEnvelope } from "../../server/photon/contracts";
import { dispatchKeyFor, sourceIdFor } from "../../server/photon/identity";
import {
  createPhotonStore,
  type InboxInsert,
  type PhotonDb,
} from "../../server/photon/store";

import { envelope, inMemoryDb, payloadHashFor } from "./fixtures/harness";
import * as fx from "./fixtures/sdk-events";

const SOURCE_ID = sourceIdFor("test-project-0001", "inst-aaaa-bbbb", fx.RECEIVING_LINE);
const EPOCH = "epoch-1";

function insert(seq: number, env: PhotonEventEnvelope, overrides: Partial<InboxInsert> = {}): InboxInsert {
  return {
    sourceId: SOURCE_ID,
    logEpoch: EPOCH,
    sequence: String(seq),
    sequenceNum: String(seq),
    payloadHash: payloadHashFor(env),
    envelope: env,
    eventFamily: env.event.family,
    eventType: env.event.type,
    chatGuid: env.chatGuid,
    actor: env.actor,
    isFromMe: env.isFromMe,
    occurredAt: env.occurredAt,
    sourceKind: env.sourceKind,
    disposition: "admitted",
    ...overrides,
  };
}

function receivedEnvelope(seq: number, chatGuid = fx.DIRECT_CHAT): PhotonEventEnvelope {
  return envelope(
    { family: "message", type: "received", message: fx.message({ guid: `m-${seq}`, chatGuids: [chatGuid] }) },
    { sequence: String(seq), chatGuid },
  );
}

/* Run the same capture-recovery assertions against any PhotonDb. */
function captureSuite(getDb: () => PhotonDb) {
  it("detects an integrity conflict when one key carries a different payload hash", async () => {
    const db = getDb();
    const first = insert(7, receivedEnvelope(7));
    expect(await db.captureEvent(first)).toMatchObject({ kind: "inserted" });
    const tampered = insert(7, receivedEnvelope(7), { payloadHash: "different-hash" });
    const conflict = await db.captureEvent(tampered);
    expect(conflict).toMatchObject({ kind: "integrity_conflict", existingHash: first.payloadHash });
    const row = await db.getInboxRow(first);
    expect(row?.payloadHash).toBe(first.payloadHash);
  });

  it("deduplicates the same event captured through live and catch-up paths", async () => {
    const db = getDb();
    const live = insert(11, receivedEnvelope(11), { sourceKind: "live" });
    const replayed = insert(11, receivedEnvelope(11), { sourceKind: "catchup" });
    expect(await db.captureEvent(live)).toMatchObject({ kind: "inserted" });
    expect(await db.captureEvent(replayed)).toMatchObject({ kind: "duplicate" });
    // The canonical hash excludes sourceKind — live/catch-up identity matches.
    expect((await db.getInboxRow(live))?.sourceKind).toBe("live");
  });

  it("stores denied and non-triggering events as minimal tombstones that fill sequence gaps", async () => {
    const db = getDb();
    const denied = insert(5, receivedEnvelope(5), {
      envelope: undefined, tombstone: true, disposition: "denied",
      actor: undefined, chatGuid: undefined,
    });
    expect(await db.captureEvent(denied)).toMatchObject({ kind: "inserted" });
    expect((await db.getInboxRow(denied))?.tombstone).toBe(true);
    expect((await db.getInboxRow(denied))?.envelope).toBeUndefined();
  });

  it("preserves per-chat order while other chats proceed independently", async () => {
    const db = getDb();
    // Distinct chats keep this test independent of other suite captures.
    const chatA = "iMessage;-;+12025550166";
    const chatB = "iMessage;-;+12025550177";
    // Out-of-order arrival in one chat must still dispatch in provider order.
    for (const row of [insert(3, receivedEnvelope(3, chatA)), insert(1, receivedEnvelope(1, chatA)), insert(2, receivedEnvelope(2, chatA))]) {
      await db.captureEvent(row);
    }
    await db.captureEvent(insert(9, receivedEnvelope(9, chatB)));
    const chatARows = await db.pendingForChat(SOURCE_ID, chatA, 10);
    expect(chatARows.map((row) => row.sequence)).toEqual(["1", "2", "3"]);
    // pendingDispatch takes the first captured row per chat only; other chats
    // may have pending rows from earlier suite captures.
    const heads = await db.pendingDispatch(SOURCE_ID, 10);
    const head = (chat: string) => heads.find((row) => row.chatGuid === chat)?.sequence;
    expect(head(chatA)).toBe("1");
    expect(head(chatB)).toBe("9");
  });

  it("resumes the provider watermark from the persisted max sequence", async () => {
    const db = getDb();
    for (const seq of [40, 41, 42]) await db.captureEvent(insert(seq, receivedEnvelope(seq)));
    expect(await db.maxSequenceNum(SOURCE_ID, EPOCH)).toBe("42");
    // A different log epoch has its own sequence domain.
    await db.captureEvent(insert(5, receivedEnvelope(5), { logEpoch: "epoch-2" }));
    expect(await db.maxSequenceNum(SOURCE_ID, "epoch-2")).toBe("5");
    expect(await db.maxSequenceNum(SOURCE_ID, "epoch-3")).toBeUndefined();
  });

  it("records the activation boundary once and never moves it backwards", async () => {
    const db = getDb();
    await db.setActivationBoundary(SOURCE_ID, "100");
    expect(await db.activationBoundary(SOURCE_ID)).toBe("100");
    await db.setActivationBoundary(SOURCE_ID, "50");
    expect(await db.activationBoundary(SOURCE_ID)).toBe("100");
  });

  it("supports lossless sequences beyond JavaScript's safe integer range", async () => {
    const db = getDb();
    const big = "9007199254740993123"; // > Number.MAX_SAFE_INTEGER
    const env = receivedEnvelope(1);
    const row = insert(1, env, { sequence: big, sequenceNum: big });
    expect(await db.captureEvent(row)).toMatchObject({ kind: "inserted" });
    const stored = await db.getInboxRow(row);
    expect(stored?.sequence).toBe(big);
    expect(await db.maxSequenceNum(SOURCE_ID, EPOCH)).toBe(big);
  });
}

describe("inbox dedup and ordering (in-memory PhotonDb seam)", () => {
  const db = inMemoryDb();
  beforeAll(async () => {
    await db.enrollSource({
      sourceId: SOURCE_ID, projectId: "test-project-0001", instanceId: "inst-aaaa-bbbb",
      accountScope: "acct", phoneNumber: fx.RECEIVING_LINE, endpoint: "x:443", logEpoch: EPOCH,
    });
  });
  captureSuite(() => db);

  it("holds a later live message until earlier replayed work is captured", async () => {
    const gap = inMemoryDb();
    await gap.enrollSource({
      sourceId: SOURCE_ID, projectId: "p", instanceId: "i", accountScope: "a",
      phoneNumber: fx.RECEIVING_LINE, endpoint: "e", logEpoch: EPOCH,
    });
    // Sequence 103 arrives live before replay delivers 101/102.
    await gap.captureEvent(insert(103, receivedEnvelope(103)));
    const heads = await gap.pendingForChat(SOURCE_ID, fx.DIRECT_CHAT, 10);
    expect(heads.map((row) => row.sequence)).toEqual(["103"]);
    await gap.captureEvent(insert(101, receivedEnvelope(101), { sourceKind: "catchup" }));
    await gap.captureEvent(insert(102, receivedEnvelope(102), { sourceKind: "catchup" }));
    const ordered = await gap.pendingForChat(SOURCE_ID, fx.DIRECT_CHAT, 10);
    expect(ordered.map((row) => row.sequence)).toEqual(["101", "102", "103"]);
    // The watermark is the max persisted sequence, not arrival order.
    expect(await gap.maxSequenceNum(SOURCE_ID, EPOCH)).toBe("103");
  });
});

const databaseUrl = process.env.TEST_PHOTON_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("inbox dedup and ordering (PostgreSQL + migration 004)", () => {
  const schema = `photon_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let db: PhotonDb & { close(): Promise<void> };

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const store = createPhotonStore(`${databaseUrl}?options=-c%20search_path%3D${schema}`);
    const migration = await readFile(new URL("../../migrations/004_photon.sql", import.meta.url), "utf8");
    await store.pool.query(migration);
    db = store;
    await db.enrollSource({
      sourceId: SOURCE_ID, projectId: "test-project-0001", instanceId: "inst-aaaa-bbbb",
      accountScope: "acct", phoneNumber: fx.RECEIVING_LINE, endpoint: "x:443", logEpoch: EPOCH,
    });
  });

  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  captureSuite(() => db);

  it("keeps the dispatch intent ledger keyed once per inbox action", async () => {
    const env = receivedEnvelope(77);
    await db.captureEvent(insert(77, env));
    const key = dispatchKeyFor(SOURCE_ID, EPOCH, "77", "send");
    const intent = await db.upsertIntent({
      intentId: "intent-77", sourceId: SOURCE_ID, logEpoch: EPOCH, sequence: "77",
      action: "send", dispatchKey: key, inputDigest: "digest-77",
    });
    const again = await db.upsertIntent({
      intentId: "intent-77-b", sourceId: SOURCE_ID, logEpoch: EPOCH, sequence: "77",
      action: "send", dispatchKey: key, inputDigest: "digest-77",
    });
    expect(again.intentId).toBe(intent.intentId);
    expect((await db.getIntentByKey(key))?.intentId).toBe(intent.intentId);
  });
});
