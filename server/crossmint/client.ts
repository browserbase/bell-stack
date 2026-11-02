import { randomUUID } from "node:crypto";

/**
 * Crossmint Agent Checkouts, server side.
 *
 * Crossmint runs the checkout at any store and exposes it as a run with status snapshots. Bell
 * holds the API key, the buyer id, the optional buyer profile, and the order intent on the server.
 * The model sees a projection of each snapshot and nothing else.
 * API reference: https://docs.crossmint.com/api-reference/agent-checkouts
 */

export class CrossmintSetupError extends Error {
  constructor(
    readonly reason: "missing_configuration" | "invalid_configuration",
    readonly setting: string,
  ) {
    super(`Check ${setting} in the server configuration.`);
    this.name = "CrossmintSetupError";
  }
}

/** Fixed messages. Provider bodies can echo the request, the key prefix, or merchant data. */
const REQUEST_MESSAGES = {
  unauthorized: "Crossmint rejected the API key or its scopes.",
  not_found: "Crossmint has no checkout with that id for this buyer.",
  rate_limited: "Crossmint rate limited the request. Retry shortly.",
  transport: "Crossmint request failed. Check connectivity and retry.",
  invalid_response: "Crossmint returned an unexpected response.",
};

export type CrossmintRequestReason = keyof typeof REQUEST_MESSAGES | "http_error";

export class CrossmintRequestError extends Error {
  constructor(
    readonly reason: CrossmintRequestReason,
    readonly status?: number,
  ) {
    super(reason === "http_error" ? `Crossmint returned HTTP ${status}.` : REQUEST_MESSAGES[reason]);
    this.name = "CrossmintRequestError";
  }
}

/** A request the operator's policy refuses before it reaches Crossmint. */
export class CrossmintPolicyError extends Error {
  constructor(
    readonly reason: "merchant_not_allowed" | "cap_exceeded" | "currency_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "CrossmintPolicyError";
  }
}

export interface MaxCost {
  amount: string;
  currency: string;
}

export interface CrossmintConfig {
  apiKey: string;
  userId: string;
  baseUrl: string;
  /** Optional saved buyer profile (name, email, shipping) so checkouts ask fewer questions. */
  buyerProfileId?: string;
  /** Optional ceiling on any single checkout's maxCost, enforced before the request is created. */
  maxCost?: MaxCost;
  /** Optional exact HTTPS origins a checkout may start from. Empty allows any merchant. */
  allowedMerchants: string[];
  /** The operator's approved order intent, used to pay. Never exposed to the model. */
  orderIntentId?: string;
}

export const DEFAULT_BASE_URL = "https://www.crossmint.com/api/unstable";

/** Crossmint's amount pattern, capped at two decimals. No zero, no leading zeros. */
export const AMOUNT = /^(?:[1-9]\d{0,14}(?:\.\d{1,2})?|0\.(?=\d*[1-9])\d{1,2})$/;
export const CURRENCY = /^[A-Z]{3}$/;

export function isCrossmintConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.CROSSMINT_SERVER_API_KEY?.trim() && env.CROSSMINT_USER_ID?.trim());
}

export function crossmintConfig(env: Record<string, string | undefined> = process.env): CrossmintConfig {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new CrossmintSetupError("missing_configuration", name);
    return value;
  };
  const invalid = (name: string) => new CrossmintSetupError("invalid_configuration", name);
  const httpsUrl = (value: string, name: string) => {
    const url = URL.parse(value);
    if (!url || url.protocol !== "https:" || url.username || url.password) throw invalid(name);
    return url;
  };

  const apiKey = required("CROSSMINT_SERVER_API_KEY");
  if (!apiKey.startsWith("sk_")) throw invalid("CROSSMINT_SERVER_API_KEY");
  const userId = required("CROSSMINT_USER_ID");
  const base = httpsUrl(env.CROSSMINT_API_BASE_URL?.trim() || DEFAULT_BASE_URL, "CROSSMINT_API_BASE_URL");
  if (base.search || base.hash) throw invalid("CROSSMINT_API_BASE_URL");

  let maxCost: MaxCost | undefined;
  const cap = env.CROSSMINT_MAX_COST?.trim();
  if (cap) {
    const [amount = "", currency = ""] = cap.split(/\s+/);
    if (!AMOUNT.test(amount) || !CURRENCY.test(currency)) throw invalid("CROSSMINT_MAX_COST");
    maxCost = { amount, currency };
  }

  const allowedMerchants = env.CROSSMINT_ALLOWED_MERCHANTS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  for (const origin of allowedMerchants) {
    if (httpsUrl(origin, "CROSSMINT_ALLOWED_MERCHANTS").origin !== origin) throw invalid("CROSSMINT_ALLOWED_MERCHANTS");
  }

  return {
    apiKey,
    userId,
    baseUrl: base.href.replace(/\/$/, ""),
    buyerProfileId: env.CROSSMINT_BUYER_PROFILE_ID?.trim() || undefined,
    maxCost,
    allowedMerchants,
    orderIntentId: env.CROSSMINT_ORDER_INTENT_ID?.trim() || undefined,
  };
}

/** Compare two decimal strings at Crossmint's six-decimal precision. Returns -1, 0, or 1. */
export function compareAmounts(a: string, b: string): number {
  const scale = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole + fraction.padEnd(6, "0").slice(0, 6));
  };
  const left = scale(a);
  const right = scale(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Enforce the operator's merchant allowlist and spending ceiling before anything is created. */
export function assertCheckoutPolicy(startUrl: string, maxCost: MaxCost, config: CrossmintConfig): void {
  if (config.allowedMerchants.length) {
    const url = URL.parse(startUrl);
    if (!url || url.protocol !== "https:" || url.username || url.password || !config.allowedMerchants.includes(url.origin)) {
      throw new CrossmintPolicyError("merchant_not_allowed", "This merchant is not in CROSSMINT_ALLOWED_MERCHANTS.");
    }
  }
  if (config.maxCost) {
    if (maxCost.currency !== config.maxCost.currency) {
      throw new CrossmintPolicyError("currency_mismatch", `Checkouts are limited to ${config.maxCost.currency} by CROSSMINT_MAX_COST.`);
    }
    if (compareAmounts(maxCost.amount, config.maxCost.amount) > 0) {
      throw new CrossmintPolicyError("cap_exceeded", `The spending cap exceeds the operator ceiling of ${config.maxCost.amount} ${config.maxCost.currency}.`);
    }
  }
}

export interface CreateCheckoutInput {
  startUrl: string;
  task: string;
  maxCost: MaxCost;
  merchantGuidance?: string;
  countryCode?: string;
}

export type CheckoutStatus = "queued" | "running" | "awaiting_input" | "succeeded" | "failed" | "cancelled" | "blocked";

const STATUSES: ReadonlySet<string> = new Set<CheckoutStatus>(["queued", "running", "awaiting_input", "succeeded", "failed", "cancelled", "blocked"]);

export const TERMINAL_STATUSES: ReadonlySet<CheckoutStatus> = new Set<CheckoutStatus>(["succeeded", "failed", "cancelled", "blocked"]);

/** Model-safe view of a form field. `protected` fields cannot be answered through the model. */
export interface CheckoutFormField {
  key: string;
  label: string;
  required: boolean;
  handling: "standard" | "protected";
  /** Crossmint's input kind: text, multiline, boolean, choice, integer, or number. */
  kind: string;
  /** For a choice field, the values the model may answer with. Placeholder and disabled options are left out. */
  options?: { value: string; label: string }[];
  selection?: "one" | "many";
}

export interface CheckoutAmount {
  kind: "exact" | "maximum";
  value: string;
  currency: string;
}

export interface CheckoutMerchant {
  name?: string;
  url?: string;
  countryCode?: string;
}

export type CheckoutInteraction =
  | { kind: "form"; fields: CheckoutFormField[] }
  | { kind: "payment"; method: string; amount: CheckoutAmount; merchant: CheckoutMerchant }
  | { kind: "unsupported" };

export interface CheckoutRequiredAction {
  requestId: string;
  question: string;
  expiresAt?: string;
  interaction: CheckoutInteraction;
}

/** The projection returned to the model. Browser URLs, the echoed input, and unknown fields are dropped. */
export interface CheckoutSnapshot {
  runId: string;
  status: CheckoutStatus;
  revision: number;
  requiredAction: CheckoutRequiredAction | null;
  result: {
    outcome?: string;
    summary?: string;
    code?: string;
    purchase?: { kind: string; receipt?: { total?: MaxCost; merchantOrderId?: string } };
  } | null;
  failureReason: string | null;
  /** While the run works, what Crossmint is doing. Only polls that ask for progress fill it. */
  progress?: CheckoutProgress;
}

/**
 * What a running checkout is doing, for a short update to the person: a fixed phrase chosen from
 * Crossmint's activity kinds. Crossmint's own progress text is never passed on. It can name the
 * buyer while the profile is applied, and it is written while reading merchant pages.
 */
export interface CheckoutProgress {
  stage: string;
}

export interface CrossmintClientOptions {
  config?: CrossmintConfig;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

const REQUEST_TIMEOUT_MS = 20_000;

async function request(path: string, init: { method: "GET" | "POST"; body?: unknown }, options: CrossmintClientOptions): Promise<unknown> {
  const config = options.config ?? crossmintConfig();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${config.baseUrl}${path}`, {
      method: init.method,
      headers: {
        "X-API-KEY": config.apiKey,
        "x-crossmint-user-id": config.userId,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "error",
      signal,
    });
  } catch {
    options.signal?.throwIfAborted();
    throw new CrossmintRequestError("transport");
  }
  if (!response.ok) {
    const reason: CrossmintRequestReason =
      response.status === 401 || response.status === 403 ? "unauthorized"
        : response.status === 404 ? "not_found"
          : response.status === 429 ? "rate_limited"
            : "http_error";
    throw new CrossmintRequestError(reason, response.status);
  }
  const text = await response.text().catch(() => "");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CrossmintRequestError("invalid_response", response.status);
  }
}

type Json = Record<string, unknown>;

const record = (value: unknown): Json => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {});
const string = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const present = <T extends Json>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

function projectField(raw: unknown): CheckoutFormField | undefined {
  const field = record(raw);
  const key = string(field.key);
  if (!key) return undefined;
  const input = record(field.input);
  const selectionKind = string(record(input.selection).kind);
  const selection = selectionKind === "one" || selectionKind === "many" ? selectionKind : undefined;
  const options = Array.isArray(input.options)
    ? input.options.flatMap((option) => {
        const { value, label, placeholder, disabled } = record(option);
        const v = string(value);
        return v === undefined || placeholder === true || disabled === true ? [] : [{ value: v, label: string(label) ?? v }];
      })
    : undefined;
  return {
    key,
    label: string(field.label) ?? key,
    required: field.required === true,
    handling: field.handling === "protected" ? "protected" : "standard",
    kind: string(input.kind) ?? "text",
    ...(options ? { options } : {}),
    ...(selection ? { selection } : {}),
  };
}

function projectInteraction(raw: unknown): CheckoutInteraction {
  const value = record(raw);
  if (value.kind === "form" && Array.isArray(value.fields)) {
    return { kind: "form", fields: value.fields.flatMap((field) => projectField(field) ?? []) };
  }
  if (value.kind === "payment") {
    const amount = record(value.amount);
    const merchant = record(value.merchant);
    return {
      kind: "payment",
      method: string(value.method) ?? "unknown",
      amount: { kind: amount.kind === "maximum" ? "maximum" : "exact", value: string(amount.value) ?? "", currency: string(amount.currency) ?? "" },
      merchant: present({ name: string(merchant.name), url: string(merchant.url), countryCode: string(merchant.countryCode) }),
    };
  }
  return { kind: "unsupported" };
}

/** Project a raw snapshot to the fields the model may see. Anything unlisted is discarded. */
export function projectCheckout(raw: unknown): CheckoutSnapshot {
  const run = record(raw);
  const runId = string(run.runId);
  const status = string(run.status);
  if (!runId || !status || !STATUSES.has(status)) throw new CrossmintRequestError("invalid_response");

  let requiredAction: CheckoutRequiredAction | null = null;
  const action = record(run.requiredAction);
  const requestId = string(action.requestId);
  if (status === "awaiting_input" && requestId) {
    const req = record(action.request);
    requiredAction = {
      requestId,
      question: string(req.question) ?? "",
      ...present({ expiresAt: string(req.expiresAt) }),
      interaction: projectInteraction(req.interaction),
    };
  }

  let result: CheckoutSnapshot["result"] = null;
  if (run.result !== undefined && run.result !== null) {
    const raw = record(run.result);
    const purchase = record(raw.purchase);
    const receipt = record(purchase.receipt);
    const total = record(receipt.total);
    const kind = string(purchase.kind);
    result = present({
      outcome: string(raw.outcome),
      summary: string(raw.summary),
      code: string(raw.code),
      purchase: kind
        ? {
            kind,
            ...(purchase.receipt !== undefined
              ? {
                  receipt: present({
                    total: string(total.amount) && string(total.currency) ? { amount: total.amount as string, currency: total.currency as string } : undefined,
                    merchantOrderId: string(receipt.merchantOrderId),
                  }),
                }
              : {}),
          }
        : undefined,
    });
  }

  return {
    runId,
    status: status as CheckoutStatus,
    revision: typeof run.revision === "number" ? run.revision : 0,
    requiredAction,
    result,
    failureReason: status === "failed" ? (string(run.reason) ?? "unknown") : null,
  };
}

export async function createCheckout(input: CreateCheckoutInput, options: CrossmintClientOptions = {}): Promise<{ runId: string }> {
  const config = options.config ?? crossmintConfig();
  assertCheckoutPolicy(input.startUrl, input.maxCost, config);
  const body = {
    request: { startUrl: input.startUrl, task: input.task },
    constraints: { maxCost: input.maxCost },
    ...present({
      buyerProfileId: config.buyerProfileId,
      merchantGuidance: input.merchantGuidance,
      browser: input.countryCode ? { location: { type: "country", countryCode: input.countryCode } } : undefined,
    }),
  };
  const runId = string(record(await request("/agent-checkouts", { method: "POST", body }, { ...options, config })).runId);
  if (!runId) throw new CrossmintRequestError("invalid_response");
  return { runId };
}

export async function getCheckout(runId: string, options: CrossmintClientOptions = {}): Promise<CheckoutSnapshot> {
  return projectCheckout(await request(`/agent-checkouts/${encodeURIComponent(runId)}`, { method: "GET" }, options));
}

export type FormAnswer = string | number | boolean | string[];

/** One `input_response` part per message, with a fresh message id. */
async function respond(runId: string, part: Json, options: CrossmintClientOptions): Promise<void> {
  await request(
    `/agent-checkouts/${encodeURIComponent(runId)}/messages`,
    { method: "POST", body: { id: `bell_${randomUUID()}`, parts: [{ type: "input_response", ...part }] } },
    options,
  );
}

export function answerForm(runId: string, requestId: string, answers: Record<string, FormAnswer>, options: CrossmintClientOptions = {}): Promise<void> {
  return respond(runId, { requestId, action: "submit", response: { kind: "form", answers } }, options);
}

/** Pay with the operator's order intent. The id is read from configuration and never returned. */
export async function payWithOrderIntent(runId: string, requestId: string, options: CrossmintClientOptions = {}): Promise<void> {
  const config = options.config ?? crossmintConfig();
  if (!config.orderIntentId) throw new CrossmintSetupError("missing_configuration", "CROSSMINT_ORDER_INTENT_ID");
  await respond(runId, { requestId, action: "submit", response: { kind: "payment", orderIntentId: config.orderIntentId } }, { ...options, config });
}

export function declineRequest(runId: string, requestId: string, options: CrossmintClientOptions = {}): Promise<void> {
  return respond(runId, { requestId, action: "decline" }, options);
}

export async function cancelCheckout(runId: string, options: CrossmintClientOptions = {}): Promise<void> {
  await request(`/agent-checkouts/${encodeURIComponent(runId)}/cancel`, { method: "POST" }, options);
}

/**
 * Saved name, contact, and shipping address that checkouts use instead of asking. It holds no
 * payment data. Only the operator setup page reads or writes it; the model never sees it.
 */
export interface BuyerProfile {
  id: string;
  label?: string;
  name?: { first: string; last: string };
  contact?: { email?: string; phone?: string };
  shipping: { addressLines: string[]; locality: string; countryCode: string; administrativeAreaCode?: string | null; postalCode?: string | null };
}

export type NewBuyerProfile = Omit<BuyerProfile, "id">;

function projectBuyerProfile(raw: unknown): BuyerProfile {
  const body = record(raw);
  const shipping = record(body.shipping);
  const id = string(body.id);
  const lines = Array.isArray(shipping.addressLines) ? shipping.addressLines.filter((line): line is string => typeof line === "string") : [];
  if (!id || !lines.length || !string(shipping.locality) || !string(shipping.countryCode)) throw new CrossmintRequestError("invalid_response");
  const name = record(body.name);
  const contact = record(body.contact);
  return {
    id,
    ...present({ label: string(body.label) }),
    ...(string(name.first) && string(name.last) ? { name: { first: string(name.first)!, last: string(name.last)! } } : {}),
    ...(string(contact.email) || string(contact.phone) ? { contact: present({ email: string(contact.email), phone: string(contact.phone) }) } : {}),
    shipping: {
      addressLines: lines,
      locality: string(shipping.locality)!,
      countryCode: string(shipping.countryCode)!,
      administrativeAreaCode: string(shipping.administrativeAreaCode) ?? null,
      postalCode: string(shipping.postalCode) ?? null,
    },
  };
}

export async function getBuyerProfile(id: string, options: CrossmintClientOptions = {}): Promise<BuyerProfile> {
  return projectBuyerProfile(await request(`/agent-checkouts/buyer-profiles/${encodeURIComponent(id)}`, { method: "GET" }, options));
}

export async function createBuyerProfile(profile: NewBuyerProfile, options: CrossmintClientOptions = {}): Promise<BuyerProfile> {
  return projectBuyerProfile(await request("/agent-checkouts/buyer-profiles", { method: "POST", body: profile }, options));
}

/** Activity kinds, most telling first, and the phrase the person sees for them. */
const STAGES: ReadonlyArray<[readonly string[], string]> = [
  [["apply_payment"], "Applying the payment"],
  [["apply_buyer_information"], "Filling in the delivery details"],
  [["create_checkout"], "Starting the store's checkout"],
  [["call_webmcp_tool"], "Using the store's checkout tools"],
  [["lookup_product", "search_catalog"], "Finding the product"],
  [["navigate", "read_playbook"], "Opening the store"],
];
const DEFAULT_STAGE = "Working through the store's checkout";

/** The latest stage in a run's messages, in any order Crossmint returns them. */
export function projectProgress(messages: unknown[]): CheckoutProgress | undefined {
  const latest = new Map<string, Json>();
  for (const raw of messages) {
    const message = record(raw);
    const id = string(message.id);
    if (!id) continue;
    const previous = latest.get(id);
    if (!previous || Number(message.revision) >= Number(previous.revision)) latest.set(id, message);
  }
  const ordered = [...latest.values()].sort((a, b) => Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt)));
  let stage: string | undefined;
  for (const message of ordered) {
    if (message.role !== "assistant" || !Array.isArray(message.parts)) continue;
    for (const part of message.parts.map(record)) {
      if (part.type !== "activity" || !Array.isArray(part.operations)) continue;
      const kinds = new Set(part.operations.map((operation) => string(record(operation).kind)).filter(Boolean));
      stage = STAGES.find(([candidates]) => candidates.some((kind) => kinds.has(kind)))?.[1] ?? DEFAULT_STAGE;
    }
  }
  return stage ? { stage } : undefined;
}

/** Read the run's messages, at most five pages, and project its latest progress. */
export async function getCheckoutProgress(runId: string, options: CrossmintClientOptions = {}): Promise<CheckoutProgress | undefined> {
  const messages: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const query = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const body = record(await request(`/agent-checkouts/${encodeURIComponent(runId)}/messages?${query}`, { method: "GET" }, options));
    if (Array.isArray(body.data)) messages.push(...body.data);
    cursor = string(body.nextCursor);
    if (!cursor) break;
  }
  return projectProgress(messages);
}

export interface WaitOptions extends CrossmintClientOptions {
  /** Stop waiting after this many milliseconds and return the latest snapshot. */
  timeoutMs?: number;
  intervalMs?: number;
  /** A request id already answered. Crossmint can keep showing it briefly. */
  skipRequestId?: string;
  /**
   * Report progress while the run works: return early once the stage differs from this one (null
   * means any stage), but not before `minProgressMs`, so the person gets one update per step.
   */
  progressSince?: string | null;
  minProgressMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Poll until the checkout needs input or ends, or until the timeout. Always returns a snapshot. */
export async function waitForCheckout(runId: string, options: WaitOptions = {}): Promise<CheckoutSnapshot> {
  const intervalMs = options.intervalMs ?? 2_000;
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? 90_000);
  const watchProgress = options.progressSince !== undefined;
  let snapshot = await getCheckout(runId, options);
  let progress: CheckoutProgress | undefined;
  let progressReadAt = 0;
  for (;;) {
    const settled =
      TERMINAL_STATUSES.has(snapshot.status) ||
      (snapshot.status === "awaiting_input" && snapshot.requiredAction !== null && snapshot.requiredAction.requestId !== options.skipRequestId);
    if (settled) return snapshot;
    const working = snapshot.status === "running" || snapshot.status === "queued";
    if (watchProgress && working && Date.now() - progressReadAt >= intervalMs * 3) {
      progressReadAt = Date.now();
      // Progress is a courtesy: it never outlasts the wait, and only a cancellation stops it.
      const remaining = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const signal = options.signal ? AbortSignal.any([options.signal, remaining]) : remaining;
      progress = await getCheckoutProgress(runId, { ...options, signal }).catch((error: unknown) => {
        if (options.signal?.aborted) throw error;
        return progress;
      });
      const changed = progress !== undefined && progress.stage !== options.progressSince;
      if (changed && Date.now() - started >= (options.minProgressMs ?? 0)) return { ...snapshot, progress };
    }
    if (Date.now() >= deadline) return watchProgress && working && progress ? { ...snapshot, progress } : snapshot;
    options.signal?.throwIfAborted();
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), options.signal);
    const next = await getCheckout(runId, options);
    if (next.revision >= snapshot.revision) snapshot = next;
  }
}
