import { Pool, type PoolClient, type PoolConfig } from "pg";

export function createPool(connectionString: string, label: string, options: PoolConfig = {}): Pool {
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ...options,
  });
  pool.on("error", () => console.error(`${label} database connection failed.`));
  return pool;
}

/** Hold a session advisory lock. A failed lock or unlock destroys the client instead of returning it to the pool. */
export async function withAdvisoryLock<T>(pool: Pool, key: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let destroy = false;
  try {
    await client.query("SET statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    locked = true;
    return await operation(client);
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      } catch {
        destroy = true;
      }
    } else destroy = true;
    client.release(destroy);
  }
}
