import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withAdvisoryLock } from "../server/postgres";

function client(queries: Array<(sql: string) => unknown> = []) {
  const query = vi.fn(async (sql: string) => {
    const next = queries.shift();
    if (next) return next(sql);
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  return { query, release } as unknown as PoolClient & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
}

function poolFor(connection: PoolClient): Pool {
  return { connect: async () => connection } as unknown as Pool;
}

describe("advisory lock", () => {
  it("runs the operation between the lock and unlock, then returns the client", async () => {
    const connection = client();
    const result = await withAdvisoryLock(poolFor(connection), "owner", async () => "done");
    expect(result).toBe("done");
    expect(connection.query.mock.calls.map((call) => call[0])).toEqual([
      "SET statement_timeout = '30s'",
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
    ]);
    expect(connection.query.mock.calls[1][1]).toEqual(["owner"]);
    expect(connection.release).toHaveBeenCalledWith(false);
  });

  it("destroys the client when the lock is never acquired", async () => {
    const connection = client([
      () => ({ rows: [] }),
      () => { throw new Error("lock failed"); },
    ]);
    await expect(withAdvisoryLock(poolFor(connection), "owner", async () => "done")).rejects.toThrow("lock failed");
    expect(connection.release).toHaveBeenCalledWith(true);
    expect(connection.query.mock.calls.map((call) => call[0])).toEqual([
      "SET statement_timeout = '30s'",
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
    ]);
  });

  it("destroys the client when unlock fails after the operation", async () => {
    const connection = client([
      () => ({ rows: [] }),
      () => ({ rows: [] }),
      () => { throw new Error("unlock failed"); },
    ]);
    await expect(withAdvisoryLock(poolFor(connection), "owner", async () => "done")).resolves.toBe("done");
    expect(connection.release).toHaveBeenCalledWith(true);
  });
});
