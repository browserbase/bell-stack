import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { type Destination, type Owner, required } from "./config";

export interface Watch {
  id: string; issuer: string; owner_id: string; operation: string; query: string; creation_frequency: string; frequency: string; pending_frequency: string | null; destination: Destination;
  remote_id: string | null; status: string; stopped: boolean; health: string | null; health_at: Date | null;
  created_at: Date; last_scan_at: Date | null; scan_anchor: string | null; recovery_gap: boolean;
}
export interface Job { id: string; watch_id: string | null; kind: string; payload: Record<string, unknown>; attempts: number; lease_token: string }
export class MonitorStore {
  constructor(readonly pool: Pool) {}
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const value = await fn(client); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async prepare(owner: Owner, destination: Destination, operation: string, query: string, frequency = "1d"): Promise<Watch> {
    await this.pool.query("INSERT INTO bell_monitors (id,issuer,owner_id,operation,query,destination,status,creation_frequency,frequency) VALUES ($1,$2,$3,$4,$5,$6,'prepared',$7,$7) ON CONFLICT (issuer,owner_id,operation) DO NOTHING", [randomUUID(), owner.issuer, owner.id, operation, query, destination, frequency]);
    const watch = (await this.pool.query<Watch>("SELECT * FROM bell_monitors WHERE issuer=$1 AND owner_id=$2 AND operation=$3", [owner.issuer, owner.id, operation])).rows[0];
    if (watch.creation_frequency !== frequency || watch.query !== query || watch.destination.chat !== destination.chat || watch.destination.sender !== destination.sender || watch.destination.line !== destination.line) throw new Error("Watch operation has different input.");
    return watch;
  }
  async get(id: string): Promise<Watch> {
    const watch = (await this.pool.query<Watch>("SELECT * FROM bell_monitors WHERE id=$1", [id])).rows[0];
    if (!watch) throw new Error("Watch not found."); return watch;
  }
  async enqueue(kind: string, id: string, watchId: string | null, payload: Record<string, unknown> = {}, client: Pool | PoolClient = this.pool) {
    await client.query("INSERT INTO bell_monitor_jobs (id,watch_id,kind,payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [id, watchId, kind, payload]);
  }
  async dispatch(id: string): Promise<boolean> {
    return this.transaction(async client => {
      const result = await client.query("UPDATE bell_monitors SET status='dispatched' WHERE id=$1 AND status='prepared' AND NOT stopped RETURNING id", [id]);
      if (!result.rowCount) return false;
      await this.enqueue("reconcile", `reconcile:${id}`, id, {}, client);
      await client.query("UPDATE bell_monitor_jobs SET next_at=now()+interval '1 minute' WHERE id=$1", [`reconcile:${id}`]);
      return true;
    });
  }
  async bind(id: string, remoteId: string, cancelled = false, frequency = "1d") {
    await this.transaction(async client => {
      const watch = (await client.query<Watch>("SELECT * FROM bell_monitors WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (watch.remote_id) {
        if (watch.remote_id !== remoteId) throw new Error("Conflicting monitor identity");
        return;
      }
      await client.query("UPDATE bell_monitors SET remote_id=$2,status=$3,frequency=$4 WHERE id=$1", [id, remoteId, cancelled ? "cancelled" : watch.stopped ? "cancel_pending" : "active", frequency]);
      if (watch.stopped && !cancelled) await this.enqueue("cancel", `cancel:${id}`, id, {}, client);
    });
  }
  async stop(owner: Owner, id: string) {
    await this.transaction(async client => {
      const watch = (await client.query<Watch>("SELECT * FROM bell_monitors WHERE id=$1 AND issuer=$2 AND owner_id=$3 FOR UPDATE", [id, owner.issuer, owner.id])).rows[0];
      if (!watch) throw new Error("Watch not found.");
      const localOnly = watch.status === "prepared" || watch.status === "failed";
      await client.query("UPDATE bell_monitors SET stopped=true,pending_frequency=NULL,status=$2 WHERE id=$1", [id, watch.status === "cancelled" || localOnly ? "cancelled" : "cancel_pending"]);
      await client.query("DELETE FROM bell_monitor_jobs WHERE watch_id=$1 AND kind IN ('send','update') AND lease_until IS NULL", [id]);
      if (watch.remote_id && watch.status !== "cancelled") await this.enqueue("cancel", `cancel:${id}`, id, {}, client);
    });
  }
  async requestFrequency(owner: Owner, id: string, frequency: string): Promise<Watch> {
    return this.transaction(async client => {
      const watch = (await client.query<Watch>("SELECT * FROM bell_monitors WHERE id=$1 AND issuer=$2 AND owner_id=$3 FOR UPDATE", [id, owner.issuer, owner.id])).rows[0];
      if (!watch) throw new Error("Watch not found.");
      if (watch.stopped || watch.status !== "active" || !watch.remote_id) throw new Error("Watch operation requires an active watch.");
      if (watch.pending_frequency) {
        if (watch.pending_frequency !== frequency) throw new Error("Watch operation has a pending frequency change. List watches before requesting another change.");
        return watch;
      }
      if (watch.frequency === frequency) return watch;
      await client.query("UPDATE bell_monitors SET pending_frequency=$2 WHERE id=$1", [id, frequency]);
      await this.enqueue("update", `update:${id}:${randomUUID()}`, id, { frequency }, client);
      return { ...watch, pending_frequency: frequency };
    });
  }
  async applyFrequency(id: string, frequency: string, update: (remoteId: string) => Promise<string>) {
    await this.transaction(async client => {
      const watch = (await client.query<Watch>("SELECT * FROM bell_monitors WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!watch || watch.stopped || watch.status !== "active" || !watch.remote_id || watch.pending_frequency !== frequency) return;
      const confirmed = await update(watch.remote_id);
      await client.query("UPDATE bell_monitors SET frequency=$2,pending_frequency=NULL WHERE id=$1", [id, confirmed]);
    });
  }
  async deliver(id: string, eventId: string, send: (watch: Watch) => Promise<string>) {
    await this.transaction(async client => {
      // Share stop's row lock through dispatch so suppression cannot race a stale read.
      const watch = (await client.query<Watch>("SELECT * FROM bell_monitors WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!watch || watch.stopped || watch.status !== "active") return;
      const accepted = await send(watch);
      await client.query("UPDATE bell_monitor_events SET payload=jsonb_set(payload,'{delivery}', $3::jsonb) WHERE watch_id=$1 AND event_id=$2", [id, eventId, JSON.stringify({ status: "accepted", message_id: accepted })]);
    });
  }
  async list(owner: Owner) {
    return (await this.pool.query<Watch & { updates: unknown[]; problems: unknown[] }>(`SELECT w.*, COALESCE((SELECT jsonb_agg(e.payload) FROM (SELECT payload FROM bell_monitor_events WHERE watch_id=w.id ORDER BY received_at DESC LIMIT 5) e),'[]') AS updates,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',kind,'error',last_error,'failed',failed)) FROM bell_monitor_jobs WHERE watch_id=w.id AND last_error IS NOT NULL),'[]') AS problems
      FROM bell_monitors w WHERE issuer=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 50`, [owner.issuer, owner.id])).rows;
  }
  async claim(): Promise<Job | undefined> {
    return (await this.pool.query<Job>(`UPDATE bell_monitor_jobs SET lease_until=now()+interval '60 seconds',lease_token=$1,attempts=attempts+1 WHERE id=(
      SELECT id FROM bell_monitor_jobs WHERE NOT failed AND next_at<=now() AND (lease_until IS NULL OR lease_until<now())
      ORDER BY CASE kind WHEN 'cancel' THEN 0 WHEN 'inbox' THEN 1 WHEN 'send' THEN 2 ELSE 3 END,next_at
      FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [randomUUID()])).rows[0];
  }
  async finish(job: Job) { await this.pool.query("DELETE FROM bell_monitor_jobs WHERE id=$1 AND lease_token=$2", [job.id, job.lease_token]); }
  async retry(job: Job, reason: string, terminal: boolean, delay: number) {
    await this.pool.query("UPDATE bell_monitor_jobs SET lease_until=NULL,lease_token=NULL,last_error=$3,failed=$4,next_at=now()+$5*interval '1 millisecond' WHERE id=$1 AND lease_token=$2", [job.id, job.lease_token, reason, terminal || job.attempts >= 8, delay]);
  }
  async schedule() {
    await this.transaction(async client => {
      const watches = (await client.query<{ id: string }>("UPDATE bell_monitors SET next_scan_at=now()+interval '1 hour' WHERE status='active' AND NOT stopped AND next_scan_at<=now() RETURNING id")).rows;
      for (const watch of watches) await this.enqueue("sync", `sync:${watch.id}`, watch.id, {}, client);
    });
  }
  async health(id: string, health: string, timestamp: string) {
    await this.pool.query("UPDATE bell_monitors SET health=$2,health_at=$3 WHERE id=$1 AND (health_at IS NULL OR health_at<$3)", [id, health, timestamp]);
  }
}
let singleton: MonitorStore | undefined;
export function monitorStore(): MonitorStore {
  if (!singleton) {
    const pool = new Pool({ connectionString: required("DATABASE_URL"), max: 5, connectionTimeoutMillis: 3_000, statement_timeout: 5_000 });
    pool.on("error", () => console.error("Monitor database connection failed."));
    singleton = new MonitorStore(pool);
  }
  return singleton;
}
