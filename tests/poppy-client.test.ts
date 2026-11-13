import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { poppyOwner } from "../agent/lib/poppy";
import { PoppyClient } from "../server/poppy/client";
import type { PoppyRequestOptions, PoppyResponse } from "../server/poppy/http";
import { PoppyIdentity } from "../server/poppy/identity";
import { PoppyStore } from "../server/poppy/store";

const mocked = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../server/poppy/http", async importOriginal => ({
  ...await importOriginal<typeof import("../server/poppy/http")>(), requestPoppy: mocked.request,
}));

const origin = "https://company.example";
const issuer = "https://auth.company.example";
const descriptionUrl = `${origin}/openapi.json`;
const resource = "https://api.company.example/v1";
const owner = "authenticated-operator";
const accessToken = "synthetic-private-access";
let directory: string;
let store: PoppyStore;
let identity: PoppyIdentity;
let client: PoppyClient;
let document: Record<string, unknown>;
let tokenReplies: Array<Record<string, unknown>>;
let apiReplies: Array<{ status: number; body: unknown; headers?: Record<string, string> }>;
let calls: Array<{ url: string; options: PoppyRequestOptions }>;
let documentCalls: number;
let changedDocument: Record<string, unknown> | undefined;

function openapi(security?: Array<Record<string, string[]>>) {
  return {
    openapi: "3.1.0", info: { title: "Synthetic API", version: "1" }, servers: [{ url: resource }],
    components: { securitySchemes: { oauth: { type: "oauth2", flows: { authorizationCode: {
      authorizationUrl: `${issuer}/authorize`, tokenUrl: `${issuer}/token`, scopes: { "orders:read": "Read orders", "account:read": "Read account" },
    } } } } },
    paths: { "/orders": { get: { operationId: "listOrders", ...(security ? { security } : {}), responses: { "200": { description: "Orders" } } } } },
  };
}
function response(url: string, body: unknown, status = 200, headers?: Record<string, string>): PoppyResponse {
  return { url, status, text: JSON.stringify(body), headers: new Headers(headers) };
}
function claims(headers: Record<string, string>) {
  const token = headers["Poppy-Session"];
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as { sid: string; sub: string; aud: string; htu: string; ath?: string; jti: string };
}
async function seed(scopes = ["orders:read"], tokenResource = resource) {
  await store.withCompany(owner, issuer, async state => {
    state.grant = { status: "active", accessToken, refreshToken: "synthetic-private-refresh", expiresAt: Date.now() + 3_600_000, scopes, resource: tokenResource };
  });
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "bell-poppy-client-"));
  identity = new PoppyIdentity({ clientId: "https://bell.example/agent.json",
    privateJwk: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" }) });
  store = new PoppyStore({ path: path.join(directory, "poppy.enc.json"), clientId: identity.clientId, encryptionKey: randomBytes(32) });
  client = new PoppyClient(identity, store);
  document = openapi(); tokenReplies = []; apiReplies = []; calls = []; documentCalls = 0; changedDocument = undefined;
  mocked.request.mockReset().mockImplementation(async (url: string, options: PoppyRequestOptions = {}) => {
    calls.push({ url, options });
    if (url === `${origin}/.well-known/poppy.json`) return response(url, {
      protocol_version: "1.0", organization: { name: "Synthetic Company", domain: "company.example" },
      auth: { scopes: { "profile:read": "Read your profile" } }, apis: [{ type: "openapi", url: descriptionUrl }],
    });
    if (url === `${origin}/.well-known/oauth-protected-resource`) return response(url, { resource: origin, authorization_servers: [issuer] });
    if (url === `${issuer}/.well-known/oauth-authorization-server`) return response(url, {
      issuer, protected_resources: [origin], token_endpoint: `${issuer}/token`, revocation_endpoint: `${issuer}/revoke`,
      device_authorization_endpoint: `${issuer}/device`, grant_types_supported: ["refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
    });
    if (url === descriptionUrl) {
      documentCalls++;
      return response(url, changedDocument && documentCalls > 1 ? changedDocument : document);
    }
    if (url === "https://api.company.example/.well-known/oauth-protected-resource/v1") return response(url, { resource, authorization_servers: [issuer] });
    if (url === `${issuer}/device`) return response(url, {
      device_code: "synthetic-private-device", user_code: "DEMO-CODE", verification_uri: `${origin}/device`, interval: 5, expires_in: 600,
    });
    if (url === `${issuer}/token`) {
      const body = tokenReplies.shift();
      if (!body) throw new Error("Unexpected token request.");
      return response(url, body, "error" in body ? 400 : 200);
    }
    if (url === `${resource}/orders`) {
      const next = apiReplies.shift();
      if (next) return response(url, next.body, next.status, next.headers);
      return response(url, { orders: [{ id: "synthetic-order" }], reflected: options.headers?.["Poppy-Session"], access_token: options.headers?.Authorization });
    }
    throw new Error("Unexpected synthetic URL.");
  });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("Poppy client integration", () => {
  it("reads public OpenAPI data with a verifiable signed Session, no token, and stable isolated identities", async () => {
    const outputs = [];
    for (const [selectedOwner, conversation] of [[owner, "conversation-a"], [owner, "conversation-a"], [owner, "conversation-b"], ["other-owner", "conversation-a"]])
      outputs.push(await client.read(selectedOwner, conversation, origin, 0, "listOrders", {}));
    for (const output of outputs) expect(output).toMatchObject({ data: { orders: [{ id: "synthetic-order" }] } });
    const apiCalls = calls.filter(call => call.url === `${resource}/orders`);
    const sessions = apiCalls.map(call => claims(call.options.headers!));
    expect(sessions[0].sid).toBe(sessions[1].sid);
    expect(sessions[0].jti).not.toBe(sessions[1].jti);
    expect(sessions[0].sid).not.toBe(sessions[2].sid);
    expect(sessions[0].sub).toBe(sessions[2].sub);
    expect(sessions[0].sub).not.toBe(sessions[3].sub);
    for (const call of apiCalls) {
      expect(call.options.headers ?? {}).not.toHaveProperty("Authorization");
      expect(claims(call.options.headers!)).not.toHaveProperty("ath");
      const token = call.options.headers!["Poppy-Session"];
      const [header, payload, signature] = token.split(".");
      const delegation = JSON.parse(Buffer.from(JSON.parse(Buffer.from(header, "base64url").toString()).poppy_dlg.split(".")[1], "base64url").toString());
      expect(verify("sha256", Buffer.from(`${header}.${payload}`), {
        key: createPublicKey({ key: delegation.cnf.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363",
      }, Buffer.from(signature, "base64url"))).toBe(true);
      expect(JSON.stringify(outputs)).not.toContain(token);
    }
    for (const call of calls.filter(call => call.url !== `${resource}/orders`)) {
      expect(call.options.headers ?? {}).not.toHaveProperty("Poppy-Session");
      expect(call.options.headers ?? {}).not.toHaveProperty("Authorization");
    }
  });

  it("uses scoped account tokens only at the described resource and redacts echoed credentials", async () => {
    document = openapi([{ oauth: ["orders:read"] }]);
    await seed();
    const result = await client.read(owner, "conversation", origin, 0, "listOrders", {});
    expect(result).toMatchObject({ data: { orders: [{ id: "synthetic-order" }], reflected: "[redacted]", access_token: "[redacted]" } });
    const apiCall = calls.find(call => call.url === `${resource}/orders`)!;
    expect(apiCall.options.headers!.Authorization).toBe(`Bearer ${accessToken}`);
    expect(claims(apiCall.options.headers!)).toMatchObject({ aud: issuer, htu: `${resource}/orders` });
    expect(claims(apiCall.options.headers!).ath).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(accessToken);
    for (const call of calls.filter(call => call.url !== `${resource}/orders`)) expect(call.options.headers ?? {}).not.toHaveProperty("Authorization");
  });

  it("requires account access even when OAuth's scope list is empty, and never executes an operation missing its scopes", async () => {
    document = openapi([{ oauth: [] }]);
    expect(await client.read(owner, "conversation", origin, 0, "listOrders", {})).toMatchObject({ error: "auth_required" });
    document = openapi([{ oauth: ["account:read"] }]);
    await seed();
    expect(await client.read(owner, "conversation", origin, 0, "listOrders", {})).toMatchObject({ error: "insufficient_scope", scopes: ["account:read"] });
    expect(calls.filter(call => call.url === `${resource}/orders`)).toHaveLength(0);
  });

  it("refreshes once after token rejection and retries the read with a fresh bound proof", async () => {
    document = openapi([{ oauth: ["orders:read"] }]);
    await seed();
    apiReplies.push({ status: 401, body: {}, headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
    tokenReplies.push({ access_token: "refreshed-access", token_type: "Bearer", expires_in: 3600 });
    expect(await client.read(owner, "conversation", origin, 0, "listOrders", {})).toMatchObject({ data: { orders: [{ id: "synthetic-order" }] } });
    const reads = calls.filter(call => call.url === `${resource}/orders`);
    expect(reads).toHaveLength(2);
    expect(reads[0].options.headers!.Authorization).toBe(`Bearer ${accessToken}`);
    expect(reads[1].options.headers!.Authorization).toBe("Bearer refreshed-access");
    expect(claims(reads[0].options.headers!).ath).not.toBe(claims(reads[1].options.headers!).ath);
    expect(calls.filter(call => call.url === `${issuer}/token`)).toHaveLength(1);
    await store.withCompany(owner, issuer, async state => { expect(state.grant?.refreshToken).toBe("synthetic-private-refresh"); });
  });

  it("continues signed out after revoked authorization without retrying protected data", async () => {
    document = openapi([{ oauth: ["orders:read"] }]);
    await seed();
    apiReplies.push({ status: 401, body: {}, headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
    tokenReplies.push({ error: "invalid_grant" });
    expect(await client.read(owner, "conversation", origin, 0, "listOrders", {})).toMatchObject({ error: "auth_required" });
    expect(calls.filter(call => call.url === `${resource}/orders`)).toHaveLength(1);
    await store.withCompany(owner, issuer, async state => { expect(state.grant).toBeUndefined(); });
  });

  it("does not leak a token when the OpenAPI resource changes between description and execution", async () => {
    document = openapi([{ oauth: ["orders:read"] }]);
    changedDocument = { ...document, servers: [{ url: "https://different.example/stolen" }] };
    await seed();
    const result = await client.read(owner, "conversation", origin, 0, "listOrders", {});
    expect(result).toMatchObject({ error: "unsupported_api" });
    expect(calls.some(call => call.url.startsWith("https://different.example"))).toBe(false);
    expect(calls.some(call => call.options.headers?.Authorization)).toBe(false);
  });

  it("accepts scopes from any advertised alternative and rejects unadvertised scope escalation", async () => {
    document = openapi([{ oauth: ["orders:read"] }, { oauth: ["account:read", "profile:read"] }]);
    const result = await client.connect(owner, "conversation", origin, 0, ["account:read", "profile:read"]);
    expect(result).toMatchObject({ status: "sign_in_required", domain: "company.example" });
    const form = new URLSearchParams(calls.find(call => call.url === `${issuer}/device`)!.options.body);
    expect(form.get("scope")).toBe("account:read profile:read");
    expect(form.get("resource")).toBe(resource);
    await expect(client.connect(owner, "conversation", origin, 0, ["admin:write"])).rejects.toThrow("advertised");
    expect(calls.filter(call => call.url === `${issuer}/device`)).toHaveLength(1);
  });
});


function changeManifestAfterFirst(change: Record<string, unknown>) {
  const previous = mocked.request.getMockImplementation()!;
  let discoveries = 0;
  mocked.request.mockImplementation(async (url: string, options: PoppyRequestOptions = {}) => {
    const result = await previous(url, options) as PoppyResponse;
    if (url === `${origin}/.well-known/poppy.json` && ++discoveries > 1)
      return response(url, { ...JSON.parse(result.text), ...change });
    return result;
  });
}
function mcpDescription(failures: Array<string | { status: number; body: unknown; headers?: Record<string, string> } | undefined>) {
  const endpoint = "https://mcp.company.example/mcp";
  const previous = mocked.request.getMockImplementation()!;
  mocked.request.mockImplementation(async (url: string, options: PoppyRequestOptions = {}) => {
    if (url === endpoint) {
      calls.push({ url, options });
      const failure = failures.shift();
      if (failure) return typeof failure === "string" ? response(url, { error: failure }, 400) : response(url, failure.body, failure.status, failure.headers);
      const rpc = JSON.parse(options.body!);
      const result = rpc.method === "server/discover" ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
        : { tools: [{ name: "listOrders", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {}, additionalProperties: false } }] };
      return response(url, { jsonrpc: "2.0", id: rpc.id, result });
    }
    if (url === "https://mcp.company.example/.well-known/oauth-protected-resource/mcp") {
      calls.push({ url, options });
      return response(url, { resource: endpoint, authorization_servers: [issuer] });
    }
    const result = await previous(url, options) as PoppyResponse;
    if (url === `${origin}/.well-known/poppy.json`)
      return response(url, { ...JSON.parse(result.text), apis: [{ type: "mcp", url: endpoint }] });
    return result;
  });
  return endpoint;
}

describe("Poppy bounded Session recovery", () => {
  it("retries an ended Session once with a fresh sid and proof while retaining the user's token", async () => {
    document = openapi([{ oauth: ["orders:read"] }]);
    await seed();
    apiReplies.push({ status: 400, body: { error: "session_ended" } });
    expect(await client.read(owner, "conversation", origin, 0, "listOrders", {})).toMatchObject({ data: { orders: [{ id: "synthetic-order" }] } });
    const attempts = calls.filter(call => call.url === `${resource}/orders`);
    expect(attempts).toHaveLength(2);
    const first = claims(attempts[0].options.headers!);
    const retried = claims(attempts[1].options.headers!);
    expect(first.sid).not.toBe(retried.sid);
    expect(first.jti).not.toBe(retried.jti);
    expect(first.sub).toBe(retried.sub);
    expect(attempts.map(call => call.options.headers!.Authorization)).toEqual([`Bearer ${accessToken}`, `Bearer ${accessToken}`]);
    expect(calls.some(call => call.url === `${issuer}/token`)).toBe(false);
    await store.withCompany(owner, issuer, async state => {
      expect(Object.values(state.sessions)).toContain(retried.sid);
      expect(Object.values(state.sessions)).not.toContain(first.sid);
    });
  });

  it.each(["session_ended", "invalid_session"])("stops at the required retry boundary for %s", async error => {
    apiReplies.push({ status: 400, body: { error } }, { status: 400, body: { error } }, { status: 400, body: { error } });
    expect(await client.read(owner, "conversation", origin, 0, "listOrders", {})).toMatchObject({ error });
    const attempts = calls.filter(call => call.url === `${resource}/orders`);
    expect(attempts).toHaveLength(error === "session_ended" ? 2 : 1);
    expect(calls.filter(call => call.url === `${origin}/.well-known/poppy.json`)).toHaveLength(1);
    if (error === "session_ended") await store.withCompany(owner, issuer, async state => { expect(state.sessions).toEqual({}); });
  });

  it("rediscovers an unsupported version but does not retry when the chosen version is unchanged", async () => {
    apiReplies.push({ status: 400, body: { error: "version_unsupported" } });
    expect(await client.read(owner, "conversation", origin, 0, "listOrders", {})).toMatchObject({ error: "version_unsupported" });
    expect(calls.filter(call => call.url === `${origin}/.well-known/poppy.json`)).toHaveLength(2);
    expect(calls.filter(call => call.url === `${resource}/orders`)).toHaveLength(1);
  });

  it.each([false, true])("retries a newly selected version once and stops when rejected again=%s", async rejectedAgain => {
    changeManifestAfterFirst({ protocol_version: "0.4" });
    apiReplies.push({ status: 400, body: { error: "version_unsupported" } });
    if (rejectedAgain) apiReplies.push({ status: 400, body: { error: "version_unsupported" } });
    const result = await client.read(owner, "conversation", origin, 0, "listOrders", {});
    expect(result).toMatchObject(rejectedAgain ? { error: "version_unsupported" } : { data: { orders: [{ id: "synthetic-order" }] } });
    const attempts = calls.filter(call => call.url === `${resource}/orders`);
    expect(attempts).toHaveLength(2);
    expect(attempts.map(call => call.options.headers!["Poppy-Version"])).toEqual(["1.0", "0.4"]);
    expect(claims(attempts[0].options.headers!).sid).not.toBe(claims(attempts[1].options.headers!).sid);
    expect(claims(attempts[0].options.headers!).sub).toBe(claims(attempts[1].options.headers!).sub);
    expect(calls.filter(call => call.url === `${origin}/.well-known/poppy.json`)).toHaveLength(2);
  });

  it("can recover once from each Session/version error without resetting either retry budget", async () => {
    changeManifestAfterFirst({ protocol_version: "0.4" });
    apiReplies.push({ status: 400, body: { error: "session_ended" } },
      { status: 400, body: { error: "version_unsupported" } }, { status: 400, body: { error: "session_ended" } });
    expect(await client.read(owner, "conversation", origin, 0, "listOrders", {})).toMatchObject({ error: "session_ended" });
    const attempts = calls.filter(call => call.url === `${resource}/orders`);
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map(call => claims(call.options.headers!).sid)).size).toBe(3);
    expect(calls.filter(call => call.url === `${origin}/.well-known/poppy.json`)).toHaveLength(2);
  });

  it.each([false, true])("keeps the selected API across version rediscovery when reordered=%s", async reordered => {
    const replacement = { type: "openapi", url: "https://different.example/api.json" };
    changeManifestAfterFirst({ protocol_version: "0.4", apis: reordered ? [replacement, { type: "openapi", url: descriptionUrl }] : [replacement] });
    apiReplies.push({ status: 400, body: { error: "version_unsupported" } });
    const result = await client.read(owner, "conversation", origin, 0, "listOrders", {});
    expect(result).toMatchObject(reordered ? { data: { orders: [{ id: "synthetic-order" }] } } : { error: "version_unsupported" });
    expect(calls.some(call => call.url.startsWith("https://different.example"))).toBe(false);
    expect(calls.filter(call => call.url === `${resource}/orders`)).toHaveLength(reordered ? 2 : 1);
  });

  it.each(["session_ended", "invalid_session"])("handles %s during a signed MCP description", async error => {
    const endpoint = mcpDescription([error]);
    const result = await client.describe(owner, "conversation", origin, 0);
    expect(result).toMatchObject(error === "session_ended" ? { type: "mcp", operations: [{ id: "listOrders" }] } : { error });
    const attempts = calls.filter(call => call.url === endpoint);
    expect(attempts).toHaveLength(error === "session_ended" ? 3 : 1);
    if (error === "session_ended") {
      expect(claims(attempts[0].options.headers!).sid).not.toBe(claims(attempts[1].options.headers!).sid);
      expect(claims(attempts[1].options.headers!).sid).toBe(claims(attempts[2].options.headers!).sid);
    }
  });

  it("rediscovers and renews the Session when a signed MCP description rejects the version", async () => {
    const endpoint = mcpDescription(["version_unsupported"]);
    changeManifestAfterFirst({ protocol_version: "0.4" });
    expect(await client.describe(owner, "conversation", origin, 0)).toMatchObject({ type: "mcp", operations: [{ id: "listOrders" }] });
    const attempts = calls.filter(call => call.url === endpoint);
    expect(attempts).toHaveLength(3);
    expect(attempts.map(call => call.options.headers!["Poppy-Version"])).toEqual(["1.0", "0.4", "0.4"]);
    expect(claims(attempts[0].options.headers!).sid).not.toBe(claims(attempts[1].options.headers!).sid);
  });

  it("refreshes a rejected account token during MCP description and binds every retried request to the replacement", async () => {
    const endpoint = mcpDescription([{ status: 401, body: {}, headers: { "www-authenticate": 'Bearer error="invalid_token"' } }]);
    await seed(["orders:read"], endpoint);
    tokenReplies.push({ access_token: "description-refreshed-token", token_type: "Bearer", expires_in: 3600 });
    expect(await client.describe(owner, "conversation", origin, 0)).toMatchObject({ type: "mcp", operations: [{ id: "listOrders" }] });
    const attempts = calls.filter(call => call.url === endpoint);
    expect(attempts).toHaveLength(3);
    expect(attempts.map(call => call.options.headers!.Authorization)).toEqual([
      `Bearer ${accessToken}`, "Bearer description-refreshed-token", "Bearer description-refreshed-token",
    ]);
    expect(claims(attempts[0].options.headers!).ath).not.toBe(claims(attempts[1].options.headers!).ath);
    expect(claims(attempts[0].options.headers!).jti).not.toBe(claims(attempts[1].options.headers!).jti);
    expect(calls.filter(call => call.url === `${issuer}/token`)).toHaveLength(1);
  });

  it("shares the token refresh budget between MCP description and the subsequent read", async () => {
    const denial = { status: 401, body: {}, headers: { "www-authenticate": 'Bearer error="invalid_token"' } };
    const endpoint = mcpDescription([denial, undefined, undefined, denial]);
    await seed(["orders:read"], endpoint);
    tokenReplies.push({ access_token: "description-refreshed-token", token_type: "Bearer", expires_in: 3600 });
    expect(await client.read(owner, "conversation", origin, 0, "listOrders", {})).toMatchObject({ error: "auth_required" });
    expect(calls.filter(call => call.url === endpoint)).toHaveLength(4);
    expect(calls.filter(call => call.url === `${issuer}/token`)).toHaveLength(1);
    expect(calls.some(call => call.options.body?.includes('"tools/call"'))).toBe(false);
  });

  it.each([false, true])("stops description recovery when the refreshed grant is rejected or revoked=%s", async revoked => {
    const denial = { status: 401, body: {}, headers: { "www-authenticate": 'Bearer error="invalid_token"' } };
    const endpoint = mcpDescription([denial, denial]);
    await seed(["orders:read"], endpoint);
    tokenReplies.push(revoked ? { error: "invalid_grant" } : { access_token: "still-rejected-token", token_type: "Bearer", expires_in: 3600 });
    expect(await client.read(owner, "conversation", origin, 0, "listOrders", {})).toMatchObject({ error: "auth_required" });
    const attempts = calls.filter(call => call.url === endpoint);
    expect(attempts).toHaveLength(revoked ? 1 : 2);
    expect(attempts.every(call => Boolean(call.options.headers!.Authorization))).toBe(true);
    expect(calls.filter(call => call.url === `${issuer}/token`)).toHaveLength(1);
    if (revoked) await store.withCompany(owner, issuer, async state => { expect(state.grant).toBeUndefined(); });
  });

  it("does not treat unsigned OpenAPI description errors as a rejected Session", async () => {
    const previous = mocked.request.getMockImplementation()!;
    mocked.request.mockImplementation(async (url: string, options: PoppyRequestOptions = {}) => {
      const result = await previous(url, options);
      return url === descriptionUrl ? response(url, { error: "version_unsupported" }, 400) : result;
    });
    expect(await client.describe(owner, "conversation", origin, 0)).toMatchObject({ error: "version_unsupported" });
    expect(calls.filter(call => call.url === `${origin}/.well-known/poppy.json`)).toHaveLength(1);
    expect(calls.filter(call => call.url === descriptionUrl)).toHaveLength(1);
    expect(calls.some(call => call.options.headers?.["Poppy-Session"])).toBe(false);
  });
});

describe("Poppy authenticated owners", () => {
  function context(auth: unknown) { return { session: { auth: { current: auth } } } as unknown as ToolContext; }
  it("rejects anonymous/application sessions and preserves authenticated principal boundaries", () => {
    for (const auth of [undefined, { principalType: "anonymous", principalId: "anonymous" }, { principalType: "app", principalId: "shared-app" }])
      expect(() => poppyOwner(context(auth))).toThrow("authenticated");
    const base = { authenticator: "http-basic", principalType: "user", principalId: "operator" };
    const first = poppyOwner(context(base));
    expect(first).toBe(poppyOwner(context(base)));
    for (const change of [{ principalId: "another-user" }, { authenticator: "linq-message", issuer: "linq" }, { principalType: "local-dev", authenticator: "local-dev" }])
      expect(poppyOwner(context({ ...base, ...change }))).not.toBe(first);
  });
});
