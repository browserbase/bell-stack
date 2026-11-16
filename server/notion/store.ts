import { Pool } from "pg";
import { hash, seal, unseal } from "../encrypted-record";

export interface Tokens { accessToken: string; refreshToken?: string; expiresAt: number }
export interface Pending {
  id: string;
  state: string;
  verifier: string;
  callbackUrl: string;
  expiresAt: number;
  status: "pending" | "forwarded" | "exchanging" | "completed" | "failed";
  resultHash?: string;
}
export interface NotionState {
  client?: { id: string; secret?: string; redirectUri: string };
  status?: "active" | "reconnect" | "disconnecting" | "disconnected";
  tokens?: Tokens;
  pending?: Pending;
}
export interface LockedState {
  value: NotionState;
  save(): Promise<void>;
}

export interface NotionPersistence {
  findOwner(stateHash: string): Promise<string | undefined>;
  withOwner<T>(owner: string, operation: (state: LockedState) => Promise<T>): Promise<T>;
}

export class NotionStore implements NotionPersistence {
  constructor(private readonly pool: Pool, private readonly key: Buffer) {}

  async findOwner(stateHash: string): Promise<string | undefined> {
    return (await this.pool.query<{ owner: string }>(
      "SELECT owner FROM bell_notion_connections WHERE state_hash = $1", [stateHash],
    )).rows[0]?.owner;
  }

  async withOwner<T>(owner: string, operation: (state: LockedState) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let locked = false;
    let destroy = false;
    try {
      await client.query("SET statement_timeout = '30s'");
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`notion:${owner}`]);
      locked = true;
      const row = (await client.query<{ encrypted_state: string }>(
        "SELECT encrypted_state FROM bell_notion_connections WHERE owner = $1", [owner],
      )).rows[0];
      const value: NotionState = row ? unseal(row.encrypted_state, this.key, `notion:${owner}`) : {};
      return await operation({ value, save: async () => {
        await client.query(
          `INSERT INTO bell_notion_connections (owner, encrypted_state, state_hash)
           VALUES ($1, $2, $3) ON CONFLICT (owner) DO UPDATE SET
           encrypted_state = EXCLUDED.encrypted_state, state_hash = EXCLUDED.state_hash, updated_at = now()`,
          [owner, seal(value, this.key, `notion:${owner}`), value.pending ? hash(value.pending.state) : null],
        );
      } });
    } finally {
      if (locked) {
        try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`notion:${owner}`]); }
        catch { destroy = true; }
      } else destroy = true;
      client.release(destroy);
    }
  }
}

export function createNotionStore(databaseUrl: string, key: Buffer) {
  const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
  pool.on("error", () => console.error("Notion database connection failed."));
  return new NotionStore(pool, key);
}
