import type { MonitorStore } from "../monitors/store";
import { ProviderError } from "../monitors/provider";
import { priceCheckHours } from "./config";
import { dispatchAlert, reserveAlert } from "./delivery";
import type { sendPriceAlert } from "./providers";
import { qualifies } from "./evidence";
import { claimPriceJob, detach, finishPriceJob, lockClaim, offerId, retryPriceJob, storedObservation, open, watching, type PriceJob, type PriceWatch } from "./store";
import { shoppingSources, type ShoppingSources } from "./watches";

export class PriceWorker {
  constructor(readonly store: MonitorStore, readonly sources: ShoppingSources = shoppingSources,
    readonly send?: typeof sendPriceAlert) {}

  async schedule() {
    await this.store.transaction(async db => {
      const expired = await db.query<{ id: string }>(`SELECT id FROM bell_price_watches
        WHERE status IN ${open} AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 25 FOR UPDATE SKIP LOCKED`);
      for (const { id } of expired.rows) {
        await db.query("UPDATE bell_price_watches SET status='expired' WHERE id=$1", [id]);
        await detach(db, id);
      }
    });
    // Leased jobs remain the sole owner of writes. These inserts are bounded, even during backlog or cutover.
    await this.store.pool.query(`INSERT INTO bell_price_jobs(id,kind,target)
      SELECT 'observe:'||o.id,'observe',o.id FROM bell_price_offers o
      WHERE o.next_at<=clock_timestamp()
        AND EXISTS (SELECT 1 FROM bell_price_subscriptions s JOIN bell_price_watches w ON w.id=s.watch_id
          WHERE s.offer_id=o.id AND w.status IN ${watching} AND w.expires_at>clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM bell_price_jobs j WHERE j.id='observe:'||o.id)
      ORDER BY o.next_at LIMIT 40 ON CONFLICT DO NOTHING`);
  }

  async runOne(deadline: number) {
    if (deadline - Date.now() < 1200) return false;
    const job = await claimPriceJob(this.store.pool);
    if (!job) return false;
    try {
      const signal = AbortSignal.timeout(Math.min(15_000, Math.max(1, deadline - Date.now())));
      const next = await this.run(job, signal);
      if (next) await retryPriceJob(this.store, job, next);
      else await finishPriceJob(this.store.pool, job);
    } catch (error) {
      const delay = Math.max(error instanceof ProviderError ? error.retryAfter : 0, Math.min(3_600_000, 1000 * 2 ** job.attempts));
      if (job.kind === "observe") {
        await this.store.transaction(async db => {
          if (!await lockClaim(db, job)) return;
          await db.query(`UPDATE bell_price_watches SET status='degraded' WHERE status='active'
            AND id IN (SELECT watch_id FROM bell_price_subscriptions WHERE offer_id=$1)`, [job.target]);
          if (job.attempts >= 8) {
            await db.query("UPDATE bell_price_offers SET next_at=clock_timestamp()+$2*interval '1 hour' WHERE id=$1", [job.target, priceCheckHours]);
          }
        });
        if (job.attempts >= 8) {
          await finishPriceJob(this.store.pool, job);
          return true;
        }
      }
      await retryPriceJob(this.store, job, { delay, error: error instanceof ProviderError ? `provider_http_${error.status}` : "price_job_failed" });
      console.warn("bell_price_job_failed", { kind: job.kind, attempts: job.attempts });
    }
    return true;
  }

  private run(job: PriceJob, signal: AbortSignal) {
    return job.kind === "send" ? dispatchAlert(this.store, job, this.sources, signal, this.send) : this.observe(job, signal);
  }

  private async observe(job: PriceJob, signal: AbortSignal) {
    const offer = await storedObservation(this.store.pool, job.target);
    if (!offer) return;
    const item = await this.sources.verify(offer.url, offer.country, signal);
    if (!item || offerId(item) !== job.target || item.expiresAt <= Date.now()) throw new Error("Listing evidence is unavailable");

    await this.store.transaction(async db => {
      if (!await lockClaim(db, job)) return;
      const watched = await db.query<PriceWatch>(`SELECT w.* FROM bell_price_watches w JOIN bell_price_subscriptions s ON s.watch_id=w.id
        WHERE s.offer_id=$1 AND w.status IN ${watching} AND expires_at>clock_timestamp() ORDER BY w.id FOR UPDATE OF w`, [job.target]);
      const result = await db.query(`UPDATE bell_price_offers SET observation=$2,verified_at=$3,
        next_at=clock_timestamp()+$4*interval '1 hour'
        WHERE id=$1 AND verified_at<=$3`, [job.target, item, new Date(item.observedAt), priceCheckHours]);
      if (!result.rowCount) return;
      for (const watch of watched.rows) {
        if (qualifies(item, watch.terms)) await reserveAlert(db, watch.id, item);
        else if (watch.status === "degraded") await db.query("UPDATE bell_price_watches SET status='active' WHERE id=$1", [watch.id]);
      }
    });
  }
}
