/**
 * Durable outbound commands: claim → execute → settle. The command ledger
 * (enqueue dedup, claim fencing, completion states) and the outbox state
 * machine both run against the in-memory PhotonDb seam.
 */
import { describe, expect, it } from "vitest";

import {
  KEYED_OPERATIONS,
  READ_OPERATIONS,
  type PhotonCommand,
  type PhotonCommandDeps,
  type PhotonCommandExecutor,
  type PhotonCommandOp,
} from "../../server/photon/contracts";
import { providerKeyFor, semanticKeyFor, sourceIdFor } from "../../server/photon/identity";
import { createOutbox } from "../../server/photon/outbox";
import type { PhotonDb } from "../../server/photon/store";

import { inMemoryDb } from "./fixtures/harness";
import * as fx from "./fixtures/sdk-events";

const SOURCE_ID = sourceIdFor("test-project-0001", "inst-aaaa-bbbb", fx.RECEIVING_LINE);

async function seededDb() {
  const db = inMemoryDb();
  await db.enrollSource({
    sourceId: SOURCE_ID, projectId: "test-project-0001", instanceId: "inst-aaaa-bbbb",
    accountScope: "acct", phoneNumber: fx.RECEIVING_LINE, endpoint: "x:443", logEpoch: "epoch-1",
  });
  return db;
}

function command(overrides: Partial<PhotonCommand> & { operation?: PhotonCommandOp }): PhotonCommand {
  // The semantic key identifies the logical output, not this attempt — two
  // commands sharing it (and the args digest) are the same work.
  const semanticKey = overrides.semanticKey
    ?? semanticKeyFor({ outputKind: "tool", toolCallId: "call-1" });
  return {
    commandId: "cmd-1",
    operation: "messages.sendText",
    args: { chat: fx.DIRECT_CHAT, text: "hello" },
    argsDigest: "digest-1",
    initiatorPrincipal: "photon:" + "a".repeat(64),
    audience: "direct",
    sourceId: SOURCE_ID,
    chatGuid: fx.DIRECT_CHAT,
    providerKey: providerKeyFor(overrides.commandId ?? "cmd-1", 0),
    semanticKey,
    dependsOn: [],
    ...overrides,
  } as PhotonCommand;
}

/* ------------------------------------------------------------------ */
/* Command ledger — frozen store contract                              */
/* ------------------------------------------------------------------ */

describe("command ledger", () => {
  it("deduplicates by semantic key only when the arguments digest matches", async () => {
    const db = await seededDb();
    const first = await db.enqueueCommand(command({ commandId: "c-1" }));
    expect(first).toEqual({ commandId: "c-1", deduplicated: false });
    const retry = await db.enqueueCommand(command({ commandId: "c-2" }));
    expect(retry).toEqual({ commandId: "c-1", deduplicated: true });
    // Same key + changed arguments is a conflict, never a silent overwrite.
    await expect(db.enqueueCommand(command({ commandId: "c-3", argsDigest: "different" })))
      .rejects.toThrow(/semantic_key/);
  });

  it("claims queued commands once and tracks the claim owner", async () => {
    const db = await seededDb();
    await db.enqueueCommand(command({ commandId: "c-1" }));
    await db.enqueueCommand(command({ commandId: "c-2", semanticKey: semanticKeyFor({ outputKind: "tool", toolCallId: "c-2" }) }));
    const claimed = await db.claimCommands("worker-1", 10, 60_000);
    expect(claimed.map((row) => row.commandId).sort()).toEqual(["c-1", "c-2"]);
    expect(claimed.every((row) => row.status === "in_flight" && row.claimedBy === "worker-1" && row.attemptCount === 1)).toBe(true);
    // A second claim finds nothing — the work is fenced to the first worker.
    expect(await db.claimCommands("worker-2", 10, 60_000)).toHaveLength(0);
  });

  it("settles to acknowledged, ambiguous, failed or expired without losing receipts", async () => {
    const db = await seededDb();
    await db.enqueueCommand(command({ commandId: "ack" }));
    await db.completeCommand("ack", "acknowledged", { result: { guid: "msg-1" }, providerReceipt: { id: "rcpt" } });
    const acked = await db.getCommand("ack");
    expect(acked?.status).toBe("acknowledged");
    expect(acked?.result).toEqual({ guid: "msg-1" });
    expect(acked?.providerReceipt).toEqual({ id: "rcpt" });

    await db.enqueueCommand(command({ commandId: "amb", semanticKey: semanticKeyFor({ outputKind: "tool", toolCallId: "amb" }) }));
    await db.completeCommand("amb", "ambiguous", { errorCode: "transport_lost", providerKey: providerKeyFor("amb", 1) });
    expect((await db.getCommand("amb"))?.status).toBe("ambiguous");
    expect((await db.getCommand("amb"))?.providerKey).toBe("bell:amb:1");

    await db.enqueueCommand(command({ commandId: "fail", semanticKey: semanticKeyFor({ outputKind: "tool", toolCallId: "fail" }) }));
    await db.completeCommand("fail", "failed", { errorCode: "chatNotFound" });
    expect((await db.getCommand("fail"))?.status).toBe("failed");

    await db.enqueueCommand(command({ commandId: "exp", semanticKey: semanticKeyFor({ outputKind: "tool", toolCallId: "exp" }) }));
    await db.completeCommand("exp", "expired", { errorDetail: "typing indicator outlived its lease" });
    expect((await db.getCommand("exp"))?.status).toBe("expired");
  });

  it("reports queue statistics per source", async () => {
    const db = await seededDb();
    await db.enqueueCommand(command({ commandId: "q1" }));
    await db.enqueueCommand(command({ commandId: "q2", semanticKey: semanticKeyFor({ outputKind: "tool", toolCallId: "q2" }) }));
    await db.claimCommands("w", 1, 60_000);
    await db.completeCommand("q2", "ambiguous", {});
    const stats = await db.commandStats(SOURCE_ID);
    expect(stats.inFlight).toBe(1);
    expect(stats.ambiguous).toBe(1);
    expect(stats.queued).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Outbox executor — transport workstream module                       */
/* ------------------------------------------------------------------ */

const deps: PhotonCommandDeps = {
  client: { sendText: async () => ({ guid: "m" }), raw: {} },
  artifacts: {
    get: async () => undefined,
    put: async () => "art:x",
  },
  config: { projectId: "test-project-0001" },
  now: () => new Date("2026-10-27T12:00:00Z"),
};

const NOOP_WATCHES = { setLocationWatch: async () => true };

describe("command execution state machine (server/photon/outbox.ts)", () => {
  async function enqueue(db: PhotonDb, overrides: Partial<PhotonCommand> & { operation: PhotonCommandOp }) {
    const cmd = command(overrides);
    await db.enqueueCommand(cmd);
    return cmd;
  }

  /** One outbox tick with the probe executor injected for the given ops. */
  async function runOnce(
    db: PhotonDb,
    executor: PhotonCommandExecutor,
    ops: readonly PhotonCommandOp[],
  ): Promise<number> {
    const executors: Partial<Record<PhotonCommandOp, PhotonCommandExecutor>> = {};
    for (const op of ops) executors[op] = executor;
    return createOutbox({
      store: db, workerId: "w-1", sourceId: SOURCE_ID,
      commandDeps: deps, watchControl: NOOP_WATCHES,
      claimMs: 60_000, batchSize: 10, executors,
    }).runOnce();
  }

  it("acknowledges a successful keyed send with the provider receipt", async () => {
    const db = await seededDb();
    const cmd = await enqueue(db, { commandId: "send-1", operation: "messages.sendText" });
    const executor: PhotonCommandExecutor = async (claimed) => {
      expect(claimed.providerKey).toBe(providerKeyFor(cmd.commandId, 0));
      return { kind: "acknowledged", result: { guid: "msg-9" }, providerReceipt: { ok: true } };
    };
    await runOnce(db, executor, ["messages.sendText"]);
    const row = await db.getCommand("send-1");
    expect(row?.status).toBe("acknowledged");
    expect(row?.providerReceipt).toEqual({ ok: true });
  });

  it("backs off a retryable failure without losing the queued row", async () => {
    const db = await seededDb();
    await enqueue(db, { commandId: "r-1", operation: "messages.sendText" });
    const executor: PhotonCommandExecutor = async () => ({ kind: "retryable", errorCode: "serviceUnavailable", retryAfterMs: 5_000 });
    await runOnce(db, executor, ["messages.sendText"]);
    const row = await db.getCommand("r-1");
    expect(row?.status).toBe("queued");
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(row?.attemptCount).toBe(1);
  });

  it("marks a non-idempotent mutation ambiguous after a lost transport — no blind retry", async () => {
    const db = await seededDb();
    // chats.markRead has no clientMessageId; the response was lost after the
    // provider may have applied it.
    await enqueue(db, { commandId: "mr-1", operation: "chats.markRead" });
    const executor: PhotonCommandExecutor = async () => ({ kind: "ambiguous", reason: "response lost after acceptance" });
    await runOnce(db, executor, ["chats.markRead"]);
    const row = await db.getCommand("mr-1");
    expect(row?.status).toBe("ambiguous");
    // A later tick must NOT re-execute an ambiguous command blindly.
    let calls = 0;
    const second: PhotonCommandExecutor = async () => { calls++; return { kind: "acknowledged" }; };
    await runOnce(db, second, ["chats.markRead"]);
    expect(calls).toBe(0);
    expect((await db.getCommand("mr-1"))?.status).toBe("ambiguous");
  });

  it("lets read operations retry freely since they carry no side effects", async () => {
    const db = await seededDb();
    await enqueue(db, { commandId: "read-1", operation: "messages.get" });
    expect(READ_OPERATIONS.has("messages.get")).toBe(true);
    const executor: PhotonCommandExecutor = async () => ({ kind: "retryable", errorCode: "timeout" });
    await runOnce(db, executor, ["messages.get"]);
    expect((await db.getCommand("read-1"))?.status).toBe("queued");
  });

  it("fails validation-rejected commands without retrying", async () => {
    const db = await seededDb();
    await enqueue(db, { commandId: "f-1", operation: "groups.leave" });
    const executor: PhotonCommandExecutor = async () => ({ kind: "failed", errorCode: "preconditionFailed" });
    await runOnce(db, executor, ["groups.leave"]);
    expect((await db.getCommand("f-1"))?.status).toBe("failed");
  });

  it("expires stale commands instead of executing them", async () => {
    const db = await seededDb();
    // Typing intents have a short lease; replaying a stale one is wrong.
    await enqueue(db, {
      commandId: "type-1", operation: "chats.setTyping",
      args: { chat: fx.DIRECT_CHAT, isTyping: true },
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const executor: PhotonCommandExecutor = async () => { throw new Error("must not execute"); };
    await runOnce(db, executor, ["chats.setTyping"]);
    const row = await db.getCommand("type-1");
    expect(["expired", "cancelled", "failed"]).toContain(row?.status);
  });

  it("gates a dependent send behind its upload completing first", async () => {
    const db = await seededDb();
    await enqueue(db, { commandId: "upload-1", operation: "attachments.upload", args: { fileName: "a.png", artifactId: "art:1" } });
    await enqueue(db, {
      commandId: "send-2", operation: "messages.sendAttachment",
      args: { chat: fx.DIRECT_CHAT, attachmentGuid: "att-pending" },
      semanticKey: semanticKeyFor({ outputKind: "tool", toolCallId: "send-2" }),
      dependsOn: ["upload-1"],
    });
    const seen: string[] = [];
    const executor: PhotonCommandExecutor = async (claimed) => {
      seen.push(claimed.commandId);
      return { kind: "acknowledged", result: { guid: "att-1" } };
    };
    await runOnce(db, executor, ["attachments.upload", "messages.sendAttachment"]);
    // The upload runs first (or alone); the dependent send may run only after.
    expect(seen.indexOf("upload-1")).not.toBe(-1);
    if (seen.includes("send-2")) {
      expect(seen.indexOf("upload-1")).toBeLessThan(seen.indexOf("send-2"));
    } else {
      expect((await db.getCommand("send-2"))?.status).toBe("queued");
    }
  });

  it("passes the persisted providerKey as the clientMessageId for keyed ops", async () => {
    const db = await seededDb();
    await enqueue(db, { commandId: "k-1", operation: "polls.vote" });
    expect(KEYED_OPERATIONS.has("polls.vote")).toBe(true);
    const executor: PhotonCommandExecutor = async (claimed) => {
      expect(claimed.providerKey).toBe(providerKeyFor("k-1", 0));
      return { kind: "acknowledged" };
    };
    await runOnce(db, executor, ["polls.vote"]);
    expect((await db.getCommand("k-1"))?.status).toBe("acknowledged");
  });
});
