import type { MonitorStore } from "../monitors/store";
import { allowed } from "../monitors/config";
import { ProviderError } from "../monitors/provider";
import { linqFingerprint, priceWatchesEnabled } from "./config";
import { displayPrice, qualifies, sameOffer, type Observation, type SavedWatchTerms } from "./evidence";
import { sendPriceAlert } from "./providers";
import { detach, enqueue, finishPriceJob, lockClaim, offerId, storedObservation, type PriceJob, type PriceWatch, type Queryable } from "./store";
import type { ShoppingSources } from "./watches";

export async function reserveAlert(db: Queryable, id: string, item: Observation) {
  const body = `Price alert: ${item.product} (${item.variant}) is in stock at ${item.seller} for ${displayPrice(item.amount, item.currency)} before tax and shipping.\n${item.url}`;
  const result = await db.query(`UPDATE bell_price_watches SET status='reserved', alert=$2, alert_body=$3
    WHERE id=$1 AND status IN ('active','degraded') AND expires_at>clock_timestamp() RETURNING id`, [id, item, body]);
  if (result.rowCount) await enqueue(db, "send", id);
}

async function lockedWatch(db: Queryable, job: PriceJob) {
  if (!await lockClaim(db, job)) return undefined;
  return (await db.query<PriceWatch>("SELECT * FROM bell_price_watches WHERE id=$1 FOR UPDATE", [job.target])).rows[0];
}

async function releaseInvalidAlert(db: Queryable, job: PriceJob, mayHaveSent: boolean) {
  if (mayHaveSent) {
    await db.query("UPDATE bell_price_watches SET status='failed',delivery_status='unresolved' WHERE id=$1", [job.target]);
    await detach(db, job.target);
    return;
  }
  // Retire this lease in the same transaction so the next match can enqueue its own send.
  if (!await finishPriceJob(db, job)) return;
  await db.query("UPDATE bell_price_watches SET status='active',alert=NULL,alert_body=NULL,dispatch_at=NULL WHERE id=$1", [job.target]);
  await db.query(`UPDATE bell_price_offers SET next_at=clock_timestamp()
    WHERE id IN (SELECT offer_id FROM bell_price_subscriptions WHERE watch_id=$1)`, [job.target]);
}

function confirmsReservedAlert(item: Observation, reserved: Observation, terms: SavedWatchTerms) {
  return item.amount === reserved.amount && sameOffer(item, reserved) && qualifies(item, terms);
}

export async function dispatchAlert(store: MonitorStore, job: PriceJob, sources: ShoppingSources, signal: AbortSignal, send = sendPriceAlert) {
  const current = (await store.pool.query<PriceWatch>("SELECT * FROM bell_price_watches WHERE id=$1", [job.target])).rows[0];
  if (!current?.alert || !current.alert_body || current.delivery_status || !["reserved", "uncertain"].includes(current.status)) return;
  if (current.credential_fingerprint !== linqFingerprint() || !allowed(current.destination)) {
    return { delay: 60_000, error: "linq_destination_unavailable" };
  }
  if (!priceWatchesEnabled()) return { delay: 60_000 };

  const saved = current.alert;
  const verified = saved.expiresAt <= Date.now() || current.dispatch_at
    ? await sources.verify(saved.url, saved.country, signal)
    : saved;
  // Record the attempt before calling Linq so a crash leaves a durable retry marker.
  const readyToSend = await store.transaction(async db => {
    const row = await lockedWatch(db, job);
    if (!row?.alert || !["reserved", "uncertain"].includes(row.status) || row.expires_at.getTime() <= Date.now()) return false;
    if (!verified || !confirmsReservedAlert(verified, saved, row.terms)) {
      await releaseInvalidAlert(db, job, Boolean(row.dispatch_at));
      return false;
    }
    await db.query("UPDATE bell_price_watches SET dispatch_at=COALESCE(dispatch_at,clock_timestamp()),status='uncertain' WHERE id=$1", [row.id]);
    return true;
  });
  if (!readyToSend || !verified) return;

  // Hold the watch lock during the send so cancellation and sending cannot race.
  return store.transaction(async db => {
    const row = await lockedWatch(db, job);
    if (!row?.alert_body || row.status !== "uncertain" || row.expires_at.getTime() <= Date.now()) return;
    if (row.credential_fingerprint !== linqFingerprint() || !allowed(row.destination) ||
        !priceWatchesEnabled() || verified.expiresAt <= Date.now()) return { delay: 60_000 };
    // Another watch may have checked this listing after this alert was reserved.
    const latest = await storedObservation(db, offerId(saved));
    if (latest && latest.observedAt >= verified.observedAt && !confirmsReservedAlert(latest, saved, row.terms)) {
      // Only an earlier attempt could have sent this alert.
      await releaseInvalidAlert(db, job, Boolean(current.dispatch_at));
      return;
    }
    try {
      const result = await send(row.destination, row.alert_body, `bell-price-${row.id}`, signal);
      const confirmed = result.state === "uncertain" ? null : result;
      await db.query("UPDATE bell_price_watches SET status=$2,message_id=$3,delivery_status=$4 WHERE id=$1",
        [row.id, confirmed?.state ?? "failed", confirmed?.messageId ?? null, confirmed?.status ?? "unresolved"]);
    } catch (error) {
      if (!(error instanceof ProviderError) || ![400, 401, 403, 404, 422].includes(error.status)) throw error;
      await db.query("UPDATE bell_price_watches SET status='failed',delivery_status=$2 WHERE id=$1",
        [row.id, current.dispatch_at ? "unresolved" : `linq_http_${error.status}`]);
    }
    await detach(db, row.id);
  });
}
