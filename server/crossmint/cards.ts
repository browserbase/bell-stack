import { createHash, type KeyObject } from "node:crypto";
import { z } from "zod";
import {
  compareAmounts,
  crossmintConfig,
  CrossmintRequestError,
  CrossmintSetupError,
  isCrossmintConfigured,
  type CrossmintConfig,
  type MaxCost,
} from "./client";
import { operatorJwt, parseRsaPrivateKey } from "./operator-jwt";
import { hostOf } from "./payment";

/**
 * Crossmint Agent Cards, server side.
 *
 * The person approves an order intent in Crossmint beforehand: a saved card, an amount, a merchant,
 * and an expiry. At payment time Bell reads the order intent, checks it against the payment the
 * person approved in chat, and mints a one-time card on the card network's rail, Visa Intelligent
 * Commerce or Mastercard Agent Pay. The card is filled into the merchant page on the server and is
 * never returned. A mint spends its amount at once, even if the card is never used, so every check
 * runs before it.
 * API reference: https://docs.crossmint.com/api-reference/agentic-commerce/order-intents/get-order-intent
 */

export interface CardConfig extends CrossmintConfig {
  /** Client key (ck_). Order intents accept a client key with the user's JWT, not a server key. */
  clientApiKey: string;
  /** Crossmint project id, the `iss` of the operator JWT. */
  projectId: string;
  privateKey: KeyObject;
  /** Bell's origin, sent with every call. It must be an allowed origin of the client key. */
  origin: string;
  /** Payment-frame origins trusted per merchant origin, such as a payment provider's card iframe. */
  checkoutOrigins: Record<string, string[]>;
}

export function isCrossmintCardsConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return isCrossmintConfigured(env) && Boolean(env.CROSSMINT_CLIENT_API_KEY?.trim() && env.CROSSMINT_JWT_PRIVATE_KEY?.trim());
}

const exactHttpsOrigin = (value: string) => {
  const url = URL.parse(value);
  return url?.protocol === "https:" && url.origin === value;
};

export function cardConfig(env: Record<string, string | undefined> = process.env): CardConfig {
  const base = crossmintConfig(env);
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new CrossmintSetupError("missing_configuration", name);
    return value;
  };
  const invalid = (name: string) => new CrossmintSetupError("invalid_configuration", name);

  const clientApiKey = required("CROSSMINT_CLIENT_API_KEY");
  const production = new URL(base.baseUrl).hostname === "www.crossmint.com";
  if (!clientApiKey.startsWith("ck_") || clientApiKey.startsWith("ck_production_") !== production) throw invalid("CROSSMINT_CLIENT_API_KEY");
  const projectId = required("CROSSMINT_PROJECT_ID");
  const privateKey = parseRsaPrivateKey(required("CROSSMINT_JWT_PRIVATE_KEY"));
  if (!privateKey) throw invalid("CROSSMINT_JWT_PRIVATE_KEY");

  const publicUrl = URL.parse(required("BELL_PUBLIC_URL"));
  const loopback = publicUrl?.protocol === "http:" && /^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(publicUrl.hostname);
  if (!publicUrl || publicUrl.username || publicUrl.password || (publicUrl.protocol !== "https:" && !loopback)) throw invalid("BELL_PUBLIC_URL");

  let checkoutOrigins: Record<string, string[]>;
  try {
    checkoutOrigins = z.record(z.string(), z.array(z.string())).parse(JSON.parse(env.CROSSMINT_CHECKOUT_ORIGINS?.trim() || "{}"));
  } catch {
    throw invalid("CROSSMINT_CHECKOUT_ORIGINS");
  }
  if (Object.entries(checkoutOrigins).some(([merchant, origins]) => !exactHttpsOrigin(merchant) || !origins.every(exactHttpsOrigin))) {
    throw invalid("CROSSMINT_CHECKOUT_ORIGINS");
  }

  return { ...base, clientApiKey, projectId, privateKey, origin: publicUrl.origin, checkoutOrigins };
}

/** Fixed messages the model may see. Crossmint's own error messages are never passed on. */
const CARD_MESSAGES = {
  unauthorized: "Crossmint rejected the client key, its allowed origins, or Bell's operator token.",
  order_intent_not_found: "Crossmint has no order intent with that id for this operator. Check CROSSMINT_ORDER_INTENT_ID and CROSSMINT_USER_ID.",
  order_intent_inactive: "The order intent is cancelled. Ask the person to approve a new one.",
  order_intent_expired: "The order intent has expired or expires within a minute. Ask the person to approve a new one.",
  merchant_scope_required: "The order intent names no merchant. Ask the person to approve one for this merchant.",
  merchant_mismatch: "The order intent is for a different merchant.",
  currency_mismatch: "The order intent is in a different currency.",
  insufficient_allowance: "The amount is more than what is left on the order intent.",
  rail_pending_verification: "The card is not verified for this order intent yet. Ask the person to finish verification in the card setup.",
  rail_error: "The card network turned this card down for agent payments. Ask the person to use another card.",
  no_card_rail: "This card has neither a Visa Intelligent Commerce nor a Mastercard Agent Pay rail, so Bell cannot pay with it here.",
  invalid_merchant: "The merchant must be an HTTPS URL or a host name.",
  unsupported_amount: "The amount has more decimals than the currency allows.",
  cvc_recollection_required: "Crossmint needs the card's CVC again. Ask the person to re-enter it in the card setup. No card was issued.",
  payment_method_deleted: "The card behind the order intent was removed. Ask the person to save a card and approve a new order intent.",
  credential_already_issued: "This payment already issued its card. Do not retry. Check the merchant page through human handoff.",
  credential_unavailable: "Crossmint could not issue a card for this payment. Tell the person and do not retry.",
  retry_later: "Crossmint is still issuing a card for this payment. Check the merchant page before any retry.",
  unexpected_credential: "Crossmint returned a card that does not match this payment, so nothing was filled. Tell the person.",
} as const;

export type CardReason = keyof typeof CARD_MESSAGES;

export class CrossmintCardError extends Error {
  constructor(readonly reason: CardReason) {
    super(CARD_MESSAGES[reason]);
    this.name = "CrossmintCardError";
  }
}

/** Crossmint error codes an operator or the person has to act on. Any other code stays an HTTP status. */
const ERROR_CODES: Readonly<Record<string, CardReason>> = {
  ORDER_INTENT_CVC_RECOLLECTION_REQUIRED: "cvc_recollection_required",
  "payments:payment-method.deleted": "payment_method_deleted",
  ORDER_INTENT_CREDENTIAL_ALREADY_ISSUED: "credential_already_issued",
  ORDER_INTENT_AMOUNT_EXCEEDED: "insufficient_allowance",
  ORDER_INTENT_EXPIRED: "order_intent_expired",
  ORDER_INTENT_CANCELLED: "order_intent_inactive",
  ORDER_INTENT_CREDENTIAL_UNAVAILABLE: "credential_unavailable",
  ORDER_INTENT_PROVIDER_OPERATION_IN_PROGRESS: "retry_later",
};

export interface CardClientOptions {
  config?: CardConfig;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

const REQUEST_TIMEOUT_MS = 20_000;

async function errorReason(response: Response): Promise<CardReason | undefined> {
  try {
    const { code } = (await response.json()) as { code?: unknown };
    return typeof code === "string" && Object.hasOwn(ERROR_CODES, code) ? ERROR_CODES[code] : undefined;
  } catch {
    return undefined;
  }
}

/** One call with the client key, the operator JWT, and Bell's origin. */
export async function cardRequest(
  path: string,
  init: { method: "GET" | "POST" | "PUT"; body?: unknown; idempotencyKey?: string },
  options: CardClientOptions = {},
): Promise<unknown> {
  const config = options.config ?? cardConfig();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${config.baseUrl}${path}`, {
      method: init.method,
      headers: {
        "X-API-KEY": config.clientApiKey,
        Authorization: `Bearer ${operatorJwt(config)}`,
        Origin: config.origin,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
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
    const reason = await errorReason(response);
    if (reason) throw new CrossmintCardError(reason);
    if (response.status === 401 || response.status === 403) throw new CrossmintCardError("unauthorized");
    if (response.status === 404) throw new CrossmintCardError("order_intent_not_found");
    throw new CrossmintRequestError(response.status === 429 ? "rate_limited" : "http_error", response.status);
  }
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CrossmintRequestError("invalid_response", response.status);
  }
}

const railSchema = z.object({
  rail: z.string(),
  provider: z.string().optional(),
  status: z.string(),
  credentialFormats: z.array(z.string()).optional(),
});

const orderIntentSchema = z.object({
  status: z.string(),
  amount: z.object({ available: z.string().regex(/^\d+(?:\.\d+)?$/), currency: z.string() }),
  expiresAt: z.string(),
  merchant: z.object({ url: z.string() }).nullish(),
  rails: z.array(railSchema),
});

export type OrderIntent = z.infer<typeof orderIntentSchema>;
export type CardProvider = "vic" | "agentpay";

function orderIntentPath(config: CardConfig): string {
  if (!config.orderIntentId) throw new CrossmintSetupError("missing_configuration", "CROSSMINT_ORDER_INTENT_ID");
  return `/order-intents/${encodeURIComponent(config.orderIntentId)}`;
}

/** Read the operator's order intent. Only refusal reasons derived from it reach the model. */
export async function getOrderIntent(options: CardClientOptions = {}): Promise<OrderIntent> {
  const config = options.config ?? cardConfig();
  const parsed = orderIntentSchema.safeParse(await cardRequest(orderIntentPath(config), { method: "GET" }, { ...options, config }));
  if (!parsed.success) throw new CrossmintRequestError("invalid_response");
  return parsed.data;
}

/** HTTPS origin of the merchant the model named, from a URL or a bare host. */
export function merchantOrigin(merchant: string): string {
  const url = URL.parse(merchant.includes("://") ? merchant : `https://${merchant}`);
  if (!url || url.protocol !== "https:" || url.username || url.password) throw new CrossmintCardError("invalid_merchant");
  return url.origin;
}

/** The merchant origin and any payment-frame origins the operator trusts for it. */
export function paymentOrigins(config: CardConfig, origin: string): string[] {
  return [...new Set([origin, ...(config.checkoutOrigins[origin] ?? [])])];
}

/** The order intent must be live, scoped to this merchant, in this currency, with room for the amount and a verified card rail. */
export function assertCardPayment(intent: OrderIntent, payment: MaxCost & { merchant: string }, now = Date.now()): { provider: CardProvider } {
  if (intent.status === "expired") throw new CrossmintCardError("order_intent_expired");
  if (intent.status !== "active") throw new CrossmintCardError("order_intent_inactive");
  const expiresAt = Date.parse(intent.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt - now < 60_000) throw new CrossmintCardError("order_intent_expired");
  if (!intent.merchant?.url) throw new CrossmintCardError("merchant_scope_required");
  const host = hostOf(intent.merchant.url);
  if (!host || host !== hostOf(payment.merchant)) throw new CrossmintCardError("merchant_mismatch");
  if (intent.amount.currency.toUpperCase() !== payment.currency) throw new CrossmintCardError("currency_mismatch");
  if (compareAmounts(intent.amount.available, payment.amount) < 0) throw new CrossmintCardError("insufficient_allowance");

  const rails = intent.rails.filter(
    (rail): rail is typeof rail & { provider: CardProvider } => rail.rail === "agentic-token" && (rail.provider === "vic" || rail.provider === "agentpay"),
  );
  const active = rails.find((rail) => rail.status === "active" && rail.credentialFormats?.includes("card"));
  if (active) return { provider: active.provider };
  if (rails.some((rail) => rail.status === "pending_verification")) throw new CrossmintCardError("rail_pending_verification");
  if (rails.some((rail) => rail.status === "error")) throw new CrossmintCardError("rail_error");
  throw new CrossmintCardError("no_card_rail");
}

/** Stable per tool call, so a re-run of the same call never mints a second card. */
export function idempotencyKey(sessionId: string, callId: string): string {
  return `bell-card-${createHash("sha256").update(`${sessionId}:${callId}`).digest("hex")}`;
}

/** The amount in the currency's smallest unit, for the browser fill's input record. */
export function checkoutAmount(amount: string, currency: string): number {
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const [whole, fraction = ""] = amount.split(".");
  const minor = Number(whole + fraction.padEnd(digits, "0"));
  if (fraction.length > digits || !Number.isSafeInteger(minor) || minor <= 0) throw new CrossmintCardError("unsupported_amount");
  return minor;
}

const issuedSchema = z.object({
  rail: z.literal("agentic-token"),
  amount: z.object({ value: z.string().regex(/^\d+(?:\.\d+)?$/), currency: z.string() }),
  expiresAt: z.string().optional(),
  credential: z.object({
    format: z.literal("card"),
    value: z.object({
      number: z.string().regex(/^\d{12,19}$/),
      expirationMonth: z.number().int().min(1).max(12),
      expirationYear: z.number().int().min(0),
      cvc: z.string().regex(/^\d{3,4}$/),
    }),
  }),
});

/** The shape the browser fill expects. It lives only inside the fill operation. */
export interface CardCredential {
  card: { number: string; cvc: string; exp_month: number; exp_year: number; valid_until?: string };
}

export function projectCard(raw: unknown, requested: MaxCost): CardCredential {
  const parsed = issuedSchema.safeParse(raw);
  if (!parsed.success) throw new CrossmintCardError("unexpected_credential");
  const { amount, expiresAt, credential } = parsed.data;
  if (amount.currency.toUpperCase() !== requested.currency || compareAmounts(amount.value, requested.amount) !== 0) {
    throw new CrossmintCardError("unexpected_credential");
  }
  const { number, cvc, expirationMonth, expirationYear } = credential.value;
  return {
    card: {
      number,
      cvc,
      exp_month: expirationMonth,
      exp_year: expirationYear < 100 ? 2000 + expirationYear : expirationYear,
      ...(expiresAt ? { valid_until: expiresAt } : {}),
    },
  };
}

/** Mint a one-time card for exactly this amount on the order intent's network rail. */
export async function mintCard(provider: CardProvider, amount: MaxCost, key: string, options: CardClientOptions = {}): Promise<CardCredential> {
  const config = options.config ?? cardConfig();
  const body = {
    rail: "agentic-token",
    provider,
    amount: { value: amount.amount, currency: amount.currency },
    credential: { format: "card" },
  };
  const raw = await cardRequest(`${orderIntentPath(config)}/credentials`, { method: "POST", body, idempotencyKey: key }, { ...options, config });
  return projectCard(raw, amount);
}
