import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { crossmintConfig, CrossmintRequestError, CrossmintSetupError, type CrossmintConfig } from "./client";
import { operatorJwt, parseRsaPrivateKey } from "./operator-jwt";

/**
 * Calls Crossmint makes only for a signed-in user: saving and registering cards, and approving,
 * listing, and cancelling order intents. They take a client key with the user's JWT, never a server
 * key. Bell serves one operator, so it signs that JWT itself (operator-jwt.ts) and sends Bell's
 * origin, which must be an allowed origin of the client key.
 *
 * These calls serve the operator setup page. None of their results reach the model.
 * API reference: https://docs.crossmint.com/api-reference/agentic-commerce/order-intents/list-order-intents
 */

export interface OperatorConfig extends CrossmintConfig {
  /** Client key (ck_). */
  clientApiKey: string;
  /** Crossmint project id, the `iss` of the operator JWT. */
  projectId: string;
  privateKey: KeyObject;
  /** Bell's origin, sent with every call. */
  origin: string;
}

export const OPERATOR_SETTINGS = ["CROSSMINT_CLIENT_API_KEY", "CROSSMINT_PROJECT_ID", "CROSSMINT_JWT_PRIVATE_KEY"] as const;

export function isOperatorConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return OPERATOR_SETTINGS.every((name) => Boolean(env[name]?.trim()));
}

export function operatorConfig(env: Record<string, string | undefined> = process.env): OperatorConfig {
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

  return { ...base, clientApiKey, projectId, privateKey, origin: publicUrl.origin };
}

/**
 * A refused operator call. `detail` is Crossmint's own message, shown to the operator on the setup
 * page because it names the fix (for example a missing consumer email). It never reaches the model.
 */
export class CrossmintOperatorError extends Error {
  constructor(
    readonly reason: "unauthorized" | "not_found" | "rejected",
    readonly status: number,
    readonly detail?: string,
  ) {
    super(
      reason === "unauthorized"
        ? "Crossmint rejected the client key, its allowed origins, or Bell's operator token."
        : reason === "not_found"
          ? "Crossmint found nothing with that id for this operator."
          : `Crossmint refused the request (HTTP ${status}).`,
    );
    this.name = "CrossmintOperatorError";
  }
}

export interface OperatorClientOptions {
  config?: OperatorConfig;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

const REQUEST_TIMEOUT_MS = 20_000;

/** One call with the client key, the operator JWT, and Bell's origin. */
export async function operatorRequest(
  path: string,
  init: { method: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; idempotencyKey?: string },
  options: OperatorClientOptions = {},
): Promise<Response> {
  const config = options.config ?? operatorConfig();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  try {
    return await (options.fetch ?? fetch)(`${config.baseUrl}${path}`, {
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
}

async function json(response: Response): Promise<unknown> {
  if (!response.ok) {
    let detail: string | undefined;
    try {
      const body = (await response.json()) as { message?: unknown; error?: unknown };
      const text = (value: unknown) =>
        typeof value === "string" ? value : Array.isArray(value) ? value.filter((item) => typeof item === "string").join("; ") : undefined;
      detail = (text(body.message) || text(body.error))?.slice(0, 300) || undefined;
    } catch {
      detail = undefined;
    }
    const reason = response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 404 ? "not_found" : "rejected";
    throw new CrossmintOperatorError(reason, response.status, detail);
  }
  if (response.status === 204) return null;
  const text = await response.text().catch(() => "");
  if (!text.trim()) return null;
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
  error: z.object({ code: z.string().optional() }).nullish(),
});

const merchantSchema = z.object({ name: z.string().optional(), url: z.string(), countryCode: z.string().optional() });

const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);

export const orderIntentSchema = z.object({
  orderIntentId: z.string(),
  paymentMethodId: z.string().optional(),
  status: z.string(),
  amount: z.object({ total: decimal.optional(), spent: decimal.optional(), available: decimal, currency: z.string() }),
  merchant: merchantSchema.nullish(),
  description: z.string().optional(),
  expiresAt: z.string(),
  rails: z.array(railSchema),
  verificationConfig: z.unknown().optional(),
});

export type OrderIntentSummary = z.infer<typeof orderIntentSchema>;

const registrationSchema = z.object({
  paymentMethodId: z.string(),
  rails: z.array(railSchema),
});

export type CardRegistration = z.infer<typeof registrationSchema>;

/** What a card-network rail needs to know about the person, sent once per saved card. */
export interface Consumer {
  email: string;
  /** ISO 3166-1 alpha-2. */
  countryCode: string;
  /** BCP 47, such as en-US or es-ES. */
  languageCode: string;
}

/** The card's order-intent registration, or null when the card was never registered. */
export async function getRegistration(paymentMethodId: string, options: OperatorClientOptions = {}): Promise<CardRegistration | null> {
  const path = `/payment-methods/${encodeURIComponent(paymentMethodId)}/order-intent-registration`;
  try {
    const parsed = registrationSchema.safeParse(await json(await operatorRequest(path, { method: "GET" }, options)));
    if (!parsed.success) throw new CrossmintRequestError("invalid_response");
    return parsed.data;
  } catch (error) {
    if (error instanceof CrossmintOperatorError && error.reason === "not_found") return null;
    throw error;
  }
}

/**
 * Register a saved card for order intents with the person's email, country, and language. Crossmint
 * needs the email to provision card-network rails, and Bell's operator JWT carries none, so an
 * empty registration is refused. Registering is idempotent and grants no spending.
 */
export async function registerCard(paymentMethodId: string, consumer: Consumer, options: OperatorClientOptions = {}): Promise<CardRegistration> {
  const path = `/payment-methods/${encodeURIComponent(paymentMethodId)}/order-intent-registration`;
  const body = { email: consumer.email, countryCode: consumer.countryCode.toUpperCase(), languageCode: consumer.languageCode };
  const parsed = registrationSchema.safeParse(await json(await operatorRequest(path, { method: "PUT", body }, options)));
  if (!parsed.success) throw new CrossmintRequestError("invalid_response");
  return parsed.data;
}

/** Every order intent of the operator, newest expiry first. */
export async function listOrderIntents(options: OperatorClientOptions = {}): Promise<OrderIntentSummary[]> {
  const raw = await json(await operatorRequest("/order-intents", { method: "GET" }, options));
  const parsed = z.array(orderIntentSchema).safeParse(Array.isArray(raw) ? raw : (raw as { data?: unknown } | null)?.data);
  if (!parsed.success) throw new CrossmintRequestError("invalid_response");
  return parsed.data.sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt));
}

export interface NewOrderIntent {
  paymentMethodId: string;
  amount: { value: string; currency: string };
  merchant: { name: string; url: string; countryCode: string };
  description: string;
  expiresAt: string;
}

/** Approve a budget on a saved, registered card for one merchant. */
export async function createOrderIntent(
  input: NewOrderIntent,
  options: OperatorClientOptions & { idempotencyKey?: string } = {},
): Promise<OrderIntentSummary> {
  const body = { ...input, amount: { value: input.amount.value, currency: input.amount.currency.toUpperCase() } };
  const init = { method: "POST" as const, body, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) };
  const parsed = orderIntentSchema.safeParse(await json(await operatorRequest("/order-intents", init, options)));
  if (!parsed.success) throw new CrossmintRequestError("invalid_response");
  return parsed.data;
}

/** Cancel an order intent. Later reads show it as cancelled and nothing more can be spent. */
export async function cancelOrderIntent(orderIntentId: string, options: OperatorClientOptions = {}): Promise<void> {
  await json(await operatorRequest(`/order-intents/${encodeURIComponent(orderIntentId)}`, { method: "DELETE" }, options));
}

/** Rails as the setup page shows them. Agent Checkouts can pay even when none is active. */
export function describeRail(rail: z.infer<typeof railSchema>): string {
  const name =
    rail.rail === "agentic-token"
      ? rail.provider === "vic" ? "Visa Intelligent Commerce" : rail.provider === "agentpay" ? "Mastercard Agent Pay" : "Card network token"
      : rail.rail === "encrypted-card" ? "Encrypted card"
        : rail.rail === "spt" ? "Stripe shared payment token" : rail.rail;
  return `${name}: ${rail.status.replaceAll("_", " ")}`;
}
