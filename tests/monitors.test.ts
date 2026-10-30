import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "standardwebhooks";
import { MonitorService } from "../server/monitors/service";
import { MonitorStore } from "../server/monitors/store";
import { type Destination, type Owner } from "../server/monitors/config";
import { type MonitorProvider } from "../server/monitors/provider";

const databaseUrl = process.env.TEST_MONITOR_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_MONITOR_DATABASE_URL is required in CI");
const owner: Owner = { issuer: "linq", id: "linq:sender" };
const destination: Destination = { chat: "chat-1", sender: "+12025550123", line: "+12025550100" };
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const detected = { event_type: "event_stream", event_id: "event-1", event_group_id: "group-1", event_date: "2026-10-30", output: { type: "text", content: "A new public release.", basis: [{ citations: [{ url: "https://example.com/release" }] }] } };

describe.skipIf(!databaseUrl)("Persistent Parallel watches", () => {
  const schema = `monitor_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, store: MonitorStore, service: MonitorService;
  let provider: MonitorProvider;
  let send: ReturnType<typeof vi.fn<(destination: Destination, text: string, key: string) => Promise<string>>>;
  let remote: { monitor_id: string; status: string; metadata: { bell_watch_id: string } }[];
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
    await pool.query(await readFile(new URL("../migrations/004_parallel_monitors.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE bell_monitor_jobs, bell_monitor_events, bell_monitor_inbox, bell_monitors CASCADE");
    vi.stubEnv("DATABASE_URL", databaseUrl!);
    vi.stubEnv("PARALLEL_API_KEY", "test");
    vi.stubEnv("PARALLEL_WEBHOOK_SECRET", secret);
    vi.stubEnv("CRON_SECRET", "worker-secret");
    vi.stubEnv("LINQ_API_KEY", "test");
    vi.stubEnv("BELL_PUBLIC_URL", "https://bell.example.com");
    vi.stubEnv("BELL_LINQ_PHONE_NUMBER", destination.line);
    vi.stubEnv("BELL_LINQ_ALLOWED_SENDERS", destination.sender);
    remote = [];
    provider = {
      create: vi.fn(async (_query, id) => {
        const result = { monitor_id: `monitor-${id}`, status: "active", metadata: { bell_watch_id: id } };
        remote.push(result); return result;
      }),
      list: vi.fn(async () => ({ monitors: remote, next_cursor: null })),
      events: vi.fn(async () => ({ events: [detected], next_cursor: null })),
      cancel: vi.fn(async id => { remote.find(m => m.monitor_id === id)!.status = "cancelled"; }),
    };
    send = vi.fn(async () => "accepted-message");
    store = new MonitorStore(pool);
    service = new MonitorService(store, provider, send);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  const create = (operation = "session/call") => service.create(owner, destination, operation, "Watch public product releases");
  async function callback(id: string, webhookId = randomUUID()) {
    const body = JSON.stringify({ type: "monitor.event.detected", timestamp: new Date().toISOString(), data: { monitor_id: `monitor-${id}`, event: { event_group_id: "group-1" }, metadata: { bell_watch_id: id } } });
    const timestamp = new Date();
    return service.ingest(body, { "webhook-id": webhookId, "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)), "webhook-signature": new Webhook(secret).sign(webhookId, timestamp, body) });
  }
  it("deduplicates concurrent creation, scopes ownership, and rejects changed replay input", async () => {
    const [a, b] = await Promise.all([create(), create()]);
    expect(a.id).toBe(b.id);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(await service.list({ issuer: "linq", id: "linq:other" })).toEqual([]);
    await expect(service.stop({ issuer: "linq", id: "linq:other" }, a.id)).rejects.toThrow("Watch not found");
    await expect(service.create(owner, destination, "session/call", "Changed query")).rejects.toThrow("different input");
  });
  it("reconciles an accepted creation with a lost response without another create", async () => {
    const original = provider.create;
    provider.create = vi.fn(async (query, id, origin) => { await original(query, id, origin); throw new Error("response lost"); });
    const watch = await create();
    expect(watch.status).toBe("uncertain");
    await create();
    await service.process();
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect((await service.list(owner))[0].status).toBe("active");
  });
  it("delivers a signed event after service replacement without an Eve session, once across workers", async () => {
    const watch = await create();
    const webhookId = randomUUID();
    await callback(watch.id, webhookId);
    await callback(watch.id, webhookId);
    service = new MonitorService(new MonitorStore(pool), provider, send);
    await Promise.all([service.process(), service.process()]);
    await service.process();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual(destination);
    expect(send.mock.calls[0][1]).toContain("https://example.com/release");
    expect((await service.list(owner))[0].updates).toHaveLength(1);
  });
  it("reuses frozen delivery and key after an accepted send loses its response", async () => {
    const watch = await create(); await callback(watch.id);
    send.mockRejectedValueOnce(new Error("response lost"));
    await service.process();
    await pool.query("UPDATE bell_monitor_jobs SET next_at=now() WHERE kind='send'");
    await service.process();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  });
  it("stops queued deliveries and cancels without webhook or messaging configuration", async () => {
    const watch = await create(); await callback(watch.id);
    vi.stubEnv("LINQ_API_KEY", ""); vi.stubEnv("PARALLEL_WEBHOOK_SECRET", "");
    await service.stop(owner, watch.id); await service.process();
    expect(send).not.toHaveBeenCalled();
    expect(provider.cancel).toHaveBeenCalledWith(`monitor-${watch.id}`);
    expect((await service.list(owner))[0].status).toBe("cancelled");
  });
  it("suppresses delivery when the sender is removed from the allowlist", async () => {
    const watch = await create(); await callback(watch.id);
    vi.stubEnv("BELL_LINQ_ALLOWED_SENDERS", "");
    await service.process();
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects forged and stale signatures without durable ingestion", async () => {
    await expect(service.ingest("{}", { "webhook-id": "fake", "webhook-timestamp": "0", "webhook-signature": "v1,fake" })).rejects.toThrow();
    const date = new Date(Date.now() - 600_000), body = "{}";
    await expect(service.ingest(body, { "webhook-id": "old", "webhook-timestamp": String(Math.floor(date.getTime()/1000)), "webhook-signature": new Webhook(secret).sign("old", date, body) })).rejects.toThrow();
    expect((await pool.query("SELECT * FROM bell_monitor_inbox")).rowCount).toBe(0);
  });
  it("records completion and errors without event IDs and does not send health messages", async () => {
    await create();
    provider.events = vi.fn(async () => ({ events: [{ event_type: "completion", timestamp: "2026-10-30T12:00:00Z" }, { event_type: "error", timestamp: "2026-10-29T12:00:00Z", error_message: "quota" }], next_cursor: null }));
    await service.process();
    expect(send).not.toHaveBeenCalled();
    const [watch] = await service.list(owner);
    expect(watch.health).toBe("completed");
  });
  it("never redispatches creation after a crash at the dispatch boundary", async () => {
    const watch = await store.prepare(owner, destination, "crashed", "Watch public releases");
    expect(await store.dispatch(watch.id)).toBe(true);
    await pool.query("UPDATE bell_monitor_jobs SET next_at=now()");
    await service.create(owner, destination, "crashed", "Watch public releases");
    await service.process();
    expect(provider.create).not.toHaveBeenCalled();
    expect((await store.get(watch.id)).remote_id).toBeNull();
  });
  it("cancels an uncertain remote creation when stop arrives before reconciliation", async () => {
    const original = provider.create;
    provider.create = vi.fn(async (query, id, origin) => { await original(query, id, origin); throw new Error("lost"); });
    const watch = await create();
    await service.stop(owner, watch.id);
    await service.process();
    expect(remote[0].status).toBe("cancelled");
    expect((await service.list(owner))[0].status).toBe("cancelled");
    expect(send).not.toHaveBeenCalled();
  });
  it("retains an early callback until remote identity can be verified", async () => {
    const original = provider.create;
    provider.create = vi.fn(async (query, id, origin) => {
      await callback(id);
      await service.process();
      return original(query, id, origin);
    });
    await create();
    await pool.query("UPDATE bell_monitor_jobs SET next_at=now()");
    await service.process();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("resumes an expired delivery lease with the same frozen payload", async () => {
    const watch = await create();
    await callback(watch.id);
    send.mockRejectedValueOnce(new Error("interrupted"));
    await service.process();
    await pool.query("UPDATE bell_monitor_jobs SET next_at=now(),lease_until=now()-interval '1 minute',lease_token=$1 WHERE kind='send'", [randomUUID()]);
    await new MonitorService(new MonitorStore(pool), provider, send).process();
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  });
  it("records local suppression when the provider key is missing", async () => {
    const watch = await create();
    vi.stubEnv("PARALLEL_API_KEY", "");
    provider.cancel = vi.fn(async () => { throw new Error("missing key"); });
    expect((await service.stop(owner, watch.id)).status).toBe("cancel_pending");
    await service.process();
    expect((await store.get(watch.id)).stopped).toBe(true);
    expect((await service.list(owner))[0].problems).not.toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
  it("surfaces lost history and handles overlapping pages without duplicate sends", async () => {
    const watch = await create();
    await service.process();
    await pool.query("UPDATE bell_monitors SET next_scan_at=now() WHERE id=$1", [watch.id]);
    const newer = { ...detected, event_id: "event-2", event_group_id: "group-2" };
    provider.events = vi.fn(async (_id, _group, cursor) => cursor ? { events: [newer], next_cursor: null } : { events: [newer], next_cursor: "page-2" });
    await service.process();
    expect(send).toHaveBeenCalledTimes(2);
    expect((await service.list(owner))[0].recovery_gap).toBe(true);
  });
  it("keeps valid citations when another URL is unsafe", async () => {
    await create();
    provider.events = vi.fn(async () => ({ events: [{ ...detected, output: { ...detected.output, basis: [{ citations: [{ url: "http://localhost/private" }, { url: "https://example.com/release" }] }] } }], next_cursor: null }));
    await service.process();
    expect(send.mock.calls[0][1]).toContain("https://example.com/release");
    expect(send.mock.calls[0][1]).not.toContain("localhost");
  });
  it("does not adopt an unrelated account callback", async () => {
    await callback(randomUUID());
    await service.process();
    expect(provider.events).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

});
