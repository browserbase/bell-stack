import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertCardPayment,
  cardConfig,
  cardRequest,
  checkoutAmount,
  CrossmintCardError,
  getOrderIntent,
  idempotencyKey,
  isCrossmintCardsConfigured,
  merchantOrigin,
  mintCard,
  paymentOrigins,
  projectCard,
  type CardReason,
  type OrderIntent,
} from "../server/crossmint/cards.js";
import { CrossmintRequestError } from "../server/crossmint/client.js";
import { operatorJwks, operatorJwt, parseRsaPrivateKey } from "../server/crossmint/operator-jwt.js";
import { paymentValues, type CheckoutInput } from "../server/link/payment.js";
import { withBrowserPrivacyLock } from "../server/browser/privacy-lock.js";
import { GET as jwksRoute } from "../app/api/crossmint/jwks/route.js";
import cardTool from "../agent/tools/crossmint_card_checkout.js";
import { runBrowserOperation } from "../agent/lib/browser-runtime.js";
import { checkoutInHostedPage } from "../server/link/checkout-browser.js";

vi.mock("../agent/lib/browser-runtime", () => ({
  runCancelableBrowserWork: (_id: string, _signal: AbortSignal, operation: () => unknown) => operation(),
  runBrowserOperation: vi.fn(async (_id: string, operation: (browser: unknown) => unknown) => ({
    result: await operation({
      withHostedPage: (_signal: AbortSignal, call: (page: unknown, url: string) => unknown, privateResult: boolean) => {
        expect(privateResult).toBe(true);
        return call({}, "private-connection");
      },
    }),
    workbench: { private: "not-returned" },
  })),
}));
vi.mock("../server/link/checkout-browser", () => ({ checkoutInHostedPage: vi.fn() }));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const NUMBER = "4000001000004242";
const CVC = "735";
const future = () => new Date(Date.now() + 86_400_000).toISOString();

const env = {
  CROSSMINT_SERVER_API_KEY: "sk_unit_test_only",
  CROSSMINT_USER_ID: "operator-1",
  CROSSMINT_CLIENT_API_KEY: "ck_production_unit_test_only",
  CROSSMINT_PROJECT_ID: "project-1",
  CROSSMINT_JWT_PRIVATE_KEY: Buffer.from(privatePem).toString("base64"),
  CROSSMINT_ORDER_INTENT_ID: "oi_test_secret",
  CROSSMINT_CHECKOUT_ORIGINS: JSON.stringify({ "https://shop.example": ["https://pay.example"] }),
  BELL_PUBLIC_URL: "https://bell.example",
};

const intent = (overrides: Partial<Record<keyof OrderIntent | "orderIntentId", unknown>> = {}) => ({
  orderIntentId: "oi_test_secret",
  paymentMethodId: "pm_1",
  status: "active",
  amount: { total: "50.00", spent: "0.00", reserved: "0.00", available: "50.00", currency: "USD" },
  description: "Groceries",
  expiresAt: future(),
  merchant: { name: "Example Shop", url: "https://shop.example", countryCode: "US" },
  rails: [
    { rail: "agentic-token", provider: "vic", status: "active", credentialFormats: ["card", "network-token"] },
    { rail: "encrypted-card", status: "active", credentialFormats: ["card"] },
  ],
  ...overrides,
});

const issued = (overrides: Record<string, unknown> = {}) => ({
  id: "cred_1",
  rail: "agentic-token",
  provider: "vic",
  amount: { value: "12.49", currency: "USD" },
  expiresAt: future(),
  credential: { format: "card", value: { number: NUMBER, expirationMonth: 12, expirationYear: 2030, cvc: CVC } },
  ...overrides,
});

const payment = { amount: "12.49", currency: "USD", merchant: "https://shop.example" };
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof CrossmintCardError) return error.reason;
    throw error;
  }
  return "allowed";
};

describe("Crossmint Agent Cards configuration", () => {
  it("is optional until the card settings are present", () => {
    expect(isCrossmintCardsConfigured({})).toBe(false);
    expect(isCrossmintCardsConfigured({ ...env, CROSSMINT_CLIENT_API_KEY: "" })).toBe(false);
    expect(isCrossmintCardsConfigured(env)).toBe(true);
  });

  it("names the missing or invalid setting without logging values", () => {
    expect(() => cardConfig({ ...env, CROSSMINT_PROJECT_ID: "" })).toThrow("CROSSMINT_PROJECT_ID");
    expect(() => cardConfig({ ...env, CROSSMINT_CLIENT_API_KEY: "sk_server_key" })).toThrow("CROSSMINT_CLIENT_API_KEY");
    expect(() => cardConfig({ ...env, CROSSMINT_CLIENT_API_KEY: "ck_staging_unit" })).toThrow("CROSSMINT_CLIENT_API_KEY");
    expect(() => cardConfig({ ...env, CROSSMINT_JWT_PRIVATE_KEY: "bm90IGEga2V5" })).toThrow("CROSSMINT_JWT_PRIVATE_KEY");
    expect(() => cardConfig({ ...env, BELL_PUBLIC_URL: "http://bell.example" })).toThrow("BELL_PUBLIC_URL");
    expect(() => cardConfig({ ...env, CROSSMINT_CHECKOUT_ORIGINS: "{not json" })).toThrow("CROSSMINT_CHECKOUT_ORIGINS");
    expect(() => cardConfig({ ...env, CROSSMINT_CHECKOUT_ORIGINS: '{"https://shop.example":["https://pay.example/frame"]}' })).toThrow("CROSSMINT_CHECKOUT_ORIGINS");
    expect(() => cardConfig({ ...env, CROSSMINT_JWT_PRIVATE_KEY: "bm90IGEga2V5" })).toThrow(/^Check CROSSMINT_JWT_PRIVATE_KEY in the server configuration\.$/);
  });

  it("matches the client key to the environment and keeps Bell's origin", () => {
    const staging = cardConfig({ ...env, CROSSMINT_API_BASE_URL: "https://staging.crossmint.com/api/unstable", CROSSMINT_CLIENT_API_KEY: "ck_staging_unit", BELL_PUBLIC_URL: "http://127.0.0.1:4320" });
    expect(staging.origin).toBe("http://127.0.0.1:4320");
    expect(paymentOrigins(staging, "https://shop.example")).toEqual(["https://shop.example", "https://pay.example"]);
    expect(paymentOrigins(staging, "https://other.example")).toEqual(["https://other.example"]);
  });
});

describe("Crossmint operator JWT", () => {
  it("signs a ten-minute RS256 token for the operator that the JWKS verifies", () => {
    const config = cardConfig(env);
    const token = operatorJwt(config, Date.parse("2026-10-28T12:00:00Z"));
    const [header, payload, signature] = token.split(".");
    const jwks = operatorJwks(config.privateKey);
    const { alg, kid } = JSON.parse(Buffer.from(header, "base64url").toString());
    expect({ alg, kid }).toEqual({ alg: "RS256", kid: jwks.keys[0].kid });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ iss: "project-1", sub: "operator-1", aud: "crossmint.com", iat: 1793188800, exp: 1793189400 });
    const publicKey = createPublicKey({ key: jwks.keys[0], format: "jwk" });
    expect(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("accepts plain or base64 PEM keys and refuses weak or non-RSA keys", () => {
    expect(parseRsaPrivateKey(privatePem)).toBeDefined();
    expect(parseRsaPrivateKey(generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toBeUndefined();
    expect(parseRsaPrivateKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toBeUndefined();
  });

  it("serves only the public key", async () => {
    vi.stubEnv("CROSSMINT_JWT_PRIVATE_KEY", "");
    expect(jwksRoute().status).toBe(404);
    vi.stubEnv("CROSSMINT_JWT_PRIVATE_KEY", "bm90IGEga2V5");
    expect(jwksRoute().status).toBe(500);
    vi.stubEnv("CROSSMINT_JWT_PRIVATE_KEY", env.CROSSMINT_JWT_PRIVATE_KEY);
    const response = jwksRoute();
    const body = await response.json();
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(body.keys).toHaveLength(1);
    expect(Object.keys(body.keys[0]).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    vi.unstubAllEnvs();
  });
});

describe("Crossmint order intent checks", () => {
  const check = (overrides: Parameters<typeof intent>[0], paid = payment) => refusal(() => assertCardPayment(intent(overrides) as OrderIntent, paid));

  it("returns the active card network rail", () => {
    expect(assertCardPayment(intent() as OrderIntent, payment)).toEqual({ provider: "vic" });
    const rails = [{ rail: "agentic-token", provider: "vic", status: "pending_verification" }, { rail: "agentic-token", provider: "agentpay", status: "active", credentialFormats: ["card"] }];
    expect(assertCardPayment(intent({ rails }) as OrderIntent, payment)).toEqual({ provider: "agentpay" });
  });

  it("refuses with its own reason for each mismatch", () => {
    const cases: [Parameters<typeof intent>[0], CardReason, typeof payment?][] = [
      [{ status: "expired" }, "order_intent_expired"],
      [{ status: "cancelled" }, "order_intent_inactive"],
      [{ expiresAt: new Date(Date.now() + 30_000).toISOString() }, "order_intent_expired"],
      [{ expiresAt: "not a date" }, "order_intent_expired"],
      [{ merchant: undefined }, "merchant_scope_required"],
      [{}, "merchant_mismatch", { ...payment, merchant: "https://shop.example.evil" }],
      [{ merchant: { name: "Shop", url: "https://www.shop.example", countryCode: "US" } }, "merchant_mismatch"],
      [{}, "currency_mismatch", { ...payment, currency: "EUR" }],
      [{ amount: { total: "50.00", spent: "40.00", reserved: "0.00", available: "10.00", currency: "USD" } }, "insufficient_allowance"],
      [{ rails: [{ rail: "agentic-token", provider: "vic", status: "pending_verification", credentialFormats: ["card"] }] }, "rail_pending_verification"],
      [{ rails: [{ rail: "agentic-token", provider: "agentpay", status: "error", credentialFormats: [], error: { code: "CARD_REJECTED" } }] }, "rail_error"],
      [{ rails: [{ rail: "encrypted-card", status: "active", credentialFormats: ["card"] }] }, "no_card_rail"],
      [{ rails: [{ rail: "agentic-token", provider: "vic", status: "active", credentialFormats: ["network-token"] }] }, "no_card_rail"],
    ];
    for (const [overrides, reason, paid] of cases) expect(check(overrides, paid), reason).toBe(reason);
  });

  it("reads merchants and amounts the way the fill needs them", () => {
    expect(merchantOrigin("shop.example")).toBe("https://shop.example");
    expect(merchantOrigin("https://shop.example/checkout?step=pay")).toBe("https://shop.example");
    expect(refusal(() => merchantOrigin("http://shop.example"))).toBe("invalid_merchant");
    expect(refusal(() => merchantOrigin("https://user:pass@shop.example"))).toBe("invalid_merchant");
    expect(checkoutAmount("12.49", "USD")).toBe(1249);
    expect(checkoutAmount("1500", "JPY")).toBe(1500);
    expect(refusal(() => checkoutAmount("1500.50", "JPY"))).toBe("unsupported_amount");
  });
});

describe("Crossmint card mint", () => {
  const config = cardConfig(env);
  const fetchReturning = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("reads the order intent with the client key, operator token, and Bell's origin", async () => {
    const fetcher = fetchReturning(200, intent());
    await getOrderIntent({ config, fetch: fetcher });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://www.crossmint.com/api/unstable/order-intents/oi_test_secret");
    expect(init).toMatchObject({ method: "GET", redirect: "error", body: undefined });
    expect(init.headers).toMatchObject({ "X-API-KEY": "ck_production_unit_test_only", Origin: "https://bell.example" });
    expect(init.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(init.headers).not.toHaveProperty("Idempotency-Key");
    expect(JSON.stringify(init.headers)).not.toContain("sk_unit_test_only");
  });

  it("mints exactly the approved amount on the network rail with the call's idempotency key", async () => {
    const fetcher = fetchReturning(201, issued());
    const key = idempotencyKey("session-1", "call-1");
    const card = await mintCard("vic", { amount: "12.49", currency: "USD" }, key, { config, fetch: fetcher });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://www.crossmint.com/api/unstable/order-intents/oi_test_secret/credentials");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Idempotency-Key": key, "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ rail: "agentic-token", provider: "vic", amount: { value: "12.49", currency: "USD" }, credential: { format: "card" } });
    expect(card.card).toMatchObject({ number: NUMBER, cvc: CVC, exp_month: 12, exp_year: 2030 });
  });

  it("derives one stable key per tool call", () => {
    const key = idempotencyKey("session-1", "call-1");
    expect(key).toMatch(/^bell-card-[0-9a-f]{64}$/);
    expect(idempotencyKey("session-1", "call-1")).toBe(key);
    expect(idempotencyKey("session-1", "call-2")).not.toBe(key);
    expect(idempotencyKey("session-2", "call-1")).not.toBe(key);
    expect(key).not.toContain("session-1");
  });

  it("projects the card into the fields Bell's fill maps", () => {
    const input = { fields: ["number", "cvc", "expiry", "exp_month", "exp_year"].map((field) => ({ field, selector: `#${field}` })) } as CheckoutInput;
    expect(paymentValues(projectCard(issued(), { amount: "12.49", currency: "USD" }), input)).toEqual([NUMBER, CVC, "12/30", "12", "2030"]);
    const short = issued({ credential: { format: "card", value: { number: NUMBER, expirationMonth: 3, expirationYear: 31, cvc: CVC } } });
    expect(paymentValues(projectCard(short, { amount: "12.49", currency: "USD" }), input).slice(2)).toEqual(["03/31", "03", "2031"]);
  });

  it("refuses a credential that does not match the request", () => {
    for (const raw of [issued({ amount: { value: "12.50", currency: "USD" } }), issued({ rail: "encrypted-card" }), issued({ credential: { format: "network-token", value: {} } }), {}]) {
      expect(refusal(() => projectCard(raw, { amount: "12.49", currency: "USD" }))).toBe("unexpected_credential");
    }
  });

  it("maps the codes an operator must act on and never echoes Crossmint's message", async () => {
    const codes: [number, string, CardReason][] = [
      [409, "ORDER_INTENT_CVC_RECOLLECTION_REQUIRED", "cvc_recollection_required"],
      [409, "payments:payment-method.deleted", "payment_method_deleted"],
      [409, "ORDER_INTENT_CREDENTIAL_ALREADY_ISSUED", "credential_already_issued"],
      [409, "ORDER_INTENT_PROVIDER_OPERATION_IN_PROGRESS", "retry_later"],
      [400, "ORDER_INTENT_AMOUNT_EXCEEDED", "insufficient_allowance"],
      [400, "ORDER_INTENT_EXPIRED", "order_intent_expired"],
      [400, "ORDER_INTENT_CANCELLED", "order_intent_inactive"],
      [400, "ORDER_INTENT_CREDENTIAL_UNAVAILABLE", "credential_unavailable"],
    ];
    for (const [status, code, reason] of codes) {
      const error = await mintCard("vic", { amount: "12.49", currency: "USD" }, "k", { config, fetch: fetchReturning(status, { error: true, code, message: `secret provider text ${NUMBER}` }) }).catch((e: unknown) => e);
      expect(error, code).toBeInstanceOf(CrossmintCardError);
      expect((error as CrossmintCardError).reason).toBe(reason);
      expect((error as Error).message).not.toContain("secret provider text");
    }
  });

  it("maps statuses without a known code", async () => {
    const reasonOf = (status: number, body: unknown = { error: true, message: "secret provider text" }) =>
      cardRequest("/order-intents/x", { method: "GET" }, { config, fetch: fetchReturning(status, body) }).catch((error: unknown) => error);
    expect(await reasonOf(401)).toMatchObject({ reason: "unauthorized" });
    expect(await reasonOf(403, { code: "constructor" })).toMatchObject({ reason: "unauthorized" });
    expect(await reasonOf(404)).toMatchObject({ reason: "order_intent_not_found" });
    expect(await reasonOf(429)).toEqual(new CrossmintRequestError("rate_limited", 429));
    expect(await reasonOf(409, { code: "SOMETHING_NEW" })).toEqual(new CrossmintRequestError("http_error", 409));
    expect(await cardRequest("/x", { method: "GET" }, { config, fetch: vi.fn(async () => { throw new Error("socket"); }) }).catch((e: unknown) => e)).toEqual(new CrossmintRequestError("transport"));
  });
});

describe("Crossmint card checkout tool", () => {
  const principal = { principalId: "linq:1", principalType: "user", authenticator: "linq-message", attributes: {} };
  const ctx = (auth: typeof principal | null = principal, callId = "call-1") => ({ session: { id: "session-cards", auth: { current: auth, initiator: auth } }, callId, abortSignal: new AbortController().signal });
  const input = {
    amount: "12.49",
    currency: "USD",
    merchant: "shop.example",
    fields: [{ field: "number" as const, selector: "#number" }, { field: "cvc" as const, selector: "#cvc", frame: "#card" }, { field: "expiry" as const, selector: "#expiry" }],
    submit: { selector: "#pay" },
  };
  // Every tool output in this block is checked for card values, the order intent id, and provider text.
  const run = async (args: unknown = input, context: unknown = ctx()) => {
    const output = await cardTool.execute(args as never, context as never);
    const text = JSON.stringify(output);
    for (const secret of [NUMBER, `"${CVC}"`, "oi_test_secret", "secret provider text"]) expect(text).not.toContain(secret);
    return output;
  };
  const crossmint = (...responses: [number, unknown][]) => {
    const fetcher = vi.fn();
    for (const [status, body] of responses) fetcher.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  };

  beforeEach(() => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.mocked(runBrowserOperation).mockClear();
    vi.mocked(checkoutInHostedPage).mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("asks the person to approve the amount and merchant, and only the requester can", () => {
    const approval = cardTool.approval as { prompt: (ctx: unknown) => string; response: (ctx: unknown) => { status: string } };
    expect(approval.prompt({ input })).toBe("Pay 12.49 USD at shop.example with your Crossmint agent card?");
    expect(approval.response({ request: { principal }, response: { principal } })).toEqual({ status: "allowed" });
    expect(approval.response({ request: { principal }, response: { principal: { ...principal, principalId: "linq:2" } } })).toMatchObject({ status: "rejected" });
    expect(approval.response({ request: { principal: null }, response: { principal } })).toMatchObject({ status: "rejected" });
  });

  it("accepts card fields only, so nothing can fail on a missing billing address after the mint", () => {
    const schema = cardTool.inputSchema as unknown as { safeParse: (value: unknown) => { success: boolean } };
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, fields: [...input.fields, { field: "postal_code", selector: "#zip" }] }).success).toBe(false);
    expect(schema.safeParse({ ...input, fields: [{ field: "number", selector: "xpath=//input" }] }).success).toBe(false);
  });

  it("answers not_configured, authentication_required, or payment_not_configured before any call", async () => {
    const fetcher = crossmint();
    vi.stubEnv("CROSSMINT_CLIENT_API_KEY", "");
    expect(await run()).toMatchObject({ status: "not_configured" });
    vi.stubEnv("CROSSMINT_CLIENT_API_KEY", env.CROSSMINT_CLIENT_API_KEY);
    expect(await run(input, ctx(null))).toMatchObject({ status: "error", reason: "authentication_required" });
    vi.stubEnv("CROSSMINT_ORDER_INTENT_ID", "");
    expect(await run()).toMatchObject({ status: "payment_not_configured" });
    vi.stubEnv("CROSSMINT_ORDER_INTENT_ID", env.CROSSMINT_ORDER_INTENT_ID);
    vi.stubEnv("CROSSMINT_ALLOWED_MERCHANTS", "https://other.example");
    expect(await run()).toMatchObject({ status: "error", reason: "merchant_not_allowed" });
    vi.stubEnv("CROSSMINT_ALLOWED_MERCHANTS", "");
    vi.stubEnv("CROSSMINT_MAX_COST", "10.00 USD");
    expect(await run()).toMatchObject({ status: "error", reason: "cap_exceeded" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(runBrowserOperation).not.toHaveBeenCalled();
  });

  it("refuses from the order intent before any browser work or mint", async () => {
    const fetcher = crossmint([200, intent({ merchant: { name: "Other", url: "https://other.example", countryCode: "US" } })]);
    expect(await run()).toMatchObject({ status: "error", reason: "merchant_mismatch" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(runBrowserOperation).not.toHaveBeenCalled();
  });

  it("mints inside the private fill and returns only the fill status", async () => {
    const fetcher = crossmint([200, intent()], [201, issued()]);
    vi.mocked(checkoutInHostedPage).mockImplementation(async (_page, connection, checkout, origins, getCredentials) => {
      expect(connection).toBe("private-connection");
      expect(checkout).toMatchObject({ id: "crossmint_card", amount: 1249, currency: "usd", credential: "card", fields: input.fields, submit: input.submit });
      expect(origins).toEqual(["https://shop.example", "https://pay.example"]);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(await getCredentials()).toMatchObject({ card: { number: NUMBER, cvc: CVC } });
      return { id: "crossmint_card", status: "merchant_confirmation_observed", verify_payment: true };
    });
    expect(await run()).toEqual({ status: "merchant_confirmation_observed", verify_payment: true });
    const mint = fetcher.mock.calls[1] as unknown as [string, { headers: Record<string, string> }];
    expect(mint[1].headers["Idempotency-Key"]).toBe(idempotencyKey("session-cards", "call-1"));
  });

  it("returns the reasons an operator must act on, and maps an interrupted fill", async () => {
    crossmint([200, intent()], [409, { error: true, code: "ORDER_INTENT_CVC_RECOLLECTION_REQUIRED", message: "secret provider text" }]);
    vi.mocked(checkoutInHostedPage).mockImplementation(async (_page, _url, _input, _origins, getCredentials) => {
      await getCredentials();
      throw new Error("must not reach the fill");
    });
    expect(await run()).toMatchObject({ status: "error", reason: "cvc_recollection_required" });

    crossmint([200, intent()], [201, issued()]);
    vi.mocked(checkoutInHostedPage).mockImplementation(async (_page, _url, _input, _origins, getCredentials) => {
      await getCredentials();
      throw new Error("Checkout stopped before submission. Check the existing Link request and browser before retrying.");
    });
    const stopped = await run(input, ctx(principal, "call-2"));
    expect(stopped).toMatchObject({ status: "error", reason: "stopped_before_submission" });
    expect(JSON.stringify(stopped)).not.toContain("Link");
  });
});

describe("Browser privacy lock with Agent Cards", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("engages for the card path even without Link", async () => {
    vi.stubEnv("LINK_CLIENT_ID", "");
    vi.stubEnv("LINK_SANDBOX", "");
    vi.stubEnv("DATABASE_URL", "");
    for (const name of Object.keys(env)) vi.stubEnv(name, "");
    expect(await withBrowserPrivacyLock("session-plain", async () => "unlocked")).toBe("unlocked");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    await expect(withBrowserPrivacyLock("session-cards", async () => "unlocked")).rejects.toThrow("Browser payments require DATABASE_URL.");
  });
});
