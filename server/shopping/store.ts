import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { MonitorStore } from "../monitors/store";
import type { Destination, Owner } from "../monitors/config";
import { digest, priceCheckHours } from "./config";
import { normalized, type Observation, type SavedWatchTerms, type WatchTerms } from "./evidence";

export type Queryable = Pool | PoolClient;
export interface Inbound {
  owner: Owner;
  destination: Destination;
  messageId: string;
  sentAt?: string;
}
export interface PriceWatch {
  id: string;
  destination: Destination;
  terms: SavedWatchTerms;
  identity: string;
  credential_fingerprint: string;
  status: "active" | "degraded" | "reserved" | "uncertain" | "accepted" | "stopped" | "expired" | "opted_out" | "failed";
  expires_at: Date;
  alert: Observation | null;
  alert_body: string | null;
  dispatch_at: Date | null;
  delivery_status: string | null;
}
export interface PriceJob {
  id: string; kind: "observe" | "send"; target: string;
  lease_token: string; attempts: number;
}

export const open = "('active','degraded','reserved','uncertain')";
export const watching = "('active','degraded')";
type PriceAction = { name: "enroll"; request: WatchTerms } | { name: "stop"; request: { id: string } };
const actionParams = (inbound: Inbound, action: PriceAction) => [
  inbound.owner.issuer, inbound.owner.id, inbound.destination.chat, inbound.destination.line, inbound.messageId,
  action.name, action.request,
];
const actionScope = `issuer=$1 AND owner_id=$2 AND chat=$3 AND line=$4 AND message_id=$5 AND action=$6
  AND operation_key=bell_price_operation_key($6,$7)`;

export async function storageReady(db: Queryable) {
  const result = await db.query<{ present: boolean }>("SELECT to_regclass('bell_price_jobs') IS NOT NULL AS present");
  return result.rows[0].present;
}

export async function enqueue(db: Queryable, kind: PriceJob["kind"], target: string) {
  await db.query(`INSERT INTO bell_price_jobs(id,kind,target) VALUES ($1,$2,$3)
    ON CONFLICT DO NOTHING`, [`${kind}:${target}`, kind, target]);
}

const liveClaim = "id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()";

export async function lockClaim(db: Queryable, job: PriceJob) {
  return !!(await db.query(`SELECT id FROM bell_price_jobs WHERE ${liveClaim} FOR UPDATE`, [job.id, job.lease_token])).rowCount;
}

export const lockEnrollment = (db: Queryable, key: string) =>
  db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);

export async function rememberAction(db: Queryable, inbound: Inbound, action: PriceAction) {
  await db.query(`INSERT INTO bell_price_actions(issuer,owner_id,chat,line,message_id,action,request)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, actionParams(inbound, action));
  return lockAction(db, inbound, action);
}

export async function lockAction(db: Queryable, inbound: Inbound, action: PriceAction) {
  return (await db.query<{ request: unknown; outcome: unknown }>(`SELECT request,outcome FROM bell_price_actions
    WHERE ${actionScope} FOR UPDATE`, actionParams(inbound, action))).rows[0];
}

export function saveActionOutcome(db: Queryable, inbound: Inbound, action: PriceAction, outcome: unknown) {
  return db.query(`UPDATE bell_price_actions SET outcome=$8 WHERE ${actionScope}`, [...actionParams(inbound, action), outcome]);
}

export function equivalentWatch(inbound: Inbound, terms: WatchTerms, identity: string) {
  const parts = [inbound.destination, identity, terms.url ?? null, terms.country, terms.currency,
    terms.amount.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "").replace(/^0+(?=\d)/, ""), terms.comparison,
    terms.condition, terms.seller ? normalized(terms.seller) : null];
  const variant = terms.variant ? normalized(terms.variant) : null;
  return digest(JSON.stringify([...parts, variant]));
}

export function offerId(item: Observation) {
  return digest(JSON.stringify([item.url, item.country, item.identity, item.variant, normalized(item.seller), item.condition, item.currency]));
}

export async function storedObservation(db: Queryable, id: string) {
  return (await db.query<{ observation: Observation }>("SELECT observation FROM bell_price_offers WHERE id=$1", [id]))
    .rows[0]?.observation;
}

export async function attachOffer(db: Queryable, watchId: string, item: Observation) {
  const id = offerId(item);
  await db.query(`INSERT INTO bell_price_offers(id,observation,next_at,verified_at)
    VALUES ($1,$2,$3::timestamptz+$4::int*interval '1 hour',$3)
    ON CONFLICT (id) DO UPDATE SET observation=excluded.observation,verified_at=excluded.verified_at
      WHERE bell_price_offers.verified_at<excluded.verified_at`,
  [id, item, new Date(item.observedAt), priceCheckHours]);
  await db.query("INSERT INTO bell_price_subscriptions(watch_id,offer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [watchId, id]);
}

export async function detach(db: Queryable, watchId: string) {
  await db.query("DELETE FROM bell_price_subscriptions WHERE watch_id=$1", [watchId]);
}

export async function claimPriceJob(db: Queryable) {
  return (await db.query<PriceJob>(`UPDATE bell_price_jobs SET lease_until=clock_timestamp()+interval '45 seconds',lease_token=$1,attempts=attempts+1 WHERE id=(
    SELECT id FROM bell_price_jobs WHERE kind IN ('observe','send') AND NOT failed AND next_at<=clock_timestamp()
      AND (lease_until IS NULL OR lease_until<clock_timestamp())
    ORDER BY (kind='send') DESC,next_at
    FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [randomUUID()])).rows[0];
}

export async function finishPriceJob(db: Queryable, job: PriceJob) {
  return !!(await db.query(`DELETE FROM bell_price_jobs WHERE ${liveClaim}`, [job.id, job.lease_token])).rowCount;
}

export async function retryPriceJob(store: MonitorStore, job: PriceJob, next: { delay: number; error?: string }) {
  await store.transaction(async db => {
    const result = await db.query<{ failed: boolean }>(`UPDATE bell_price_jobs SET next_at=clock_timestamp()+$3*interval '1 millisecond',
      lease_until=NULL,lease_token=NULL,last_error=$4,failed=$4::text IS NOT NULL AND attempts>=8,
      attempts=CASE WHEN $4::text IS NULL THEN 0 ELSE attempts END WHERE ${liveClaim} RETURNING failed`,
    [job.id, job.lease_token, next.delay, next.error ?? null]);
    if (job.kind === "send" && result.rows[0]?.failed) {
      const watch = await db.query(`UPDATE bell_price_watches SET status='failed',
        delivery_status=CASE WHEN dispatch_at IS NULL THEN 'not_sent' ELSE 'unresolved' END
        WHERE id=$1 AND status IN ('reserved','uncertain') AND delivery_status IS NULL`, [job.target]);
      if (watch.rowCount) await detach(db, job.target);
    }
  });
}
