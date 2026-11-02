import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config as proxyConfig, proxy } from "../proxy.js";
import CrossmintSetupPage from "../app/crossmint/setup/page.js";
import { approveBudget, refreshToken } from "../app/crossmint/setup/actions.js";
import { operatorJwks, parseRsaPrivateKey } from "../server/crossmint/operator-jwt.js";

const incoming = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => incoming.headers }));
vi.mock("../app/crossmint/setup/setup", () => ({ default: function Setup() { return null; } }));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const password = "a-synthetic-operator-password-of-32-bytes";
const basic = `Basic ${Buffer.from(`operator:${password}`).toString("base64")}`;
const env = {
  BELL_OPERATOR_USERNAME: "operator",
  BELL_OPERATOR_PASSWORD: password,
  CROSSMINT_SERVER_API_KEY: "sk_unit_test_only",
  CROSSMINT_USER_ID: "operator-1",
  CROSSMINT_CLIENT_API_KEY: "ck_production_unit_test_only",
  CROSSMINT_PROJECT_ID: "project-1",
  CROSSMINT_JWT_PRIVATE_KEY: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"),
  CROSSMINT_BUYER_PROFILE_ID: "",
  CROSSMINT_ORDER_INTENT_ID: "oi_in_use",
  BELL_PUBLIC_URL: "https://bell.example",
};

const intent = (id: string, expiresAt: string, rails: unknown[] = [{ rail: "spt", provider: "stripe", status: "active" }]) => ({
  orderIntentId: id,
  paymentMethodId: "pm_1",
  status: "active",
  amount: { total: "30.00", spent: "0.00", reserved: "0.00", available: "30.00", currency: "eur" },
  merchant: { name: "Zara", url: "https://www.zara.com", countryCode: "ES" },
  description: "Demo",
  expiresAt,
  rails,
});

function setupProps(node: ReactNode): Record<string, unknown> | undefined {
  if (Array.isArray(node)) return node.map(setupProps).find(Boolean);
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (typeof node.type === "function" && node.type.name === "Setup") return (node as ReactElement<Record<string, unknown>>).props;
  return setupProps(node.props.children);
}

beforeEach(() => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  incoming.headers = new Headers({ host: "bell.example", "x-forwarded-proto": "https" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Crossmint setup access", () => {
  it("covers only the Crossmint pages", () => {
    expect(proxyConfig.matcher).toEqual(["/crossmint/:path*"]);
  });

  it("asks for the operator's credentials and refuses cross-origin writes", async () => {
    const challenge = await proxy(new Request("https://bell.example/crossmint/setup"));
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain('Basic realm="Bell"');
    const allowed = await proxy(new Request("https://bell.example/crossmint/setup", { headers: { authorization: basic } }));
    expect(allowed.headers.get("x-middleware-next")).toBe("1");
    for (const response of [challenge, allowed]) {
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
    const crossOrigin = await proxy(new Request("https://bell.example/crossmint/setup", { method: "POST", headers: { authorization: basic, origin: "https://evil.example" } }));
    expect(crossOrigin.status).toBe(403);
  });

  it("checks again in the page and signs nothing for an unauthenticated request", async () => {
    const page = await CrossmintSetupPage();
    expect(setupProps(page)).toBeUndefined();
    expect(JSON.stringify(page)).not.toContain("ck_production_unit_test_only");
  });

  it("refuses actions without the operator's credentials or from another origin, before calling Crossmint", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(approveBudget({} as never)).rejects.toThrow("Sign in as the Bell operator");
    incoming.headers.set("authorization", basic);
    incoming.headers.set("origin", "https://evil.example");
    await expect(refreshToken()).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Crossmint setup page", () => {
  it("lists budgets, marks the one in use, and gives the browser only the client key", async () => {
    incoming.headers.set("authorization", basic);
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://www.crossmint.com/api/unstable/order-intents");
      expect(init?.headers).toMatchObject({ "X-API-KEY": "ck_production_unit_test_only", Origin: "https://bell.example" });
      return Response.json([intent("oi_old", "2026-11-03T00:00:00.000Z"), intent("oi_in_use", "2026-11-08T00:00:00.000Z")]);
    });
    vi.stubGlobal("fetch", fetcher);
    const props = setupProps(await CrossmintSetupPage())!;
    expect(props.checks).toMatchObject({ server: { state: "ok" }, operator: { state: "ok" }, token: { state: "ok" } });
    const budgets = props.budgets as { id: string; inUse: boolean; currency: string; merchantHost: string; rails: string[] }[];
    expect(budgets.map((budget) => [budget.id, budget.inUse])).toEqual([["oi_in_use", true], ["oi_old", false]]);
    expect(budgets[0]).toMatchObject({ currency: "EUR", merchantHost: "www.zara.com", rails: ["Stripe shared payment token: active"] });
    expect(props.apiKey).toBe("ck_production_unit_test_only");
    expect(props.jwt).toBeUndefined();
    expect(JSON.stringify(props)).not.toContain("sk_unit_test_only");
  });

  it("signs a ten-minute operator token for the card form on request", async () => {
    incoming.headers.set("authorization", basic);
    const token = await refreshToken();
    expect(token.ok).toBe(true);
    const [header, payload, signature] = (token as { jwt: string }).jwt.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({ iss: "project-1", sub: "operator-1", aud: "crossmint.com" });
    expect(claims.exp - claims.iat).toBe(600);
    const publicKey = createPublicKey({ key: operatorJwks(parseRsaPrivateKey(env.CROSSMINT_JWT_PRIVATE_KEY)!).keys[0], format: "jwk" });
    expect(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("shows where to point Crossmint, and no token, when Crossmint rejects Bell's token", async () => {
    incoming.headers.set("authorization", basic);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "Invalid JWT" }, { status: 401 })));
    const props = setupProps(await CrossmintSetupPage())!;
    expect(props.checks).toMatchObject({ token: { state: "error", text: expect.stringContaining("rejected Bell's operator token") } });
    expect(props.jwks).toEqual({ url: "https://bell.example/api/crossmint/jwks", issuer: "project-1", loopback: false });
    expect(props.apiKey).toBeUndefined();
    expect(props.jwt).toBeUndefined();
  });

  it("offers the card network's verification only when paying in Bell's browser is switched on", async () => {
    incoming.headers.set("authorization", basic);
    const pending = intent("oi_in_use", "2026-12-01T00:00:00.000Z", [{ rail: "agentic-token", provider: "vic", status: "pending_verification", credentialFormats: ["card"] }]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{ ...pending, verificationConfig: { allowanceId: "al_1", environment: "production", publicApiKey: "pk_1" } }])));
    const off = setupProps(await CrossmintSetupPage())!;
    expect((off.budgets as { verify?: unknown }[])[0].verify).toBeUndefined();
    vi.stubEnv("CROSSMINT_CARD_CHECKOUT", "1");
    const on = setupProps(await CrossmintSetupPage())!;
    expect((on.budgets as { verify?: { orderIntentId: string } }[])[0].verify).toMatchObject({ orderIntentId: "oi_in_use", verificationConfig: { allowanceId: "al_1" } });
  });

  it("names a missing setting instead of calling Crossmint", async () => {
    incoming.headers.set("authorization", basic);
    vi.stubEnv("CROSSMINT_PROJECT_ID", "");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const props = setupProps(await CrossmintSetupPage())!;
    expect(props.checks).toMatchObject({ operator: { state: "error", text: expect.stringContaining("CROSSMINT_PROJECT_ID") } });
    expect(props.jwt).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Crossmint budget approval", () => {
  const draft = {
    paymentMethodId: "pm_1",
    idempotencyKey: "2f1c8e7a-5b3d-4c2e-9a1f-0d6b7e8c9a10",
    amount: "30.00",
    currency: "eur",
    days: 7,
    description: "Demo",
    merchant: { name: "Zara", url: "https://www.zara.com", countryCode: "es" },
    consumer: { email: "person@example.com", countryCode: "es", languageCode: "es-ES" },
  };

  it("registers the card with the person's email before creating the order intent", async () => {
    incoming.headers.set("authorization", basic);
    const calls: { method: string; path: string; body?: unknown; key?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname.replace("/api/unstable", "");
      const key = (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"];
      calls.push({ method: init?.method ?? "GET", path, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}), ...(key ? { key } : {}) });
      if (init?.method === "GET") return Response.json({ message: "not found" }, { status: 404 });
      if (init?.method === "PUT") return Response.json({ paymentMethodId: "pm_1", rails: [{ rail: "spt", provider: "stripe", status: "enabled" }] });
      return Response.json(intent("oi_new", "2026-11-09T00:00:00.000Z"));
    }));
    const result = await approveBudget(draft);
    expect(result).toMatchObject({ ok: true, budget: { id: "oi_new", currency: "EUR", networkRail: false } });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /payment-methods/pm_1/order-intent-registration",
      "PUT /payment-methods/pm_1/order-intent-registration",
      "POST /order-intents",
    ]);
    expect(calls[1].body).toEqual({ email: "person@example.com", countryCode: "ES", languageCode: "es-ES" });
    expect(calls[2].key).toBe("bell-budget-2f1c8e7a-5b3d-4c2e-9a1f-0d6b7e8c9a10");
    expect(calls[2].body).toMatchObject({
      paymentMethodId: "pm_1",
      amount: { value: "30.00", currency: "EUR" },
      merchant: { name: "Zara", url: "https://www.zara.com", countryCode: "ES" },
      description: "Demo",
    });
  });

  it("returns Crossmint's reason to the operator and refuses a merchant without HTTPS before any call", async () => {
    incoming.headers.set("authorization", basic);
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === "GET"
        ? Response.json({ message: "not found" }, { status: 404 })
        : Response.json({ message: ["A consumer email is required to register this payment method for order intents"] }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await approveBudget(draft)).toEqual({ ok: false, message: expect.stringContaining("A consumer email is required") });
    fetcher.mockClear();
    expect(await approveBudget({ ...draft, merchant: { ...draft.merchant, url: "http://www.zara.com" } })).toMatchObject({ ok: false, message: expect.stringContaining("HTTPS") });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
