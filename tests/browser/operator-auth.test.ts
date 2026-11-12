import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { localOperatorAuth, operatorAuth } from "../../server/operator-auth";

const password = "synthetic-operator-password-at-least-32-bytes";
const origin = "https://bell.example";
const authorization = `Basic ${Buffer.from(`operator:${password}`).toString("base64")}`;

function request(path: string, init: RequestInit = {}) {
  return new Request(`${origin}${path}`, {
    ...init,
    headers: { authorization, origin, ...init.headers },
  });
}

beforeEach(() => {
  vi.stubEnv("BELL_OPERATOR_USERNAME", "operator");
  vi.stubEnv("BELL_OPERATOR_PASSWORD", password);
});

afterEach(() => vi.unstubAllEnvs());

describe("operator authentication", () => {
  it.each(["", "short"])("fails closed with an absent or weak operator password", value => {
    vi.stubEnv("BELL_OPERATOR_PASSWORD", value);
    expect(operatorAuth(request("/"))).toBeNull();
  });

  it("rejects unauthenticated users and accepts the configured operator", () => {
    expect(operatorAuth(new Request(origin))).toBeNull();
    expect(operatorAuth(request("/"))).toMatchObject({ principalType: "user", issuer: "bell:operator", principalId: "operator" });
  });

  it("rejects cross-origin writes even with an authenticated operator", () => {
    expect(() => operatorAuth(request("/eve/v1/sessions/example/cancel", {
      method: "POST",
      headers: { origin: "https://other.example", "sec-fetch-site": "same-origin" },
    }))).toThrow();
  });

  it("lets server bearer requests reach the next authentication strategy", () => {
    expect(operatorAuth(new Request(`${origin}/eve/v1/session`, {
      method: "POST", headers: { authorization: "Bearer synthetic-token" }, body: "{}",
    }))).toBeNull();
  });
});


it.each(["true", "false"])("keeps the operator identity stable with NOTION_ENABLED=%s", async enabled => {
  vi.stubEnv("NOTION_ENABLED", enabled);
  vi.stubEnv("EVE_DEV", "1");
  const identity = { principalType: "user", issuer: "bell:operator", principalId: "operator" };
  expect(operatorAuth(request("/"))).toMatchObject(identity);
  expect(await localOperatorAuth(new Request("http://127.0.0.1:4320/"))).toMatchObject(identity);
  expect(await localOperatorAuth(new Request("http://foreign.example/"))).toBeNull();
  vi.stubEnv("EVE_DEV", "0");
  vi.stubEnv("VERCEL_ENV", "production");
  expect(await localOperatorAuth(new Request("http://127.0.0.1:4320/"))).toBeNull();
});
