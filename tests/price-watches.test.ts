import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ToolContext } from "eve/tools";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signedPriceMessage } from "../agent/lib/monitors";
import { ProviderError } from "../server/monitors/provider";
import { MonitorService } from "../server/monitors/service";
import { MonitorStore } from "../server/monitors/store";
import { priceLineForOperator } from "../server/operator-auth";
import { digest } from "../server/shopping/config";
import { dispatchAlert } from "../server/shopping/delivery";
import { listingUrl, parseMerchantEvidence, priceMinor, qualifies, type Observation, type WatchTerms } from "../server/shopping/evidence";
import { sendPriceAlert, type Delivery } from "../server/shopping/providers";
import * as merchantPage from "../server/shopping/public-page";
import { discoverListings } from "../server/shopping/search";
import { claimPriceJob, finishPriceJob, type Inbound } from "../server/shopping/store";
import { PriceWatches, shoppingSources, type ShoppingSources } from "../server/shopping/watches";
import { PriceWorker } from "../server/shopping/worker";

const url = "https://example.com/product?variant=blue-128";
const second = "https://another.example.com/product?variant=blue-128";
const terms = { product: "Phone Blue 128 GB", url, currency: "GBP", country: "GB", amount: "250", condition: "new", comparison: "below" } satisfies WatchTerms;
const destination = { chat: "chat-a", sender: "+12025550123", line: "+12025550100" };
const owner = { issuer: "linq", id: "linq:sender" };
const identity = "mpn:acme:blue-128";
const timestamp = () => new Date().toISOString();
const inbound = (messageId = randomUUID()): Inbound => ({ destination, owner, messageId, sentAt: timestamp() });
const verified = (amount: number, inStock = true, listing = url): Observation => ({
  url: listing, product: terms.product, identity, variant: "blue-128", seller: "Example Shop",
  condition: "new", country: "GB", currency: "GBP", amount, inStock, observedAt: Date.now(), expiresAt: Date.now() + 300_000,
});

function product(availability = "InStock", price = "249.99", listing = url, country = "GB") {
  return {
    "@type": "Product", url: listing, name: terms.product, sku: "blue-128", mpn: "blue-128", brand: { name: "Acme" },
    offers: { "@type": "Offer", url: listing, seller: { name: "Example Shop" }, availability: `https://schema.org/${availability}`,
      itemCondition: "https://schema.org/NewCondition", priceCurrency: "GBP", price, eligibleRegion: country },
  };
}

function page(data: unknown, extra = "", ageSeconds = 0) {
  return { url, html: `${extra}<script type="application/ld+json">${JSON.stringify(data)}</script>`, ageSeconds };
}

const shoes = (size: string, price: string, host = "example.com", gtin?: string) => {
  const listing = `https://${host}/shoes?size=${size}`;
  const markup = { ...product("InStock", price, listing), name: "Acme Trail Runner", size,
    sku: `${host}-trail-${size}`, mpn: "TRAIL", gtin };
  return { ...page(markup), url: listing };
};
const shoeTerms = { ...terms, url: undefined, product: "Acme Trail Runner", amount: "120" };

function stubConfig() {
  vi.stubEnv("DATABASE_URL", "postgresql://unused.local/db");
  vi.stubEnv("PARALLEL_API_KEY", "test-parallel");
  vi.stubEnv("CRON_SECRET", "test-cron");
  vi.stubEnv("LINQ_API_KEY", "test-linq");
  vi.stubEnv("LINQ_WEBHOOK_SECRET", "test-linq-webhook");
  vi.stubEnv("BELL_LINQ_PHONE_NUMBER", destination.line);
  vi.stubEnv("BELL_LINQ_ALLOWED_SENDERS", destination.sender);
  vi.stubEnv("BELL_PRICE_WATCHES_ENABLED", "true");
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Product and merchant evidence", () => {
  it("requires selected-variant, seller, market and stock evidence in minor units", () => {
    const item = parseMerchantEvidence(page(product()), "GB");
    expect(item).toMatchObject({ identity, variant: "blue-128", seller: "Example Shop", amount: 24999, inStock: true });
    expect(qualifies(item!, terms)).toBe(true);
    const equal = parseMerchantEvidence(page(product("InStock", "250")), "GB")!;
    expect(qualifies(equal, terms)).toBe(false);
    expect(qualifies(equal, { ...terms, comparison: "at_or_below" })).toBe(true);
    expect(qualifies(parseMerchantEvidence(page(product("OutOfStock")), "GB")!, terms)).toBe(false);
    expect(priceMinor("250.01", "JPY")).toBeNull();
    expect(priceMinor("250", "JPY")).toBe(250);
    expect(priceMinor("1.001", "KWD")).toBe(1001);
  });

  it("rejects a group, wrong default, contradictory selected SKU, conditional price, pickup, stale or mislocalized evidence", () => {
    const selected = product();
    expect(parseMerchantEvidence(page({ "@type": "ProductGroup", offers: selected.offers }), "GB")).toBeNull();
    expect(parseMerchantEvidence(page(product("InStock", "50", "https://example.com/product")), "GB")).toBeNull();
    expect(parseMerchantEvidence(page(selected, '<div data-selected-sku="red-128"></div>'), "GB")).toBeNull();
    expect(parseMerchantEvidence(page({ ...selected, offers: { ...selected.offers, eligibleCustomerType: "Member" } }), "GB")).toBeNull();
    expect(parseMerchantEvidence(page({ ...selected, offers: { ...selected.offers, availableDeliveryMethod: "OnSitePickup" } }), "GB")).toBeNull();
    expect(parseMerchantEvidence(page({ ...selected, offers: { ...selected.offers, "@type": "AggregateOffer" } }), "GB")).toBeNull();
    expect(parseMerchantEvidence(page(selected, "", 301), "GB")).toBeNull();
    expect(parseMerchantEvidence(page({ ...selected, offers: { ...selected.offers, priceValidUntil: "2000-01-01" } }), "GB")).toBeNull();
    expect(parseMerchantEvidence(page(product("InStock", "50", url, "IE")), "GB")).toBeNull();
    expect(parseMerchantEvidence(page({ ...selected, offers: { ...selected.offers, availability: "LimitedAvailability" } }), "GB")).toBeNull();
  });

  it("rejects merchant markup that contradicts the listing's selected size or market", () => {
    const shoes = (listing: string, size: string) => ({ ...page({ ...product("InStock", "100", listing), size }), url: listing });
    const sized = "https://example.com/shoes?size=10";
    expect(parseMerchantEvidence(shoes(sized, "9"), "GB")).toBeNull();
    expect(parseMerchantEvidence(shoes(sized, "10"), "GB")).toMatchObject({ url: sized, amount: 10_000 });
    const us = `${sized}&country=US`;
    expect(parseMerchantEvidence(shoes(us, "10"), "GB")).toBeNull();
    const dollars = `${sized}&currency=USD`;
    expect(parseMerchantEvidence(shoes(dollars, "10"), "GB")).toBeNull();
  });

  it("requires evidence for each selected variant beyond the listing URL itself", () => {
    const listing = "https://example.com/shoes?size=10&color=blue";
    const evidence = (url: string, extra: Record<string, unknown>) =>
      ({ ...page({ ...product("InStock", "100", url), ...extra }), url });
    expect(parseMerchantEvidence(evidence(listing, { size: "10" }), "GB")).toBeNull();
    expect(parseMerchantEvidence(evidence(listing, { size: "10", color: { name: "Blue" } }), "GB"))
      .toMatchObject({ url: listing, amount: 10_000 });
    const opaque = "https://example.com/shoes?color_id=7";
    expect(parseMerchantEvidence(evidence(opaque, { color: "Blue" }), "GB")).toBeNull();
    const local = `${listing}&locale=zh-Hant-TW`;
    expect(parseMerchantEvidence(evidence(local, { size: "10", color: "Blue" }), "GB")).toBeNull();
  });

  it("rejects an offer explicitly targeting another or unresolved product variant", () => {
    const selected = { ...product(), "@id": "#blue-128" };
    const different = { "@type": "Product", "@id": "#red-64", name: "Phone Red 64 GB", sku: "red-64" };
    const evidence = (itemOffered: unknown) => page({
      "@context": "https://schema.org",
      "@graph": [{ ...selected, offers: { ...selected.offers, itemOffered, price: "149.99" } }, different],
    });

    for (const target of [different, { "@id": different["@id"] }, { "@id": "#missing" },
      { "@id": selected["@id"], sku: different.sku }, [{ "@id": selected["@id"] }, different],
      { "@type": "Product", name: selected.name }]) {
      expect(parseMerchantEvidence(evidence(target), "GB")).toBeNull();
    }
    for (const target of [undefined, { "@id": selected["@id"] }, { "@type": "Product", sku: selected.sku }]) {
      expect(parseMerchantEvidence(evidence(target), "GB")).toMatchObject({ variant: selected.sku, amount: 14999 });
    }
  });

  it("requires market proof when an offer declares conflicting or unresolved regions", () => {
    const selected = product();
    const shippingDetails = { shippingDestination: { addressCountry: "GB" } };
    const evidence = (extra: Record<string, unknown>) =>
      page({ ...selected, offers: { ...selected.offers, shippingDetails, ...extra } });
    expect(parseMerchantEvidence(evidence({ eligibleRegion: "United States" }), "GB")).toBeNull();
    expect(parseMerchantEvidence(evidence({ ineligibleRegion: "United Kingdom" }), "GB")).toBeNull();
    expect(parseMerchantEvidence(evidence({ ineligibleRegion: ["US", { addressCountry: "CA" }] }), "GB"))
      .toMatchObject({ country: "GB", currency: "GBP" });
  });

  it("retains merchant proof of a named part number when the same offer also publishes a GTIN", () => {
    const item = parseMerchantEvidence(page({ ...product(), gtin13: "4006381333931" }), "GB");
    expect(item).toMatchObject({ identity: "gtin:04006381333931" });
    expect(qualifies(item!, { ...terms, brand: "Acme", mpn: "blue-128" })).toBe(true);
    expect(qualifies(item!, { ...terms, brand: "Acme", mpn: "red-128" })).toBe(false);
  });

  it("reads offer scripts only from live HTML elements", () => {
    const json = JSON.stringify(product());
    const script = `<script type="application/ld+json">${json}</script>`;
    for (const html of [
      `<script data-type="application/ld+json" type="text/plain">${json}</script>`,
      `<script title=" type='application/ld+json' " type="text/plain">${json}</script>`,
      `<!-- ${script} -->`,
      `<main>Out of stock<textarea>${script}</textarea></main>`,
      `<main>Out of stock<template>${script}</template></main>`,
      `<main>Out of stock<noscript>${script}</noscript></main>`,
      `<main>Out of stock<svg>${script}</svg></main>`,
    ]) {
      expect.soft(parseMerchantEvidence({ url, html, ageSeconds: 0 }, "GB")).toBeNull();
    }
    const html = `<script title="Offer > preview" type="application/ld+json">${json}</script>`;
    expect(parseMerchantEvidence({ url, html, ageSeconds: 0 }, "GB")).toMatchObject({ url, amount: 24999 });
  });

  it("requires countrywide eligibility and shipping evidence for a country-level market", () => {
    const selected = product();
    const country = { "@type": "DefinedRegion", addressCountry: "GB" };
    const postcode = { ...country, postalCodePrefix: "BT" };
    const evidence = (eligibleRegion?: unknown, shippingDestination?: unknown) => page({
      ...selected,
      offers: { ...selected.offers, eligibleRegion, shippingDetails: { shippingDestination } },
    });
    expect(parseMerchantEvidence(evidence(undefined, postcode), "GB")).toBeNull();
    expect(parseMerchantEvidence(evidence("GB", postcode), "GB")).toBeNull();
    expect(parseMerchantEvidence(evidence({ ...country, addressRegion: "Wales" }, country), "GB")).toBeNull();
    expect(parseMerchantEvidence(evidence("GB", [postcode, country]), "GB")).toMatchObject({ country: "GB" });
  });

  it("honors shipping exclusions even when a country is otherwise eligible", () => {
    const selected = product();
    const ships = { shippingDestination: { addressCountry: "GB" }, doesNotShip: false };
    const blocked = { ...ships, doesNotShip: true };
    const evidence = (shippingDetails: unknown, eligibleRegion?: string) =>
      page({ ...selected, offers: { ...selected.offers, eligibleRegion, shippingDetails } });

    expect(parseMerchantEvidence(evidence(ships), "GB")).toMatchObject({ country: "GB" });
    expect(parseMerchantEvidence(evidence(blocked), "GB")).toBeNull();
    expect(parseMerchantEvidence(evidence(blocked, "GB"), "GB")).toBeNull();
    expect(parseMerchantEvidence(evidence([ships, { ...blocked, shippingDestination: { addressCountry: "GB", postalCodePrefix: "BT" } }]), "GB")).toBeNull();
    expect(parseMerchantEvidence(evidence([ships, { ...blocked, shippingDestination: { addressCountry: "US" } }]), "GB"))
      .toMatchObject({ country: "GB" });
  });

  it("requires a purchase offer within its declared availability window", () => {
    const selected = product();
    const now = Date.parse("2026-11-23T22:00:00Z");
    const past = "2026-11-23T21:59:00Z", future = "2026-11-23T22:01:00Z";
    const evidence = (extra: Record<string, unknown>) =>
      parseMerchantEvidence(page({ ...selected, offers: { ...selected.offers, ...extra } }), "GB", now);

    expect(evidence({ availabilityStarts: future })).toBeNull();
    expect(evidence({ availabilityStarts: "0" })).toBeNull();
    expect(evidence({ availabilityEnds: past })).toBeNull();
    expect(evidence({ availabilityEnds: 123 })).toBeNull();
    expect(evidence({ businessFunction: "http://purl.org/goodrelations/v1#LeaseOut" })).toBeNull();
    const open = evidence({ availabilityStarts: past, availabilityEnds: future,
      businessFunction: { "@id": "http://purl.org/goodrelations/v1#Sell" } });
    expect(open).toMatchObject({ inStock: true, expiresAt: Date.parse(future) });
    expect(qualifies(open!, terms, now)).toBe(true);
    expect(qualifies(open!, terms, Date.parse(future))).toBe(false);
  });

  it("checks selected SKU values only on live element attributes", () => {
    for (const extra of [
      '<!-- data-selected-sku="red-128" -->',
      '<textarea>data-selected-sku="red-128"</textarea>',
      '<template><span data-selected-sku="red-128"></span></template>',
      '<div title=\'data-selected-sku="red-128"\'></div>',
    ]) {
      expect.soft(parseMerchantEvidence(page(product(), extra), "GB")).toMatchObject({ variant: "blue-128", amount: 24999 });
    }
    expect(parseMerchantEvidence(page(product(), '<div data-selected-sku="red&#45;128"></div>'), "GB")).toBeNull();
    expect(parseMerchantEvidence(page(product(), '<div data-selected-sku="blue&#45;128"></div>'), "GB"))
      .toMatchObject({ variant: "blue-128" });
  });

  it("restricts public destinations and preserves known variant selectors", () => {
    expect(listingUrl.parse(url)).toBe(url);
    expect(listingUrl.parse(`${url}&utm_source=example`)).toBe(url);
    expect(listingUrl.safeParse(`${url}&session_token=abc`).success).toBe(false);
    expect(listingUrl.safeParse(`${url}#access_token=abc`).success).toBe(false);
    expect(listingUrl.safeParse("https://a.local/p").success).toBe(false);
    expect(listingUrl.safeParse("https://[::1]/").success).toBe(false);
    for (const ip of ["127.0.0.1", "169.254.1.2", "10.2.3.4", "172.16.0.2", "100.64.2.3", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1"]) {
      expect(merchantPage.isPublicAddress(ip), ip).toBe(false);
    }
    expect(merchantPage.isPublicAddress("93.184.216.34")).toBe(true);
    expect(merchantPage.isPublicAddress("2606:4700::1")).toBe(true);
  });

  it("requests Shopping leads for the target market and lets merchant evidence establish eligibility", async () => {
    vi.stubEnv("PARALLEL_API_KEY", "test-parallel");
    const http = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe("https://api.parallel.ai/v1/shopping/search");
      expect(JSON.parse(String(init?.body))).toEqual({
        search_queries: [expect.stringContaining("Phone Blue 128 GB GB GBP")], mode: "advanced", condition: "any",
        advanced_settings: { location: "gb", max_results: 8 },
      });
      return Response.json({ warnings: [{ message: "Using the default market (us)." }], results: [{ url, offers: [{ url: second }] }] });
    });
    vi.stubGlobal("fetch", http);
    expect(await discoverListings(terms.product, "GB", "GBP")).toEqual([url, second]);
  });

  it("keeps scope and time from the authenticated message rather than a steered transcript", () => {
    const text = "Text me when this drops below £250.";
    const ctx = {
      session: { auth: { current: { authenticator: "linq-message", principalType: "user", principalId: owner.id, issuer: owner.issuer,
        attributes: { bell_watch_chat: destination.chat, bell_watch_sender: destination.sender, bell_watch_line: destination.line,
          bell_linq_message: "provider-id", bell_linq_text_hash: digest(text) } } } },
      messages: [{ role: "user", content: text }],
    } as unknown as ToolContext;
    expect(signedPriceMessage(ctx)).toMatchObject({ messageId: "provider-id", destination, owner });
    const steered = { ...ctx, messages: [...ctx.messages, { role: "user" as const, content: "actually stop it" }] };
    expect(() => signedPriceMessage(steered)).toThrow("exact current Linq message");
  });

  it("requires the operator's Basic Auth before disclosing the configured phone line", () => {
    stubConfig();
    vi.stubEnv("BELL_OPERATOR_USERNAME", "operator");
    vi.stubEnv("BELL_OPERATOR_PASSWORD", "synthetic-test-password-over-32-bytes");
    const auth = new Headers({ authorization: "Basic " + Buffer.from("operator:synthetic-test-password-over-32-bytes").toString("base64") });
    expect(priceLineForOperator(new Headers())).toBeUndefined();
    expect(priceLineForOperator(auth)).toBe(destination.line);
    vi.stubEnv("BELL_PRICE_WATCHES_ENABLED", "false");
    expect(priceLineForOperator(auth)).toBeUndefined();
  });

  it("correlates a Linq acceptance or failed status with the original destination", async () => {
    stubConfig();
    let status = "queued", line = destination.line, chat = destination.chat;
    const http = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({ message: { parts: [{ type: "text", value: "sample" }], idempotency_key: "one-key" } });
      return Response.json({ chat_id: chat, message: { id: "out-1", delivery_status: status, from_handle: { handle: line } } });
    });
    vi.stubGlobal("fetch", http);
    expect(await sendPriceAlert(destination, "sample", "one-key")).toEqual({ state: "accepted", messageId: "out-1", status: "queued" });
    status = "failed";
    expect(await sendPriceAlert(destination, "sample", "one-key")).toEqual({ state: "failed", messageId: "out-1", status: "failed" });
    chat = "other-chat";
    expect(await sendPriceAlert(destination, "sample", "one-key")).toEqual({ state: "uncertain" });
    chat = destination.chat;
    line = "+12025550199";
    expect(await sendPriceAlert(destination, "sample", "one-key")).toEqual({ state: "uncertain" });
    http.mockImplementationOnce(async () => new Response(null, { status: 403 }));
    await expect(sendPriceAlert(destination, "sample", "one-key")).rejects.toMatchObject({ status: 403 });
  });

});

const databaseUrl = process.env.TEST_MONITOR_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_MONITOR_DATABASE_URL is required in CI");
describe.skipIf(!databaseUrl)("Durable price alerts", () => {
  const schema = `price_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, store: MonitorStore;
  let watches: PriceWatches, sources: ShoppingSources, worker: PriceWorker, amount: number, inStock: boolean;
  let verify: ReturnType<typeof vi.fn<ShoppingSources["verify"]>>;
  let send: ReturnType<typeof vi.fn<(destination: unknown, body: string, key: string) => Promise<Delivery>>>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
    for (const migration of ["004_parallel_monitors", "005_monitor_frequency", "007_price_watches", "007_price_watches", "008_price_action_keys"]) {
      await pool.query(await readFile(new URL(`../migrations/${migration}.sql`, import.meta.url), "utf8"));
    }
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE bell_price_watches, bell_price_actions, bell_price_offers, bell_price_jobs, bell_monitor_inbox, bell_monitors CASCADE");
    stubConfig();
    store = new MonitorStore(pool);
    amount = 30_000;
    inStock = true;
    verify = vi.fn(async listing => verified(amount, inStock, listing));
    sources = { discover: vi.fn(async () => [url]), verify };
    send = vi.fn(async (_destination, _body, key) => ({ state: "accepted", messageId: key, status: "queued" }));
    watches = new PriceWatches(store, sources);
    worker = new PriceWorker(store, sources, send);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
  async function due() {
    await pool.query("UPDATE bell_price_offers SET next_at=clock_timestamp()-interval '1 minute'");
    await worker.schedule();
  }
  async function tick(priceWorker = worker) {
    await priceWorker.runOne(Date.now() + 5000);
  }
  async function stopMessage() {
    const { rows: [row] } = await pool.query<{ sent_at: string }>("SELECT to_json(clock_timestamp()) AS sent_at");
    return { ...inbound(), sentAt: row.sent_at };
  }
  function watchId(result: Awaited<ReturnType<PriceWatches["enroll"]>>) {
    if (!("id" in result)) throw new Error(`Expected watch enrollment, got ${result.status}`);
    return result.id;
  }
  const count = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

  it("resolves a named size before comparing prices and accepts equivalent merchant SKUs", async () => {
    const size8 = shoes("8", "151");
    const size9 = shoes("9", "89");
    const pages = new Map([size8, size9].map(listing => [listing.url, listing]));
    vi.mocked(sources.discover).mockImplementation(async () => [...pages.keys()]);
    verify.mockImplementation(async (url, country) => parseMerchantEvidence(pages.get(url)!, country));

    expect(await watches.enroll(inbound(), shoeTerms)).toMatchObject({ status: "needs_details" });
    expect(await watches.enroll(inbound(), { ...shoeTerms, brand: "Acme", mpn: "TRAIL" })).toMatchObject({ status: "needs_details" });
    expect(await watches.enroll(inbound(), { ...shoeTerms, variant: "9" })).toMatchObject({ status: "match", offer: { url: size9.url } });
    expect(await watches.enroll(inbound(), { ...shoeTerms, url: size9.url })).toMatchObject({ status: "match", offer: { url: size9.url } });

    const size9Other = shoes("9", "75", "another.example.com");
    pages.set(size9Other.url, size9Other);
    pages.delete(size8.url);
    expect(await watches.enroll(inbound(), shoeTerms)).toMatchObject({ status: "match", offer: { url: size9Other.url } });

    const sameGtin = "00012345678905";
    pages.set(size9.url, shoes("9", "89", "example.com", sameGtin));
    expect(await watches.enroll(inbound(), shoeTerms)).toMatchObject({ status: "match", offer: { url: size9Other.url } });
    pages.set(size9Other.url, shoes("9", "75", "another.example.com", sameGtin));
    expect(await watches.enroll(inbound(), shoeTerms)).toMatchObject({ status: "match", offer: { url: size9Other.url } });
  });

  it("does not alert for a different size on a pinned listing that reuses a SKU", async () => {
    const listing = "https://example.com/shoes";
    let size = "8";
    verify.mockImplementation(async () => parseMerchantEvidence({
      ...page({ ...product("InStock", String(amount / 100), listing), name: shoeTerms.product, size }),
      url: listing,
    }, "GB"));
    await watches.enroll(inbound(), { ...shoeTerms, url: listing });

    amount = 8_900;
    size = "9";
    await due();
    await tick();
    await tick();
    expect(send).not.toHaveBeenCalled();

    size = "8";
    await due();
    await tick();
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("asks for details when a repeated named watch resolves to a conflicting size", async () => {
    const size8 = shoes("8", "151");
    const size9 = shoes("9", "149");
    let listing = size8;
    vi.mocked(sources.discover).mockImplementation(async () => [listing.url]);
    verify.mockImplementation(async () => parseMerchantEvidence(listing, "GB"));
    const first = await watches.enroll(inbound(), shoeTerms);
    expect(first).toMatchObject({ status: "active" });
    expect(await watches.enroll(inbound(), shoeTerms)).toMatchObject({ id: watchId(first) });

    listing = size9;
    expect(await watches.enroll(inbound(), shoeTerms)).toMatchObject({ status: "needs_details" });
    expect(await count("bell_price_watches")).toBe(1);
  });

  it("does not send a reservation contradicted by a newer read during a dispatch pause", async () => {
    const result = await watches.enroll(inbound(), terms);
    await watches.enroll(inbound(), { ...terms, amount: "200" });
    const observedAt = Date.now();
    verify.mockResolvedValueOnce({ ...verified(23_000), observedAt, expiresAt: observedAt + 300_000 });
    await due();
    await tick();
    vi.stubEnv("BELL_PRICE_WATCHES_ENABLED", "false");
    await expect(watches.enroll(inbound(), terms)).rejects.toThrow("currently unavailable");
    await tick();
    expect(send).not.toHaveBeenCalled();
    verify.mockResolvedValueOnce({ ...verified(23_000, false), observedAt: observedAt + 1, expiresAt: observedAt + 300_001 });
    await due();
    await tick();
    vi.stubEnv("BELL_PRICE_WATCHES_ENABLED", "true");
    await pool.query("UPDATE bell_price_jobs SET next_at=clock_timestamp() WHERE kind='send'");
    const staleJob = await claimPriceJob(pool);
    expect(staleJob.kind).toBe("send");
    await dispatchAlert(store, staleJob, sources, new AbortController().signal, send);
    expect(send).not.toHaveBeenCalled();
    const reservation = (await pool.query("SELECT status, dispatch_at FROM bell_price_watches WHERE id=$1", [watchId(result).slice(6)])).rows[0];
    expect(reservation).toEqual({ status: "active", dispatch_at: null });

    verify.mockResolvedValueOnce({ ...verified(23_000), observedAt: observedAt + 2, expiresAt: observedAt + 300_002 });
    // Another worker observes a fresh match before the old send worker finishes its tick.
    await worker.schedule();
    await tick();
    await finishPriceJob(pool, staleJob);
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("replays an immediate match without enrolling after a price increase", async () => {
    amount = 24_999;
    const message = inbound();
    expect(await watches.enroll(message, terms)).toMatchObject({ status: "match" });
    amount = 30_000;
    expect(await new PriceWatches(store, sources).enroll(message, terms)).toMatchObject({ status: "match" });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await count("bell_price_watches")).toBe(0);
  });

  it("shares public verification and sends one text per matching shopper after a price drop", async () => {
    const other = { ...inbound(), destination: { ...destination, chat: "chat-b" } };
    const [first, second] = await Promise.all([watches.enroll(inbound(), terms), watches.enroll(other, terms)]);
    expect(first).toMatchObject({ status: "active" });
    expect(second).toMatchObject({ status: "active" });
    expect(await count("bell_price_offers")).toBe(1);
    verify.mockClear();
    amount = 24_900;
    await due();
    expect(await count("bell_price_jobs")).toBe(1);
    await Promise.all([tick(), tick()]);
    expect(verify).toHaveBeenCalledTimes(1);
    await Promise.all([tick(), tick(), tick()]);
    await due();
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(destination, expect.stringContaining(`GBP 249.00 before tax and shipping.\n${url}`), expect.stringMatching(/^bell-price-/), expect.any(AbortSignal));
    expect((await pool.query("SELECT DISTINCT status, delivery_status FROM bell_price_watches")).rows).toEqual([{ status: "accepted", delivery_status: "queued" }]);
    expect(await count("bell_price_subscriptions")).toBe(0);
  });

  it("deduplicates equivalent requests, persists stops and does not reopen a replayed enrollment", async () => {
    const original = inbound();
    const [created, duplicate] = await Promise.all([watches.enroll(original, terms), watches.enroll(inbound(), { ...terms, amount: "250.00" })]);
    expect(watchId(created)).toBe(watchId(duplicate));
    const stop = await stopMessage();
    expect(await watches.stop(stop, watchId(created).slice(6))).toMatchObject({ status: "stopped" });
    expect(await watches.enroll(original, terms)).toMatchObject({ status: "stopped" });
    const recreated = await watches.enroll(inbound(), terms);
    expect(watchId(recreated)).not.toBe(watchId(created));
    expect(await watches.stop(stop, watchId(created).slice(6))).toMatchObject({ id: watchId(created), status: "stopped" });
    const delayed = { ...inbound(), sentAt: "2000-01-01T00:00:00Z" };
    expect(await watches.stop(delayed, watchId(recreated).slice(6))).toMatchObject({ status: "not_found" });
    expect(await watches.stop({ ...inbound(), destination: { ...destination, chat: "another" } }, watchId(recreated).slice(6))).toMatchObject({ status: "not_found" });
    const listed = await watches.list(owner, destination, "all");
    expect(listed.watches).toEqual([
      expect.objectContaining({ id: watchId(recreated), status: "active" }),
      expect.objectContaining({ id: watchId(created), status: "stopped" }),
    ]);
  });

  it("stops both watches from one text and replays each stop independently", async () => {
    const firstId = watchId(await watches.enroll(inbound(), terms));
    const secondId = watchId(await watches.enroll(inbound(), { ...terms, amount: "200" }));
    const stop = await stopMessage();

    expect(await watches.stop(stop, firstId.slice(6))).toEqual({ id: firstId, status: "stopped" });
    expect(await watches.stop(stop, secondId.slice(6))).toEqual({ id: secondId, status: "stopped" });
    expect(await watches.stop(stop, secondId.slice(6))).toEqual({ id: secondId, status: "stopped" });
    expect(await watches.stop(stop, firstId.slice(6))).toEqual({ id: firstId, status: "stopped" });
    expect((await watches.list(owner, destination, "open")).watches).toEqual([]);
    expect(await count("bell_price_subscriptions")).toBe(0);

    amount = 19_900;
    await due();
    await tick();
    await tick();
    expect(send).not.toHaveBeenCalled();
  });

  it("enrolls distinct requests from one text and replays equivalent prices", async () => {
    const message = inbound();
    const first = await watches.enroll(message, terms);
    const second = await watches.enroll(message, { ...terms, amount: "200" });
    expect(watchId(first)).not.toBe(watchId(second));

    expect(await watches.enroll(message, { ...terms, amount: "0250.00" })).toEqual(first);
    expect(await watches.enroll(message, { ...terms, amount: "200.0" })).toEqual(second);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(await count("bell_price_watches")).toBe(2);
  });

  it("preserves enrollment and stop outcomes already saved by migration 007", async () => {
    const legacySchema = `${schema}_legacy`;
    await admin.query(`CREATE SCHEMA ${legacySchema}`);
    const legacy = new Pool({ connectionString: databaseUrl, options: `-c search_path=${legacySchema}` });
    try {
      await legacy.query(await readFile(new URL("../migrations/007_price_watches.sql", import.meta.url), "utf8"));
      const message = inbound();
      const stoppedId = randomUUID();
      const match = { status: "match", offer: verified(24_999) };
      const stopped = { status: "stopped", id: `price:${stoppedId}` };
      await legacy.query(`INSERT INTO bell_price_actions(issuer,owner_id,chat,line,message_id,action,request,outcome)
        VALUES ($1,$2,$3,$4,$5,'enroll',$6,$7), ($1,$2,$3,$4,$5,'stop',$8,$9)`,
      [owner.issuer, owner.id, destination.chat, destination.line, message.messageId, terms, match, { id: stoppedId }, stopped]);

      const migration = await readFile(new URL("../migrations/008_price_action_keys.sql", import.meta.url), "utf8");
      await legacy.query(migration);
      await legacy.query(migration);
      const upgraded = new PriceWatches(new MonitorStore(legacy), sources);
      expect(await upgraded.enroll(message, { ...terms, amount: "250.00" })).toEqual(match);
      expect(verify).not.toHaveBeenCalled();
      expect(await upgraded.stop(message, randomUUID())).toEqual({ status: "not_found" });
      expect(await upgraded.stop(message, stoppedId)).toEqual(stopped);
    } finally {
      await legacy.end();
      await admin.query(`DROP SCHEMA ${legacySchema} CASCADE`);
    }
  });

  it("keeps the pasted link through a trailing-slash redirect and the later price alert", async () => {
    let finalUrl = url.replace("/product?", "/product/?");
    using read = vi.spyOn(merchantPage, "readPublicPage").mockImplementation(async () => ({
      ...page(product("InStock", String(amount / 100), finalUrl)), url: finalUrl,
    }));
    verify.mockImplementation(shoppingSources.verify);
    expect(await watches.enroll(inbound(), terms)).toMatchObject({ status: "active" });
    for (const changed of [url.replace("/product?", "/different?"), second, url.replace("blue-128", "red-64"), url + "&market=GB"]) {
      const item = await shoppingSources.verify(changed, "GB");
      expect(item).toBeNull();
    }
    finalUrl = url;
    amount = 24_900;
    await due();
    await tick();
    await tick();
    expect(read).toHaveBeenLastCalledWith(url, expect.any(Function), expect.any(AbortSignal));
    expect(send).toHaveBeenCalledExactlyOnceWith(destination, expect.stringContaining(url), expect.any(String), expect.any(AbortSignal));
  });

  it("requires evidence for an exact listing even when its product ID is known", async () => {
    verify.mockResolvedValue(null);
    const pinned = { ...terms, brand: "Acme", mpn: "blue-128" };
    expect(await watches.enroll(inbound(), pinned)).toEqual({ status: "needs_details", reason: "unverified_listing" });
    expect(await count("bell_price_watches")).toBe(0);
    expect(sources.discover).not.toHaveBeenCalled();
    expect(await watches.enroll(inbound(), { ...pinned, url: undefined })).toEqual({ status: "needs_details", reason: "unresolved_product" });
  });

  it("watches only the verified listings found at enrollment", async () => {
    vi.mocked(sources.discover).mockResolvedValueOnce([url, second]);
    await watches.enroll(inbound(), { ...terms, url: undefined });
    expect(await count("bell_price_subscriptions")).toBe(2);
    amount = 24_900;
    await due();
    await tick();
    await tick();
    await tick();
    expect(sources.discover).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not enroll a restock-only alert when the price already qualifies", async () => {
    amount = 24_900;
    inStock = false;
    expect(await watches.enroll(inbound(), terms)).toMatchObject({ status: "at_target_out_of_stock", offer: { amount } });
    expect(await count("bell_price_watches")).toBe(0);
  });

  it.each(["returns", "throws"])("recovers a send whose lease expires before verification %s", async outcome => {
    await watches.enroll(inbound(), terms);
    amount = 24_000;
    await due();
    await tick();
    await pool.query("UPDATE bell_price_watches SET alert=jsonb_set(alert,'{expiresAt}','0')");
    await pool.query("UPDATE bell_price_jobs SET attempts=7 WHERE kind='send'");
    verify.mockImplementationOnce(async () => {
      await pool.query("UPDATE bell_price_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE kind='send'");
      if (outcome === "throws") throw new Error("verification timed out");
      return verified(amount);
    });
    await tick();
    expect(send).not.toHaveBeenCalled();
    await tick(new PriceWorker(new MonitorStore(pool), sources, send));
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await watches.list(owner, destination, "closed")).watches).toMatchObject([{ status: "accepted" }]);
  });

  it("keeps a failed-commit send on the frozen body and key across a new worker", async () => {
    await watches.enroll(inbound(), terms);
    amount = 24_000;
    await due();
    await tick();
    send.mockImplementationOnce(async () => {
      // An earlier POST might have arrived even though the response never reached the worker.
      throw new Error("connection lost after request");
    });
    await tick();
    expect((await pool.query("SELECT status, dispatch_at FROM bell_price_watches")).rows[0])
      .toEqual({ status: "uncertain", dispatch_at: expect.any(Date) });
    await pool.query("UPDATE bell_price_jobs SET next_at=clock_timestamp()-interval '1 second'");
    await tick(new PriceWorker(new MonitorStore(pool), sources, send));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1].slice(0, 3)).toEqual(send.mock.calls[0].slice(0, 3));
    expect((await pool.query("SELECT status FROM bell_price_watches")).rows[0].status).toBe("accepted");
  });

  it("suppresses a stopped reservation and does not send a stale possible earlier alert", async () => {
    const first = await watches.enroll(inbound(), terms);
    amount = 23_000;
    await due();
    await tick();
    await watches.stop(inbound(), watchId(first).slice(6));
    await tick();
    expect(send).not.toHaveBeenCalled();

    amount = 30_000;
    const next = await watches.enroll(inbound(), terms);
    amount = 23_000;
    await due();
    for (let i = 0; i < 3 && send.mock.calls.length === 0; i++) {
      send.mockImplementation(async () => { throw new Error("unknown receipt"); });
      await tick();
    }
    expect(send).toHaveBeenCalledTimes(1);
    amount = 31_000;
    await pool.query("UPDATE bell_price_jobs SET next_at=clock_timestamp()-interval '1 second'");
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT status, delivery_status FROM bell_price_watches WHERE id=$1", [watchId(next).slice(6)])).rows[0])
      .toEqual({ status: "failed", delivery_status: "unresolved" });
  });

  it.each(["not_sent", "unresolved"])("closes an exhausted send and lists delivery as %s", async delivery => {
    const watch = await watches.enroll(inbound(), terms);
    amount = 24_900;
    await due();
    await tick();
    if (delivery === "not_sent") vi.stubEnv("LINQ_API_KEY", "different-test-key");
    else send.mockRejectedValue(new Error("no receipt"));
    await pool.query("UPDATE bell_price_jobs SET attempts=7 WHERE kind='send'");
    await tick();

    vi.stubEnv("LINQ_API_KEY", "test-linq");
    expect((await watches.list(owner, destination, "open")).watches).toEqual([]);
    expect((await watches.list(owner, destination, "closed")).watches).toMatchObject([
      { id: watchId(watch), status: "failed", delivery_status: delivery },
    ]);
    expect(await count("bell_price_subscriptions")).toBe(0);
    await pool.query("UPDATE bell_price_jobs SET next_at=clock_timestamp()");
    await due();
    await tick();
    expect(send).toHaveBeenCalledTimes(delivery === "not_sent" ? 0 : 1);
  });

  it("records a permanent Linq rejection or an unconfirmed reply without sending again", async () => {
    await watches.enroll(inbound(), terms);
    await watches.enroll(inbound(), { ...terms, amount: "249" });
    amount = 24_800;
    send.mockRejectedValueOnce(new ProviderError(403)).mockResolvedValueOnce({ state: "uncertain" });
    await due();
    await tick();
    await tick();
    await tick();
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect((await watches.list(owner, destination, "open")).watches).toEqual([]);
    const closed = (await watches.list(owner, destination, "closed")).watches;
    expect(closed).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "failed", delivery_status: "linq_http_403" }),
      expect.objectContaining({ status: "failed", delivery_status: "unresolved" }),
    ]));
    expect(await count("bell_price_jobs")).toBe(0);
    amount = 30_000;
    const previous = closed.find(watch => watch.delivery_status === "unresolved")!;
    const replacement = await watches.enroll(inbound(), previous.terms);
    expect(replacement).toMatchObject({ status: "active" });
    expect(watchId(replacement)).not.toBe(previous.id);
  });

  it("starts from a link alone and sends one Linq alert while the generic queue is backlogged", async () => {
    const enrolled = await watches.enroll(inbound(), { ...terms, product: undefined });
    expect(enrolled).toMatchObject({ status: "active", terms: { product: terms.product } });
    expect(sources.discover).not.toHaveBeenCalled();
    const watch = watchId(enrolled);
    amount = 24_900;
    await pool.query("UPDATE bell_price_offers SET next_at=clock_timestamp()-interval '1 minute'");
    const event = { type: "monitor.execution.completed", timestamp: timestamp(),
      data: { monitor_id: "unmatched", event: { type: "completion", monitor_ts: timestamp() } } };
    await pool.query("INSERT INTO bell_monitor_inbox(id,payload) SELECT 'backlog-'||n,$1::jsonb FROM generate_series(1,40) n", [event]);
    const read = vi.spyOn(shoppingSources, "verify").mockImplementation(async listing => verified(amount, inStock, listing));
    const http = vi.fn(async (endpoint: string, init: RequestInit) => {
      expect(endpoint).toBe(`https://api.linqapp.com/api/partner/v3/chats/${destination.chat}/messages`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ message: {
        parts: [{ type: "text", value: expect.stringContaining(`GBP 249.00 before tax and shipping.\n${url}`) }],
        idempotency_key: `bell-price-${watch.slice(6)}`,
      } });
      return Response.json({ chat_id: destination.chat, message: { id: "out-1", delivery_status: "queued" } });
    });
    vi.stubGlobal("fetch", http);
    try {
      const service = new MonitorService(store);
      vi.stubEnv("BELL_PRICE_WATCHES_ENABLED", "false");
      await service.process();
      expect(read).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
      vi.stubEnv("BELL_PRICE_WATCHES_ENABLED", "true");
      await pool.query("INSERT INTO bell_monitor_jobs(id,kind,payload) SELECT id,'inbox',jsonb_build_object('id',id) FROM bell_monitor_inbox");
      expect(await service.process()).toEqual({ processed: 30 });
      expect(read).toHaveBeenCalledExactlyOnceWith(url, "GB", expect.any(AbortSignal));
      expect(await count("bell_monitor_jobs")).toBe(12);
      expect(await service.process()).toEqual({ processed: 12 });
      expect(http).toHaveBeenCalledTimes(1);
      expect((await pool.query("SELECT status, message_id, delivery_status FROM bell_price_watches WHERE id=$1", [watch.slice(6)])).rows[0])
        .toEqual({ status: "accepted", message_id: "out-1", delivery_status: "queued" });
    } finally {
      read.mockRestore();
      await pool.query("TRUNCATE bell_monitor_jobs");
    }
  });

});
