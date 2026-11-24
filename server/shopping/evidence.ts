import { isDeepStrictEqual } from "node:util";
import { defaultTreeAdapter, html, parse } from "parse5";
import { z } from "zod";
import { publicUrl } from "../parallel";
import { readPublicPage, type PageRead } from "./public-page";

const selector = /^(?:variant(?:_id)?|sku|pid|color|colou?r_id|size|style|model|market|country|locale|currency|dwvar_[a-z0-9_]+)$/i;
const tracking = /^(?:utm_(?:source|medium|campaign|id|term|content)|gclid|fbclid|msclkid)$/i;
const selectorValue = /^[a-z0-9_.~ -]{1,80}$/i;
const listingParameters = (params: URLSearchParams) =>
  [...params.entries()].every(([key, value]) => selector.test(key) && selectorValue.test(value));
export const listingUrl = z.string().trim().max(2048).transform((value, ctx) => {
  if (publicUrl.safeParse(value).success) {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (tracking.test(key)) url.searchParams.delete(key);
    }
    if (url.protocol === "https:" && listingParameters(url.searchParams)
      && (!url.hash || (url.hash.includes("=") && listingParameters(new URLSearchParams(url.hash.slice(1)))))) {
      return url.href;
    }
  }
  ctx.addIssue({ code: "custom", message: "Use a public HTTPS product link with only public listing selectors." });
  return z.NEVER;
});

export const currencyCode = z.string().trim().toUpperCase().refine(code => Intl.supportedValuesOf("currency").includes(code));
export const countryCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
export const conditionCode = z.enum(["new", "used", "refurbished"]);
const safeLabel = z.string().trim().min(1).max(200);
const listingSelectors = (url: string) => {
  const parsed = new URL(url);
  return [...parsed.searchParams, ...new URLSearchParams(parsed.hash.slice(1))]
    .filter(([key]) => !/^(market|country|locale|currency)$/i.test(key));
};

export const watchTerms = z.object({
  product: safeLabel.optional(),
  url: listingUrl.optional(),
  country: countryCode,
  currency: currencyCode,
  amount: z.string().regex(/^\d{1,10}(?:\.\d{1,4})?$/),
  comparison: z.enum(["below", "at_or_below"]),
  seller: safeLabel.optional(),
  condition: conditionCode.default("new"),
  gtin: z.string().regex(/^\d{8,14}$/).optional(),
  brand: safeLabel.optional(),
  mpn: safeLabel.optional(),
  variant: safeLabel.optional(),
}).superRefine((terms, ctx) => {
  if (!terms.url && !terms.product) ctx.addIssue({ code: "custom", message: "Enter an exact product name or listing link.", path: ["product"] });
  if (!priceMinor(terms.amount, terms.currency)) ctx.addIssue({ code: "custom", message: "Enter a positive price in the selected currency's precision.", path: ["amount"] });
  if (!!terms.brand !== !!terms.mpn) ctx.addIssue({ code: "custom", message: "A manufacturer part number requires its brand.", path: ["mpn"] });
});
export type WatchTerms = z.output<typeof watchTerms>;

const variantDimensions = ["color", "size", "style", "model"] as const;
type VariantDimension = typeof variantDimensions[number];
type VariantOptions = Partial<Record<VariantDimension, string>>;
interface VariantScope { options: VariantOptions; gtin?: string }
export type SavedWatchTerms = WatchTerms & { resolvedVariant?: VariantScope };

export interface Observation {
  url: string; product: string; identity: string; variant: string; seller: string;
  manufacturerIdentity?: string;
  variantOptions?: VariantOptions;
  condition: z.infer<typeof conditionCode>; country: string; currency: string; amount: number;
  inStock: boolean; observedAt: number; expiresAt: number;
}

export function priceMinor(raw: unknown, currency: string): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const parts = /^(\d{1,12})(?:\.(\d+))?$/.exec(String(raw).trim());
  if (!parts || (parts[2]?.length ?? 0) > digits) return null;
  const integer = Number(parts[1] + (parts[2] ?? "").padEnd(digits, "0"));
  return Number.isSafeInteger(integer) ? integer : null;
}

export const normalized = (value: string) => value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
export const identityOf = (gtin?: string, brand?: string, mpn?: string) =>
  gtin ? `gtin:${gtin.padStart(14, "0")}` : brand && mpn ? `mpn:${normalized(brand)}:${normalized(mpn)}` : undefined;

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
const values = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined ? [] : [value];
const label = (value: unknown) => {
  const parsed = safeLabel.safeParse(value);
  return parsed.success ? parsed.data.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/[\u202A-\u202E\u2066-\u2069]/g, "").trim() : undefined;
};
const typeName = (value: unknown) => typeof value === "string" ? value.split(/[/#]/).pop() : undefined;
const hasType = (node: RecordValue, type: string) => values(node["@type"]).some(value => typeName(value) === type);
const gtinFields = ["gtin14", "gtin13", "gtin12", "gtin8", "gtin"] as const;

function* products(value: unknown, depth = 0): Generator<RecordValue> {
  if (depth > 7) return;
  for (const item of values(value)) {
    const node = record(item);
    if (hasType(node, "Product")) yield node;
    for (const child of ["@graph", "mainEntity", "hasVariant"]) yield* products(node[child], depth + 1);
  }
}

function regionCode(value: unknown) {
  const node = record(value);
  const code = typeof value === "string" ? value : node.addressCountry ?? (hasType(node, "Country") ? node.name : undefined);
  return typeof code === "string" && /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : undefined;
}

function limitedRegion(value: unknown) {
  const region = record(value);
  return ["addressRegion", "addressLocality", "postalCode", "postalCodePrefix", "postalCodeRange",
    "box", "circle", "line", "polygon", "geo", "geoMidpoint", "geoRadius"].some(key => region[key] != null);
}

function matchesMarket(url: string, market: string, currency: string) {
  for (const [key, value] of new URL(url).searchParams) {
    if (/^(country|market)$/i.test(key) && value.toUpperCase() !== market) return false;
    if (/^currency$/i.test(key) && value.toUpperCase() !== currency) return false;
    if (/^locale$/i.test(key)) {
      try {
        const { region } = new Intl.Locale(value.replaceAll("_", "-"));
        if (region && region !== market) return false;
      } catch { return false; }
    }
  }
  return true;
}

function variantOption(product: RecordValue, key: string) {
  const property = product[key];
  const declared = record(property).name ?? record(property).value ?? property;
  const text = label(typeof declared === "number" ? String(declared) : declared);
  return text ? normalized(text) : undefined;
}

function provesSelector(product: RecordValue, key: string, selector: string) {
  if (/^(sku|variant(?:_id)?|pid)$/i.test(key)) {
    return [product.sku, product.productID, product.mpn, product.gtin, product.gtin14, product.gtin13, product.gtin12, product.gtin8].includes(selector);
  }
  const dimension = variantDimensions.find(dimension => dimension === key.toLowerCase());
  return dimension !== undefined && variantOption(product, dimension) === normalized(selector);
}

const offerDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
function offerTime(value: unknown) {
  if (value == null) return Infinity;
  const parsed = offerDate.safeParse(value);
  return parsed.success ? Date.parse(parsed.data) : NaN;
}

function sameListing(value: unknown, url: string) {
  if (typeof value !== "string") return false;
  try { return listingUrl.safeParse(new URL(value, url).href).data === url; }
  catch { return false; }
}

function matchesOfferedProduct(value: unknown, product: RecordValue) {
  // A nested Offer implicitly applies to its Product unless it declares an explicit target.
  if (value == null) return true;
  const targets = values(value);
  if (targets.length !== 1) return false;
  const target = record(targets[0]);
  if (target["@context"] != null || (target["@type"] != null && !hasType(target, "Product"))) return false;

  const identifiers = ["@id", "sku", "productID", ...gtinFields];
  const details = ["name", "url", "brand", "mpn", "color", "size", "style", "model"];
  if ([...identifiers, ...details].some(key => target[key] != null && !isDeepStrictEqual(target[key], product[key]))) return false;
  return identifiers.some(key => Boolean(label(target[key]))) ||
    Boolean(label(target.mpn) && label(record(target.brand).name ?? target.brand));
}

function observation(product: RecordValue, offer: RecordValue, page: PageRead, market: string, now: number): Observation | null {
  if (!hasType(offer, "Offer") || hasType(offer, "AggregateOffer") || !matchesOfferedProduct(offer.itemOffered, product)
      || ["priceSpecification", "eligibleCustomerType", "eligibleQuantity", "validForMemberTier", "eligibleTransactionVolume",
        "eligibleDuration", "eligibleTradeIn", "eligiblePaymentMethod", "addOn"].some(key => offer[key] != null)) return null;
  if (offer.businessFunction != null) {
    const businessFunction = record(offer.businessFunction)["@id"] ?? offer.businessFunction;
    if (typeof businessFunction !== "string" || !/^https?:\/\/purl\.org\/goodrelations\/v1#Sell$/.test(businessFunction)) return null;
  }

  const explicit = values(offer.eligibleRegion ?? undefined).map(region => limitedRegion(region) ? undefined : regionCode(region));
  const shipping = values(offer.shippingDetails).map(record);
  const destinationCountry = (destination: unknown) => regionCode(record(destination).addressCountry);
  const excludesShipping = ({ doesNotShip }: RecordValue) => doesNotShip != null && doesNotShip !== false;
  // Even a regional shipping exclusion prevents verifying availability for the whole country.
  if (shipping.filter(excludesShipping).some(({ shippingDestination }) => {
    const destinations = values(shippingDestination ?? undefined);
    return !destinations.length || destinations.some(destination => {
      const country = destinationCountry(destination);
      return !country || country === market;
    });
  })) return null;
  const shipped = shipping.filter(details => !excludesShipping(details))
    .flatMap(({ shippingDestination }) => values(shippingDestination ?? undefined)
      .map(destination => limitedRegion(destination) ? undefined : destinationCountry(destination)));
  const excluded = values(offer.ineligibleRegion ?? undefined).map(regionCode);
  if ((!explicit.length && !shipped.length) || (explicit.length && !explicit.includes(market))
      || (shipped.length && !shipped.includes(market)) || excluded.some(region => !region || region === market)) return null;
  if (offer.availableAtOrFrom || /(?:pickup|collect|storepickup)/i.test(JSON.stringify(offer.availableDeliveryMethod ?? ""))) return null;

  const availability = typeName(offer.availability);
  if (availability !== "InStock" && availability !== "OnlineOnly" && availability !== "OutOfStock" && availability !== "SoldOut") return null;
  const condition = { NewCondition: "new", UsedCondition: "used", RefurbishedCondition: "refurbished" }[typeName(offer.itemCondition ?? product.itemCondition) ?? ""];
  if (!conditionCode.safeParse(condition).success) return null;
  const currency = currencyCode.safeParse(offer.priceCurrency);
  if (!currency.success || !matchesMarket(page.url, market, currency.data)) return null;
  const amount = priceMinor(offer.price, currency.data);
  const seller = label(record(offer.seller).name ?? offer.seller);
  const name = label(product.name), sku = label(product.sku);
  const brand = label(record(product.brand).name ?? product.brand);
  const gtin = gtinFields.map(key => product[key])
    .find((value): value is string => typeof value === "string" && /^\d{8,14}$/.test(value));
  const manufacturerIdentity = identityOf(undefined, brand, label(product.mpn));
  const identity = identityOf(gtin) ?? manufacturerIdentity ?? (sku && `sku:${new URL(page.url).hostname}:${normalized(sku)}`);
  const variant = sku ?? label(product.model) ?? label(product.mpn) ?? gtin;
  if (!name || !seller || !identity || !variant || amount === null) return null;
  const variantOptions: VariantOptions = {};
  for (const dimension of variantDimensions) {
    const value = variantOption(product, dimension);
    if (value) variantOptions[dimension] = value;
  }

  const observedAt = Math.min(now - page.ageSeconds * 1000, page.date ? Date.parse(page.date) : now);
  const expiresAt = Math.min(observedAt + 300_000, offerTime(offer.priceValidUntil), offerTime(offer.validThrough), offerTime(offer.availabilityEnds));
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) || expiresAt <= now || page.ageSeconds < 0) return null;
  if ([offer.validFrom, offer.availabilityStarts].some(start => start != null && !(offerTime(start) <= now))) return null;
  return { url: page.url, product: name, identity, variant, seller, condition: condition as Observation["condition"],
    ...(manufacturerIdentity && manufacturerIdentity !== identity ? { manufacturerIdentity } : {}),
    ...(Object.keys(variantOptions).length ? { variantOptions } : {}),
    country: market, currency: currency.data, amount, inStock: availability === "InStock" || availability === "OnlineOnly", observedAt, expiresAt };
}

function merchantMarkup(source: string) {
  const scripts: string[] = [];
  const liveSkus = new Set<string>();
  // Parse with browser HTML semantics. Template contents are kept in separate document fragments.
  const nodes = parse(source, { scriptingEnabled: true }).childNodes.slice();
  for (let node = nodes.pop(); node; node = nodes.pop()) {
    if (!defaultTreeAdapter.isElementNode(node)) continue;
    if (node.namespaceURI === html.NS.HTML) {
      const sku = node.attrs.find(attribute => attribute.name === "data-selected-sku")?.value;
      if (sku !== undefined) liveSkus.add(sku);
      if (node.tagName === "script" && node.attrs.some(attribute =>
        attribute.name === "type" && attribute.value.trim().toLowerCase() === "application/ld+json")) {
        scripts.push(node.childNodes.filter(defaultTreeAdapter.isTextNode).map(text => text.value).join(""));
      }
    }
    for (const child of node.childNodes) nodes.push(child);
  }
  return { scripts, liveSkus };
}

/** Read only unambiguous public offer markup tied to this listing and market. */
export function parseMerchantEvidence(page: PageRead, market: string, now = Date.now()): Observation | null {
  const selected = listingSelectors(page.url);
  // A hash is never sent in the HTTP request. Only a live selected-state reader can prove it.
  if (new URL(page.url).hash) return null;
  const { scripts, liveSkus } = merchantMarkup(page.html);
  const offers: Array<Observation | null> = [];
  if (liveSkus.size > 1) return null;
  for (const body of scripts) {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { continue; }
    for (const product of products(parsed)) {
      for (const value of values(product.offers)) {
        const offer = record(value);
        if (!sameListing(offer.url ?? product.url, page.url)) continue;
        if (offer.url && product.url && selected.length && !sameListing(product.url, page.url)) continue;
        if (liveSkus.size && (typeof product.sku !== "string" || !liveSkus.has(product.sku))) return null;
        if (selected.some(([key, selector]) => !provesSelector(product, key, selector))) return null;
        offers.push(observation(product, offer, page, market, now));
      }
    }
  }
  const first = offers[0];
  return first && offers.every(offer => JSON.stringify(offer) === JSON.stringify(first)) ? first : null;
}

export async function verifyListing(url: string, country: string, signal?: AbortSignal) {
  try {
    const listing = listingUrl.parse(url);
    const page = await readPublicPage(listing, value => listingUrl.parse(value), signal);
    if (!page) return null;
    const requested = new URL(listing), final = new URL(page.url);
    if (requested.origin !== final.origin || requested.search !== final.search || requested.hash !== final.hash ||
        requested.pathname.replace(/\/$/, "") !== final.pathname.replace(/\/$/, "")) return null;
    // Verify the final page, then keep the requested URL as the watch's stable listing ID.
    const item = parseMerchantEvidence(page, country);
    return item && { ...item, url: listing };
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

export function matchesIdentity(item: Observation, identity: string) {
  return item.identity === identity || item.manufacturerIdentity === identity;
}

function matchesVariant(item: Observation, variant: VariantScope) {
  const sameGtin = Boolean(variant.gtin && item.identity === variant.gtin);
  if (variant.gtin && !sameGtin && (item.identity.startsWith("gtin:") || !Object.keys(variant.options).length)) return false;
  return variantDimensions.every(dimension => {
    const expected = variant.options[dimension];
    const observed = item.variantOptions?.[dimension];
    // A shared GTIN proves equivalence across stores even when their declared options differ in completeness.
    return expected === observed || (sameGtin && (!expected || !observed));
  });
}

export function resolveVariant(items: Observation[]): VariantScope | undefined {
  const gtins = new Set(items.map(item => item.identity).filter(identity => identity.startsWith("gtin:")));
  if (!items.length || gtins.size > 1) return undefined;
  const gtin = gtins.values().next().value;
  const options: VariantOptions = {};
  for (const dimension of variantDimensions) {
    const values = new Set(items.map(item => item.variantOptions?.[dimension]));
    if (gtin) values.delete(undefined);
    if (values.size > 1) return undefined;
    const value = values.values().next().value;
    if (value) options[dimension] = value;
  }
  return { options, ...(gtin ? { gtin } : {}) };
}

export function sameOffer(item: Observation, saved: Observation) {
  return item.url === saved.url && item.identity === saved.identity && item.variant === saved.variant
    && normalized(item.seller) === normalized(saved.seller) && item.condition === saved.condition
    && item.currency === saved.currency && item.country === saved.country
    && matchesVariant(item, { options: saved.variantOptions ?? {}, gtin: saved.identity.startsWith("gtin:") ? saved.identity : undefined });
}

export function matchesTerms(item: Observation, terms: SavedWatchTerms, identity?: string) {
  const explicit = identityOf(terms.gtin, terms.brand, terms.mpn);
  const variant = terms.variant && normalized(terms.variant);
  return item.country === terms.country && item.currency === terms.currency && item.condition === terms.condition
    && (!terms.url || item.url === terms.url) && (!identity || matchesIdentity(item, identity))
    && (!explicit || matchesIdentity(item, explicit))
    && (!terms.resolvedVariant || matchesVariant(item, terms.resolvedVariant))
    && (!variant || [normalized(item.variant), normalized(item.product), ...Object.values(item.variantOptions ?? {})].includes(variant))
    && (!terms.seller || normalized(terms.seller) === normalized(item.seller));
}

export function meetsTarget(item: Observation, terms: WatchTerms) {
  const limit = priceMinor(terms.amount, terms.currency)!;
  return terms.comparison === "below" ? item.amount < limit : item.amount <= limit;
}

export function qualifies(item: Observation, terms: SavedWatchTerms, now = Date.now()) {
  return item.inStock && item.expiresAt > now && matchesTerms(item, terms) && meetsTarget(item, terms);
}

export function displayPrice(amount: number, currency: string) {
  const format = new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: "code" });
  return format.format(amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2)).replaceAll("\u00a0", " ");
}
