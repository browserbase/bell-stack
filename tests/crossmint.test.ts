import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AMOUNT,
  answerForm,
  assertCheckoutPolicy,
  cancelCheckout,
  compareAmounts,
  createCheckout,
  crossmintConfig,
  CrossmintPolicyError,
  CrossmintRequestError,
  CrossmintSetupError,
  declineRequest,
  getCheckout,
  isCrossmintConfigured,
  payWithOrderIntent,
  projectCheckout,
  waitForCheckout,
  type CheckoutSnapshot,
} from "../server/crossmint/client.js";
import { assertPaymentMatches, PaymentMismatchError } from "../server/crossmint/payment.js";
import { assertSessionCheckout, rememberCheckout, sessionCheckout } from "../server/crossmint/runs.js";
import checkoutTool from "../agent/tools/crossmint_checkout.js";
import payTool from "../agent/tools/crossmint_pay.js";

const config = {
  apiKey: "sk_unit_test_only",
  userId: "operator-1",
  baseUrl: "https://www.crossmint.com/api/unstable",
  allowedMerchants: [] as string[],
  orderIntentId: "oi_test_secret",
};

const snapshot = (overrides: Record<string, unknown>) => ({
  runId: "run_1",
  status: "running",
  revision: 1,
  createdAt: "2026-10-28T12:00:00.000Z",
  browser: { embedUrl: "https://browser.example/secret", permissions: ["read"] },
  input: { request: { startUrl: "https://shop.example/p/1" }, constraints: { maxCost: { amount: "20.00", currency: "USD" } } },
  requiredAction: null,
  ...overrides,
});

const paymentRequest = (amount = "12.49", currency = "USD", url = "https://shop.example", method: Record<string, unknown> = { method: "card" }) =>
  snapshot({
    status: "awaiting_input",
    requiredAction: {
      messageId: "m",
      requestId: "req_pay",
      type: "input_response",
      request: {
        question: `Authorize a card payment of ${amount} ${currency}.`,
        expiresAt: "2026-10-28T12:10:00.000Z",
        interaction: {
          kind: "payment",
          purpose: "checkout_payment",
          amount: { kind: "exact", value: amount, currency },
          merchant: { name: "Example Shop", url, countryCode: "US" },
          ...method,
        },
      },
    },
  });

const formRequest = (requestId: string, fields: unknown[]) =>
  snapshot({ status: "awaiting_input", requiredAction: { requestId, request: { question: "Which size?", interaction: { kind: "form", fields } } } });

describe("Crossmint configuration", () => {
  it("is optional until used", () => {
    expect(isCrossmintConfigured({})).toBe(false);
    expect(isCrossmintConfigured({ CROSSMINT_SERVER_API_KEY: "sk_x", CROSSMINT_USER_ID: "u" })).toBe(true);
  });

  it("names the missing or invalid setting without logging values", () => {
    const base = { CROSSMINT_SERVER_API_KEY: "sk_x", CROSSMINT_USER_ID: "u" };
    expect(() => crossmintConfig({})).toThrow(CrossmintSetupError);
    expect(() => crossmintConfig({})).toThrow("CROSSMINT_SERVER_API_KEY");
    expect(() => crossmintConfig({ ...base, CROSSMINT_SERVER_API_KEY: "ck_client_key" })).toThrow("CROSSMINT_SERVER_API_KEY");
    expect(() => crossmintConfig({ ...base, CROSSMINT_API_BASE_URL: "http://insecure.example" })).toThrow("CROSSMINT_API_BASE_URL");
    expect(() => crossmintConfig({ ...base, CROSSMINT_MAX_COST: "50 dollars" })).toThrow("CROSSMINT_MAX_COST");
    expect(() => crossmintConfig({ ...base, CROSSMINT_MAX_COST: "0.00 EUR" })).toThrow("CROSSMINT_MAX_COST");
    expect(() => crossmintConfig({ ...base, CROSSMINT_ALLOWED_MERCHANTS: "https://shop.example/path" })).toThrow("CROSSMINT_ALLOWED_MERCHANTS");
    expect(() => crossmintConfig({ ...base, CROSSMINT_ALLOWED_MERCHANTS: "http://shop.example" })).toThrow("CROSSMINT_ALLOWED_MERCHANTS");

    const parsed = crossmintConfig({
      ...base,
      CROSSMINT_MAX_COST: "50.00 EUR",
      CROSSMINT_ALLOWED_MERCHANTS: "https://shop.example, https://other.example",
      CROSSMINT_BUYER_PROFILE_ID: "bp_1",
    });
    expect(parsed).toMatchObject({
      baseUrl: "https://www.crossmint.com/api/unstable",
      maxCost: { amount: "50.00", currency: "EUR" },
      allowedMerchants: ["https://shop.example", "https://other.example"],
      buyerProfileId: "bp_1",
    });
    expect(parsed.orderIntentId).toBeUndefined();
  });
});

describe("Crossmint checkout policy", () => {
  it("accepts the amounts Crossmint accepts", () => {
    for (const value of ["20", "20.00", "0.50", "999999999999999.99"]) expect(AMOUNT.test(value)).toBe(true);
    for (const value of ["0", "0.00", "020", "1.234", "-1", "1,00", ""]) expect(AMOUNT.test(value)).toBe(false);
  });

  it("compares decimal amounts without floating point, at six decimals", () => {
    expect(compareAmounts("20", "20.00")).toBe(0);
    expect(compareAmounts("19.99", "20.00")).toBe(-1);
    expect(compareAmounts("20.01", "20.00")).toBe(1);
    expect(compareAmounts("0.1", "0.10")).toBe(0);
    expect(compareAmounts("12.49", "12.491")).toBe(-1);
  });

  it("allows any merchant and any cap when no policy is set", () => {
    expect(() => assertCheckoutPolicy("https://anything.example/p", { amount: "9999.00", currency: "USD" }, config)).not.toThrow();
  });

  it("refuses merchants outside the allowlist before any request is made", () => {
    const policy = { ...config, allowedMerchants: ["https://shop.example"] };
    expect(() => assertCheckoutPolicy("https://shop.example/p/1", { amount: "1.00", currency: "USD" }, policy)).not.toThrow();
    for (const url of ["https://evil.example/p", "http://shop.example/p", "https://shop.example.evil.example/p", "https://user:pw@shop.example/p", "not a url"]) {
      expect(() => assertCheckoutPolicy(url, { amount: "1.00", currency: "USD" }, policy)).toThrow(CrossmintPolicyError);
    }
  });

  it("refuses caps above the operator ceiling or in another currency", () => {
    const policy = { ...config, maxCost: { amount: "50.00", currency: "EUR" } };
    expect(() => assertCheckoutPolicy("https://shop.example", { amount: "50.00", currency: "EUR" }, policy)).not.toThrow();
    expect(() => assertCheckoutPolicy("https://shop.example", { amount: "50.01", currency: "EUR" }, policy)).toThrow("operator ceiling");
    expect(() => assertCheckoutPolicy("https://shop.example", { amount: "1.00", currency: "USD" }, policy)).toThrow("limited to EUR");
  });

  it("stops createCheckout at the policy, so a refused run is never billed", async () => {
    const fetcher = vi.fn();
    await expect(
      createCheckout(
        { startUrl: "https://evil.example/p", task: "x", maxCost: { amount: "1.00", currency: "USD" } },
        { config: { ...config, allowedMerchants: ["https://shop.example"] }, fetch: fetcher },
      ),
    ).rejects.toThrow(CrossmintPolicyError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Crossmint client", () => {
  it("creates a checkout with the documented body and headers", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://www.crossmint.com/api/unstable/agent-checkouts");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ "X-API-KEY": config.apiKey, "x-crossmint-user-id": config.userId, "Content-Type": "application/json" });
      expect(JSON.parse(init!.body as string)).toEqual({
        request: { startUrl: "https://shop.example/p/1", task: "One sticker pack" },
        constraints: { maxCost: { amount: "20.00", currency: "USD" } },
        buyerProfileId: "bp_1",
        browser: { location: { type: "country", countryCode: "ES" } },
      });
      return Response.json({ runId: "run_1" });
    });
    await expect(
      createCheckout(
        { startUrl: "https://shop.example/p/1", task: "One sticker pack", maxCost: { amount: "20.00", currency: "USD" }, countryCode: "ES" },
        { config: { ...config, buyerProfileId: "bp_1" }, fetch: fetcher },
      ),
    ).resolves.toEqual({ runId: "run_1" });
  });

  it("answers a form with a fresh message id and the submit shape", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://www.crossmint.com/api/unstable/agent-checkouts/run_1/messages");
      const body = JSON.parse(init!.body as string);
      expect(body.id).toMatch(/^bell_/);
      expect(body.parts).toEqual([
        { type: "input_response", requestId: "req_1", action: "submit", response: { kind: "form", answers: { email: "ada@example.com", size: "M" } } },
      ]);
      return Response.json({ messageId: "msg_1", status: "accepted" }, { status: 202 });
    });
    await answerForm("run_1", "req_1", { email: "ada@example.com", size: "M" }, { config, fetch: fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("pays with the server-side order intent only", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.parts[0]).toEqual({ type: "input_response", requestId: "req_pay", action: "submit", response: { kind: "payment", orderIntentId: "oi_test_secret" } });
      return Response.json({ messageId: "msg_2", status: "accepted" }, { status: 202 });
    });
    await payWithOrderIntent("run_1", "req_pay", { config, fetch: fetcher });
    await expect(payWithOrderIntent("run_1", "req_pay", { config: { ...config, orderIntentId: undefined }, fetch: fetcher })).rejects.toThrow("CROSSMINT_ORDER_INTENT_ID");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("declines and cancels through the documented endpoints and accepts empty 202 bodies", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url).replace(config.baseUrl, "")}`);
      if (init?.body) expect(JSON.parse(init.body as string).parts[0]).toEqual({ type: "input_response", action: "decline", requestId: "req_1" });
      return new Response(null, { status: 202 });
    });
    await declineRequest("run_1", "req_1", { config, fetch: fetcher });
    await cancelCheckout("run_1", { config, fetch: fetcher });
    expect(calls).toEqual(["POST /agent-checkouts/run_1/messages", "POST /agent-checkouts/run_1/cancel"]);
  });

  it("does not expose provider error bodies", async () => {
    const run = (status: number) => getCheckout("run_1", { config, fetch: async () => new Response("private merchant data", { status }) });
    await expect(run(401)).rejects.toThrow(/^Crossmint rejected the API key or its scopes\.$/);
    await expect(run(403)).rejects.toThrow(/^Crossmint rejected the API key or its scopes\.$/);
    await expect(run(404)).rejects.toThrow(/^Crossmint has no checkout with that id for this buyer\.$/);
    await expect(run(429)).rejects.toThrow(/rate limited/);
    await expect(run(500)).rejects.toThrow(/^Crossmint returned HTTP 500\.$/);
    await expect(getCheckout("run_1", { config, fetch: async () => new Response("<html>private</html>") })).rejects.toThrow(/^Crossmint returned an unexpected response\.$/);
    await expect(
      getCheckout("run_1", { config, fetch: async () => { throw new Error("private request details"); } }),
    ).rejects.toThrow(/^Crossmint request failed\. Check connectivity and retry\.$/);
  });

  it("does not call the API after cancellation", async () => {
    const fetcher = vi.fn();
    await expect(getCheckout("run_1", { config, fetch: fetcher, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Crossmint snapshot projection", () => {
  it("drops browser URLs, the echoed input, and unknown fields", () => {
    const projected = projectCheckout(snapshot({ secret: "x" }));
    expect(projected).toEqual({ runId: "run_1", status: "running", revision: 1, requiredAction: null, result: null, failureReason: null });
    expect(JSON.stringify(projected)).not.toContain("browser.example");
  });

  it("projects form fields with Crossmint's input kinds, choice options, and protected handling", () => {
    const projected = projectCheckout(
      snapshot({
        status: "awaiting_input",
        requiredAction: {
          messageId: "m",
          requestId: "req_1",
          type: "input_response",
          request: {
            question: "Which size?",
            expiresAt: "2026-10-28T12:10:00.000Z",
            interaction: {
              kind: "form",
              fields: [
                {
                  key: "size",
                  label: "Size",
                  required: true,
                  handling: "standard",
                  input: {
                    kind: "choice",
                    selection: { kind: "one" },
                    options: [
                      { value: "", label: "Choose a size", placeholder: true, disabled: false, selected: false },
                      { value: "M", label: "Medium", placeholder: false, disabled: false, selected: false },
                      { value: "XL", label: "XL", placeholder: false, disabled: true, selected: false },
                    ],
                  },
                },
                { key: "quantity", label: "Quantity", required: false, handling: "standard", input: { kind: "integer" } },
                { key: "otp", label: "Code", required: true, handling: "protected", input: { kind: "text", display: "masked", autoComplete: "one-time-code" } },
                { label: "no key", handling: "standard", input: { kind: "text" } },
              ],
            },
          },
        },
      }),
    );
    expect(projected.requiredAction).toEqual({
      requestId: "req_1",
      question: "Which size?",
      expiresAt: "2026-10-28T12:10:00.000Z",
      interaction: {
        kind: "form",
        fields: [
          { key: "size", label: "Size", required: true, handling: "standard", kind: "choice", options: [{ value: "M", label: "Medium" }], selection: "one" },
          { key: "quantity", label: "Quantity", required: false, handling: "standard", kind: "integer" },
          { key: "otp", label: "Code", required: true, handling: "protected", kind: "text" },
        ],
      },
    });
  });

  it("projects a payment request to method, amount, and merchant only", () => {
    const raw = paymentRequest();
    (raw.requiredAction as unknown as { request: { interaction: Record<string, unknown> } }).request.interaction.card = { number: "4242" };
    const projected = projectCheckout(raw);
    expect(projected.requiredAction?.interaction).toEqual({
      kind: "payment",
      method: "card",
      amount: { kind: "exact", value: "12.49", currency: "USD" },
      merchant: { name: "Example Shop", url: "https://shop.example", countryCode: "US" },
    });
    expect(JSON.stringify(projected)).not.toContain("4242");
    const klarna = projectCheckout(paymentRequest("12.49", "USD", "https://shop.example", { method: "klarna", authorizationUrl: "https://uc.example/pay/secret" }));
    expect(klarna.requiredAction?.interaction).toMatchObject({ kind: "payment", method: "klarna" });
    expect(JSON.stringify(klarna)).not.toContain("uc.example");
  });

  it("keeps receipt metadata on success and codes on blocked or failed runs", () => {
    expect(
      projectCheckout(
        snapshot({
          status: "succeeded",
          result: { outcome: "succeeded", summary: "Ordered one sticker pack.", purchase: { kind: "receipt_captured", receipt: { total: { amount: "12.49", currency: "USD" }, merchantOrderId: "A-100" } } },
        }),
      ).result,
    ).toEqual({ outcome: "succeeded", summary: "Ordered one sticker pack.", purchase: { kind: "receipt_captured", receipt: { total: { amount: "12.49", currency: "USD" }, merchantOrderId: "A-100" } } });
    expect(projectCheckout(snapshot({ status: "succeeded", result: { outcome: "succeeded", summary: "Confirmed.", purchase: { kind: "confirmed_without_receipt" } } })).result)
      .toEqual({ outcome: "succeeded", summary: "Confirmed.", purchase: { kind: "confirmed_without_receipt" } });
    expect(projectCheckout(snapshot({ status: "blocked", result: { outcome: "blocked", code: "merchant.payment_declined", summary: "Declined." } })).result)
      .toEqual({ outcome: "blocked", code: "merchant.payment_declined", summary: "Declined." });
    expect(projectCheckout(snapshot({ status: "failed", reason: "cost_limit" })).failureReason).toBe("cost_limit");
  });

  it("rejects malformed snapshots", () => {
    expect(() => projectCheckout({ status: "running" })).toThrow(CrossmintRequestError);
    expect(() => projectCheckout(snapshot({ status: "exploded" }))).toThrow(CrossmintRequestError);
    expect(() => projectCheckout("not json")).toThrow(CrossmintRequestError);
  });
});

describe("Crossmint payment cross-check", () => {
  const record = { runId: "run_1", maxCost: { amount: "20.00", currency: "USD" }, principalId: "linq:1" };
  const approved = { requestId: "req_pay", amount: "12.49", currency: "USD", merchant: "shop.example" };
  const live = (raw: Record<string, unknown>): CheckoutSnapshot => projectCheckout(raw);

  it("accepts a payment whose amount, currency, merchant, and cap all agree", () => {
    expect(assertPaymentMatches(approved, live(paymentRequest()), record)).toEqual({ amount: { amount: "12.49", currency: "USD" }, merchant: "shop.example" });
    expect(assertPaymentMatches({ ...approved, merchant: "https://shop.example/checkout" }, live(paymentRequest()), record).merchant).toBe("shop.example");
  });

  it.each([
    ["no_payment_request", approved, snapshot({ status: "running" })],
    ["request_changed", { ...approved, requestId: "req_old" }, paymentRequest()],
    ["unsupported_method", approved, paymentRequest("12.49", "USD", "https://shop.example", { method: "klarna", authorizationUrl: "https://uc.example/pay" })],
    ["unsupported_amount", approved, paymentRequest("12.49", "USD", "https://shop.example", { method: "card", amount: { kind: "maximum", value: "12.49", currency: "USD" } })],
    ["currency_mismatch", { ...approved, currency: "EUR" }, paymentRequest()],
    ["amount_mismatch", { ...approved, amount: "12.48" }, paymentRequest()],
    ["merchant_mismatch", { ...approved, merchant: "evil.example" }, paymentRequest()],
    ["cap_exceeded", { ...approved, amount: "20.01" }, paymentRequest("20.01")],
  ] as const)("refuses on %s", (reason, input, raw) => {
    let caught: unknown;
    try {
      assertPaymentMatches(input, live(raw), record);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PaymentMismatchError);
    expect((caught as PaymentMismatchError).reason).toBe(reason);
  });
});

describe("Crossmint polling", () => {
  it("waits through running states, skips an answered request, and stops on new input or a terminal state", async () => {
    const sequence = [
      snapshot({ status: "running", revision: 1 }),
      formRequest("answered", []),
      { ...formRequest("req_new", []), revision: 3 },
    ];
    const fetcher = vi.fn(async () => Response.json(sequence.shift() ?? sequence.at(-1)));
    const result = await waitForCheckout("run_1", { config, fetch: fetcher, intervalMs: 1, skipRequestId: "answered" });
    expect(result.status).toBe("awaiting_input");
    expect(result.requiredAction?.requestId).toBe("req_new");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("returns the latest snapshot at the timeout instead of hanging", async () => {
    const fetcher = vi.fn(async () => Response.json(snapshot({ status: "running" })));
    const result = await waitForCheckout("run_1", { config, fetch: fetcher, intervalMs: 1, timeoutMs: 10 });
    expect(result.status).toBe("running");
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops polling when the turn is cancelled", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      controller.abort();
      return Response.json(snapshot({ status: "running" }));
    });
    await expect(waitForCheckout("run_1", { config, fetch: fetcher, intervalMs: 50, signal: controller.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("Crossmint run registry", () => {
  it("scopes checkouts to the conversation that started them and keeps the cap", () => {
    const record = { runId: "run_a", maxCost: { amount: "20.00", currency: "USD" }, principalId: "linq:1" };
    rememberCheckout("session-a", record);
    expect(sessionCheckout("session-a", "run_a")).toEqual(record);
    expect(sessionCheckout("session-b", "run_a")).toBeUndefined();
    expect(assertSessionCheckout("session-a", "run_a")).toEqual(record);
    expect(() => assertSessionCheckout("session-b", "run_a")).toThrow("did not start that checkout");
  });
});

describe("Crossmint tools", () => {
  const principal = { principalId: "linq:1", principalType: "user", authenticator: "linq-message", attributes: {} };
  const ctx = (auth: typeof principal | null, id = "session-tools") => ({ session: { id, auth: { current: auth, initiator: auth } }, abortSignal: new AbortController().signal });
  const configure = () => {
    vi.stubEnv("CROSSMINT_SERVER_API_KEY", "sk_unit_test_only");
    vi.stubEnv("CROSSMINT_USER_ID", "operator-1");
    vi.stubEnv("CROSSMINT_ORDER_INTENT_ID", "");
  };
  afterEach(() => vi.unstubAllEnvs());

  it("answer not_configured until the variables are set", async () => {
    vi.stubEnv("CROSSMINT_SERVER_API_KEY", "");
    vi.stubEnv("CROSSMINT_USER_ID", "");
    expect(await checkoutTool.execute({ action: "status", runId: "run_1" }, ctx(principal) as never)).toMatchObject({ status: "not_configured" });
    expect(await payTool.execute({ runId: "run_1", requestId: "req_pay", amount: "12.49", currency: "USD", merchant: "shop.example" }, ctx(principal) as never)).toMatchObject({ status: "not_configured" });
  });

  it("let only the requesting principal approve a payment", () => {
    const policy = (payTool.approval as { response: (ctx: unknown) => { status: string } }).response;
    const other = { ...principal, principalId: "linq:2" };
    expect(policy({ request: { principal }, response: { principal } })).toEqual({ status: "allowed" });
    expect(policy({ request: { principal }, response: { principal: other } })).toMatchObject({ status: "rejected" });
    expect(policy({ request: { principal: null }, response: { principal } })).toMatchObject({ status: "rejected" });
  });

  it("refuse protected form fields before anything is sent", async () => {
    configure();
    const fetcher = vi.fn(async () => Response.json(formRequest("req_1", [{ key: "otp", label: "Code", required: true, handling: "protected", input: { kind: "text" } }])));
    vi.stubGlobal("fetch", fetcher);
    rememberCheckout("session-tools", { runId: "run_1", maxCost: { amount: "20.00", currency: "USD" }, principalId: "linq:1" });
    expect(await checkoutTool.execute({ action: "answer", runId: "run_1", requestId: "req_1", answers: { otp: "123456" } }, ctx(principal) as never)).toMatchObject({ status: "error", reason: "protected_field" });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(Promise.resolve(checkoutTool.execute({ action: "status", runId: "run_1" }, ctx(principal, "session-other") as never))).rejects.toThrow("did not start that checkout");
  });

  it("stop at payment_not_configured after the cross-check when no order intent is set", async () => {
    configure();
    const fetcher = vi.fn(async () => Response.json(paymentRequest()));
    vi.stubGlobal("fetch", fetcher);
    rememberCheckout("session-tools", { runId: "run_1", maxCost: { amount: "20.00", currency: "USD" }, principalId: "linq:1" });
    const input = { runId: "run_1", requestId: "req_pay", amount: "12.49", currency: "USD", merchant: "shop.example" };
    expect(await payTool.execute(input, ctx(null) as never)).toMatchObject({ status: "error", reason: "authentication_required" });
    expect(await payTool.execute(input, ctx({ ...principal, principalId: "linq:2" }) as never)).toMatchObject({ status: "error", reason: "principal_mismatch" });
    expect(await payTool.execute({ ...input, amount: "12.48" }, ctx(principal) as never)).toMatchObject({ status: "error", reason: "amount_mismatch" });
    expect(await payTool.execute(input, ctx(principal) as never)).toEqual({
      status: "payment_not_configured",
      runId: "run_1",
      requestId: "req_pay",
      hint: expect.stringContaining("No order intent"),
    });
    expect(fetcher.mock.calls.every((call) => (call as unknown[])[1] === undefined || ((call as unknown[])[1] as RequestInit).method === "GET")).toBe(true);
  });
});
