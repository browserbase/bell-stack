import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hash } from "../server/encrypted-record";
import { notionOwner } from "../server/notion/config";
import { NotionOAuth } from "../server/notion/oauth";
import { NotionStore } from "../server/notion/store";

const databaseUrl = process.env.TEST_NOTION_DATABASE_URL ?? process.env.TEST_LINK_DATABASE_URL;
const principal = { type: "user" as const, issuer: "linq", id: "linq:operator" };
const owner = notionOwner(principal);
const callbackUrl = "https://bell.example/eve/v1/connections/notion/callback/attempt/capability";
const metadata = { issuer: "https://mcp.notion.com", authorization_endpoint: "https://mcp.notion.com/authorize",
  token_endpoint: "https://mcp.notion.com/token", registration_endpoint: "https://mcp.notion.com/register",
  revocation_endpoint: "https://mcp.notion.com/token" };

describe.skipIf(!databaseUrl)("Notion PostgreSQL storage", () => {
  const schema = `notion_test_${randomUUID().replaceAll("-", "")}`;
  const key = Buffer.alloc(32, 7);
  let admin: Pool;
  let pool: Pool;
  let store: NotionStore;
  let oauth: NotionOAuth;
  let now: number;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  const config = { origin: "https://bell.example", redirectUri: "https://bell.example/api/notion/oauth/callback", databaseUrl: databaseUrl!, key };

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
    await pool.query(await readFile(new URL("../migrations/004_notion.sql", import.meta.url), "utf8"));
    store = new NotionStore(pool, key);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE bell_notion_connections");
    now = 1_000_000;
    fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("oauth-authorization-server")) return Response.json(metadata);
      if (String(input).endsWith("/register")) return Response.json({ client_id: "private-client" });
      const fields = new URLSearchParams(String(init?.body));
      if (fields.has("token")) return new Response(null, { status: 200 });
      return Response.json({ access_token: "private-access", refresh_token: "private-refresh", token_type: "Bearer", expires_in: 3600 });
    });
    oauth = new NotionOAuth(config, store, fetcher, () => now);
  });

  async function authorize() {
    const start = await oauth.start(principal, callbackUrl);
    const state = new URL(start.challenge.url).searchParams.get("state")!;
    const params = { state, code: "private-code" };
    await oauth.forward(params);
    await oauth.complete(principal, callbackUrl, start.resume, params);
    return params;
  }

  it("encrypts durable credentials and consent capabilities, then recovers them in a fresh service", async () => {
    const params = await authorize();
    const row = (await pool.query("SELECT encrypted_state, state_hash FROM bell_notion_connections")).rows[0];
    expect(row.state_hash).toBe(hash(params.state));
    for (const secret of ["private-access", "private-refresh", "private-client", callbackUrl, params.state])
      expect(row.encrypted_state).not.toContain(secret);
    const restarted = new NotionOAuth(config, new NotionStore(pool, key), fetcher, () => now);
    expect(await restarted.getToken(principal)).toMatchObject({ token: "private-access" });
    await expect(restarted.getToken({ ...principal, id: "linq:other" })).rejects.toThrow();
  });

  it("binds encrypted rows to their owner and rejects a different encryption key", async () => {
    await authorize();
    await pool.query("UPDATE bell_notion_connections SET owner = $1 WHERE owner = $2", ["another-owner", owner]);
    await expect(store.withOwner("another-owner", async db => db.value)).rejects.toThrow();
    await pool.query("UPDATE bell_notion_connections SET owner = $1", [owner]);
    const wrongKey = new NotionStore(pool, Buffer.alloc(32, 8));
    await expect(wrongKey.withOwner(owner, async db => db.value)).rejects.toThrow();
  });

  it("serializes concurrent refreshes across independent service instances", async () => {
    await authorize();
    now += 3_600_000;
    const instances = Array.from({ length: 4 }, () => new NotionOAuth(config, new NotionStore(pool, key), fetcher, () => now));
    const results = await Promise.all(instances.map(instance => instance.getToken(principal)));
    expect(results.every(result => result.token === "private-access")).toBe(true);
    const refreshes = fetcher.mock.calls.filter(([, init]) => new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(1);
  });

  it("persists a failed revocation as blocked and invalidates callbacks across restarts", async () => {
    const params = await authorize();
    fetcher.mockImplementation(async input => String(input).endsWith("/token")
      ? new Response(null, { status: 503 }) : Response.json(metadata));
    await expect(oauth.disconnect(principal)).rejects.toThrow();
    const restarted = new NotionOAuth(config, new NotionStore(pool, key), fetcher, () => now);
    expect(await restarted.status(principal)).toMatchObject({ status: "disconnect_pending" });
    await expect(restarted.getToken(principal)).rejects.toThrow();
    await expect(restarted.forward(params)).rejects.toThrow();
    fetcher.mockImplementation(async input => String(input).endsWith("/token")
      ? new Response(null, { status: 200 }) : Response.json(metadata));
    expect(await restarted.disconnect(principal)).toEqual({ status: "disconnected" });
    expect((await restarted.status(principal)).status).toBe("disconnected");
  });
});
