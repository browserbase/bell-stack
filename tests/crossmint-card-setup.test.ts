import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config as proxyConfig, proxy } from "../proxy.js";
import CrossmintCardsPage from "../app/crossmint/cards/page.js";
import { operatorJwks, parseRsaPrivateKey } from "../server/crossmint/operator-jwt.js";

const incoming = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => incoming.headers }));
vi.mock("../app/crossmint/cards/card-setup", () => ({ default: function CardSetup() { return null; } }));

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
  BELL_PUBLIC_URL: "https://bell.example",
};

function find(node: ReactNode, name: string): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, name)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (typeof node.type === "function" && node.type.name === name) return node as ReactElement<Record<string, unknown>>;
  return find(node.props.children, name);
}

beforeEach(() => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  incoming.headers = new Headers({ host: "bell.example", "x-forwarded-proto": "https" });
});
afterEach(() => vi.unstubAllEnvs());

describe("Crossmint card setup access", () => {
  it("covers only the setup page", () => {
    expect(proxyConfig.matcher).toEqual(["/crossmint/:path*"]);
  });

  it("asks for the operator's credentials and refuses cross-origin writes", async () => {
    const challenge = await proxy(new Request("https://bell.example/crossmint/cards"));
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain('Basic realm="Bell"');
    const allowed = await proxy(new Request("https://bell.example/crossmint/cards", { headers: { authorization: basic } }));
    expect(allowed.headers.get("x-middleware-next")).toBe("1");
    const crossOrigin = await proxy(new Request("https://bell.example/crossmint/cards", { method: "POST", headers: { authorization: basic, origin: "https://evil.example" } }));
    expect(crossOrigin.status).toBe(403);
  });

  it("checks again in the page and signs nothing for an unauthenticated request", async () => {
    const page = await CrossmintCardsPage();
    expect(find(page, "CardSetup")).toBeUndefined();
    expect(JSON.stringify(page)).not.toContain("ck_production_unit_test_only");
  });

  it("gives the browser only the client key and a ten-minute operator token", async () => {
    incoming.headers.set("authorization", basic);
    const setup = find(await CrossmintCardsPage(), "CardSetup");
    expect(Object.keys(setup?.props ?? {}).sort()).toEqual(["apiKey", "jwt"]);
    const { apiKey, jwt } = setup!.props as { apiKey: string; jwt: string };
    expect(apiKey).toBe("ck_production_unit_test_only");
    const [header, payload, signature] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({ iss: "project-1", sub: "operator-1", aud: "crossmint.com" });
    expect(claims.exp - claims.iat).toBe(600);
    const publicKey = createPublicKey({ key: operatorJwks(parseRsaPrivateKey(env.CROSSMINT_JWT_PRIVATE_KEY)!).keys[0], format: "jwk" });
    expect(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("names a missing setting instead of rendering the card form", async () => {
    incoming.headers.set("authorization", basic);
    vi.stubEnv("CROSSMINT_PROJECT_ID", "");
    const page = await CrossmintCardsPage();
    expect(find(page, "CardSetup")).toBeUndefined();
    expect(JSON.stringify(page)).toContain("CROSSMINT_PROJECT_ID");
  });
});
