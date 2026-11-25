import { randomUUID } from "node:crypto";
import { assertOwner, allowed, destinationSchema, type Destination, type Owner } from "../monitors/config";
import { type MonitorStore, monitorStore, type WatchFilter, watchPageSize } from "../monitors/store";
import { linqFingerprint, priceCheckHours, requirePriceEnrollment } from "./config";
import { identityOf, matchesIdentity, matchesTerms, meetsTarget, normalized, qualifies, resolveVariant, verifyListing, watchTerms, type Observation, type WatchTerms } from "./evidence";
import { discoverListings } from "./search";
import { attachOffer, detach, equivalentWatch, lockAction, lockEnrollment, open, rememberAction, saveActionOutcome, storageReady, type Inbound, type PriceWatch, type Queryable } from "./store";

type Decision = { status: "match" | "at_target_out_of_stock"; offer: Observation }
  | { status: "needs_details"; reason: string } | { status: "enrolled"; id: string };

export type ShoppingSources = { verify: typeof verifyListing; discover: typeof discoverListings };
export const shoppingSources: ShoppingSources = { verify: verifyListing, discover: discoverListings };

function watchSummary(watch: PriceWatch) {
  const isOpen = ["active", "degraded", "reserved", "uncertain"].includes(watch.status);
  const status = isOpen && watch.expires_at.getTime() <= Date.now() ? "expired" : watch.status;
  return { id: `price:${watch.id}`, status, delivery_status: watch.delivery_status, terms: watch.terms,
    expires_at: watch.expires_at.toISOString(), cadence_hours: priceCheckHours };
}

async function readOffers(terms: WatchTerms, sources: ShoppingSources, signal: AbortSignal) {
  const query = [terms.product, terms.variant ?? terms.mpn].filter(Boolean).join(" ");
  const urls = terms.url ? [terms.url] : await sources.discover(query, terms.country, terms.currency, signal);
  const reads = await Promise.allSettled(urls.map(url => sources.verify(url, terms.country, signal)));
  signal.throwIfAborted();
  return reads.flatMap(read => read.status === "fulfilled" && read.value && matchesTerms(read.value, terms) ? [read.value] : []);
}

function identifyOffers(terms: WatchTerms, offers: Observation[]) {
  if (terms.url) return { identity: offers[0]?.identity, resolvedVariant: resolveVariant(offers), offers };
  const explicit = identityOf(terms.gtin, terms.brand, terms.mpn);
  const name = normalized(terms.product ?? "");
  const exact = explicit ? offers : offers.filter(item => normalized(item.product) === name);
  const first = exact[0];
  const identity = explicit ?? (first && [first.identity, first.manufacturerIdentity].find(id =>
    id && !id.startsWith("sku:") && exact.every(item => matchesIdentity(item, id))));
  const resolvedVariant = resolveVariant(exact);
  if (!identity || !resolvedVariant) return { identity: undefined, offers: [] };
  return { identity, resolvedVariant, offers: offers.filter(item => matchesTerms(item, { ...terms, resolvedVariant }, identity)) };
}

function checkDestination(owner: Owner, destination: Destination) {
  assertOwner(owner);
  destinationSchema.parse(destination);
  if (!allowed(destination)) throw new Error("This Linq destination is no longer allowed.");
}

async function decideEnrollment(
  db: Queryable, inbound: Inbound, terms: WatchTerms, resolved: ReturnType<typeof identifyOffers>,
): Promise<Decision> {
  const offers = resolved.offers.filter(offer => offer.expiresAt > Date.now())
    .sort((a, b) => a.amount - b.amount || a.url.localeCompare(b.url));
  const match = offers.find(offer => qualifies(offer, terms));
  if (match) return { status: "match", offer: match };

  const needsDetails = { status: "needs_details", reason: terms.url ? "unverified_listing" : "unresolved_product" } as const;
  if (!resolved.identity || !offers.length) return needsDetails;

  const listingsToWatch = offers.filter(offer => !meetsTarget(offer, terms));
  if (!listingsToWatch.length) return { status: "at_target_out_of_stock", offer: offers[0] };

  const key = equivalentWatch(inbound, terms, resolved.identity);
  await lockEnrollment(db, key);
  const { rows: [prior] } = await db.query<PriceWatch>(`SELECT * FROM bell_price_watches
    WHERE issuer=$1 AND owner_id=$2 AND equivalent=$3 AND status IN ${open} FOR UPDATE`,
  [inbound.owner.issuer, inbound.owner.id, key]);
  if (prior && prior.expires_at.getTime() > Date.now()) {
    return listingsToWatch.some(offer => matchesTerms(offer, prior.terms, prior.identity))
      ? { status: "enrolled", id: prior.id }
      : needsDetails;
  }
  if (prior) {
    await db.query("UPDATE bell_price_watches SET status='expired' WHERE id=$1", [prior.id]);
    await detach(db, prior.id);
  }

  const id = randomUUID();
  await db.query(`INSERT INTO bell_price_watches(id,issuer,owner_id,destination,terms,equivalent,identity,credential_fingerprint,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')`,
  [id, inbound.owner.issuer, inbound.owner.id, inbound.destination,
    { ...terms, product: terms.product ?? listingsToWatch[0].product, resolvedVariant: resolved.resolvedVariant },
    key, resolved.identity, linqFingerprint()]);
  // Concurrent enrollments can share listings. Lock those listings in the same order.
  for (const offer of listingsToWatch.toSorted((a, b) => a.url.localeCompare(b.url))) await attachOffer(db, id, offer);
  return { status: "enrolled", id };
}

export class PriceWatches {
  constructor(readonly store: MonitorStore, readonly sources: ShoppingSources = shoppingSources) {}

  async enroll(inbound: Inbound, input: WatchTerms, signal?: AbortSignal) {
    checkDestination(inbound.owner, inbound.destination);
    requirePriceEnrollment();
    const saved = await this.store.transaction(db => rememberAction(db, inbound, { name: "enroll", request: watchTerms.parse(input) }));
    if (saved.outcome) return this.result(saved.outcome as Decision);

    const terms = watchTerms.parse(saved.request);
    const action = { name: "enroll", request: terms } as const;
    const deadline = AbortSignal.timeout(14_000);
    // Read merchant pages outside the transaction so they never hold a database lock.
    const resolved = identifyOffers(terms, await readOffers(terms, this.sources, signal ? AbortSignal.any([signal, deadline]) : deadline));
    checkDestination(inbound.owner, inbound.destination);

    const decision = await this.store.transaction(async db => {
      const current = await lockAction(db, inbound, action);
      if (current.outcome) return current.outcome as Decision;
      requirePriceEnrollment();
      const outcome = await decideEnrollment(db, inbound, terms, resolved);
      await saveActionOutcome(db, inbound, action, outcome);
      return outcome;
    });
    return this.result(decision);
  }

  private async result(decision: Decision) {
    if (decision.status !== "enrolled") {
      return "offer" in decision && decision.offer.expiresAt <= Date.now()
        ? { status: "match_needs_recheck" as const } : decision;
    }
    const { rows: [watch] } = await this.store.pool.query<PriceWatch>(
      "SELECT * FROM bell_price_watches WHERE id=$1", [decision.id]);
    return watchSummary(watch);
  }

  async list(owner: Owner, destination: Destination, filter: WatchFilter, cursor?: string) {
    checkDestination(owner, destination);
    if (!await storageReady(this.store.pool)) return { watches: [], next_cursor: null };
    const { rows } = await this.store.pool.query<PriceWatch>(`SELECT * FROM bell_price_watches
      WHERE issuer=$1 AND owner_id=$2 AND destination=$3
        AND ($4::text='all' OR ($4='open')=(status IN ${open} AND expires_at>now()))
        AND ($5::uuid IS NULL OR (created_at,id) < (SELECT created_at,id FROM bell_price_watches
          WHERE id=$5 AND issuer=$1 AND owner_id=$2 AND destination=$3))
      ORDER BY created_at DESC, id DESC LIMIT $6`,
    [owner.issuer, owner.id, destination, filter, cursor ?? null, watchPageSize + 1]);
    return {
      watches: rows.slice(0, watchPageSize).map(watchSummary),
      next_cursor: rows.length > watchPageSize ? rows[watchPageSize - 1].id : null,
    };
  }

  async stop(inbound: Inbound, id: string) {
    checkDestination(inbound.owner, inbound.destination);
    if (!inbound.sentAt || !(Date.parse(inbound.sentAt) <= Date.now() + 60_000)) {
      throw new Error("Watch operation needs a reliable text timestamp. Ask the shopper to send a new stop request.");
    }
    const action = { name: "stop", request: { id } } as const;
    return this.store.transaction(async db => {
      const saved = await rememberAction(db, inbound, action);
      if (saved.outcome) return saved.outcome;
      const stopped = await db.query(`UPDATE bell_price_watches SET status='stopped' WHERE id=$1 AND issuer=$2 AND owner_id=$3
        AND destination=$4 AND created_at<=$5::timestamptz AND status IN ${open} RETURNING id`,
      [id, inbound.owner.issuer, inbound.owner.id, inbound.destination, inbound.sentAt]);
      if (stopped.rowCount) await detach(db, id);
      const outcome = stopped.rowCount ? { id: `price:${id}`, status: "stopped" } : { status: "not_found" };
      await saveActionOutcome(db, inbound, action, outcome);
      return outcome;
    });
  }
}

export const priceWatches = () => new PriceWatches(monitorStore());
