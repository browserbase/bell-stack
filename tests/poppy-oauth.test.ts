import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoppyCompany } from "../server/poppy/discovery";
import { PoppyRateLimitError, type PoppyRequestOptions, type PoppyResponse } from "../server/poppy/http";
import { PoppyIdentity } from "../server/poppy/identity";
import { checkVerificationUri, PoppyOAuth, poppyResource } from "../server/poppy/oauth";
import { PoppyStore, type PoppyGrant } from "../server/poppy/store";

const owner = "verified-owner";
const company: PoppyCompany = {
  version: "1.0", name: "Synthetic Company", domain: "company.example", origin: "https://company.example",
  identifier: "https://identity.company.example/tenant", manifestUrl: "https://company.example/.well-known/poppy.json",
  apis: [{ type: "openapi", url: "https://api.company.example/openapi.json" }],
  scopes: { "orders:read": "Read orders", "profile:read": "Read your profile" }, scopeHints: {}, authDisabled: false,
  oauth: { issuer: "https://identity.company.example/tenant", token_endpoint: "https://identity.company.example/token",
    revocation_endpoint: "https://identity.company.example/revoke", device_authorization_endpoint: "https://identity.company.example/device",
    grant_types_supported: ["refresh_token", "urn:ietf:params:oauth:grant-type:device_code"] },
};
const device = { device_code: "synthetic-private-device", user_code: "DEMO-CODE", verification_uri: "https://company.example/device", expires_in: 600, interval: 5 };
const tokens = { access_token: "synthetic-private-access", refresh_token: "synthetic-private-refresh", expires_in: 3600, token_type: "Bearer", scope: "orders:read" };
const resource = "https://api.company.example/v1";
let directory: string;
let clock: number;
let identity: PoppyIdentity;
let store: PoppyStore;
let oauth: PoppyOAuth;
let replies: Array<{ status: number; body: unknown; headers?: Record<string, string> } | Error>;
const request = vi.fn<(url: string, options?: PoppyRequestOptions) => Promise<PoppyResponse>>();
const reply = (body: unknown, status = 200, headers?: Record<string, string>) => { replies.push({ status, body, headers }); };
const state = () => store.withCompany(owner, company.identifier, async value => structuredClone(value));
const activeGrant = (): PoppyGrant => ({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
  expiresAt: clock + 3_600_000, scopes: ["orders:read"], resource, status: "active" });
async function seed(grant = activeGrant()) { await store.withCompany(owner, company.identifier, async value => { value.grant = grant; value.sessions.existing = "existing_session"; }); }
async function connect(scopes = ["orders:read"]) { reply(device); return oauth.connect(owner, company, scopes, resource); }
async function access(target = resource, force = false) {
  return store.withCompany(owner, company.identifier, (value, save) => oauth.accessToken(company, value, save, target, undefined, force));
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "bell-poppy-oauth-"));
  clock = 1_800_000_000_000;
  identity = new PoppyIdentity({ clientId: "https://bell.example/agent.json",
    privateJwk: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" }), now: () => clock });
  store = new PoppyStore({ path: path.join(directory, "poppy.enc.json"), clientId: identity.clientId, encryptionKey: randomBytes(32) });
  replies = [];
  request.mockReset().mockImplementation(async (url) => {
    const next = replies.shift();
    if (!next) throw new Error("Unexpected synthetic transport call.");
    if (next instanceof Error) throw next;
    return { status: next.status, text: JSON.stringify(next.body), headers: new Headers(next.headers), url };
  });
  oauth = new PoppyOAuth(identity, store, request, () => clock);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("Poppy device OAuth", () => {
  it("authenticates device/token/revocation calls with unique verifiable issuer-bound assertions and exposes only the human challenge", async () => {
    const challenge = await connect();
    expect(challenge).toMatchObject({ status: "sign_in_required", domain: company.domain, company: company.name, userCode: device.user_code });
    expect(JSON.stringify(challenge)).not.toContain(device.device_code);
    clock += 5000;
    reply(tokens);
    const result = await oauth.status(owner, company);
    expect(result).toMatchObject({ status: "connected", scopes: ["orders:read"] });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private/);
    reply({});
    await oauth.disconnect(owner, company);
    const assertions = [];
    for (const [, options] of request.mock.calls) {
      const form = new URLSearchParams(options!.body);
      expect(options!.headers).not.toHaveProperty("Poppy-Session");
      expect(options!.headers).not.toHaveProperty("Authorization");
      expect(form.get("client_id")).toBe(identity.clientId);
      expect(form.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      const token = form.get("client_assertion")!;
      const [header, payload, signature] = token.split(".");
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      expect(claims).toMatchObject({ iss: identity.clientId, sub: identity.clientId, aud: company.identifier });
      expect(verify("sha256", Buffer.from(`${header}.${payload}`), {
        key: createPublicKey({ key: identity.publicJwks().keys[0], format: "jwk" }), dsaEncoding: "ieee-p1363",
      }, Buffer.from(signature, "base64url"))).toBe(true);
      assertions.push(claims.jti);
    }
    expect(new Set(assertions).size).toBe(3);
    expect((await state()).grant).toBeUndefined();
  });

  it("enforces initial polling interval, authorization_pending and persistent slow_down", async () => {
    await connect();
    expect(await oauth.status(owner, company)).toMatchObject({ status: "pending", retryAfterSeconds: 5 });
    expect(request).toHaveBeenCalledTimes(1);
    clock += 5000;
    reply({ error: "authorization_pending" }, 400);
    expect(await oauth.status(owner, company)).toMatchObject({ status: "pending", retryAfterSeconds: 5 });
    clock += 5000;
    reply({ error: "slow_down" }, 400);
    expect(await oauth.status(owner, company)).toMatchObject({ status: "pending", retryAfterSeconds: 10 });
    clock += 9000;
    expect(await oauth.status(owner, company)).toMatchObject({ status: "pending", retryAfterSeconds: 1 });
    expect(request).toHaveBeenCalledTimes(3);
    clock += 1000;
    reply({ error: "authorization_pending" }, 400);
    expect(await oauth.status(owner, company)).toMatchObject({ status: "pending", retryAfterSeconds: 10 });
  });

  it.each(["seconds", "http-date"])("honors Retry-After in %s form", async form => {
    await connect();
    clock += 5000;
    const retry = form === "seconds" ? "45" : new Date(clock + 45_000).toUTCString();
    reply({ error: "slow_down" }, 429, { "retry-after": retry });
    expect(await oauth.status(owner, company)).toMatchObject({ status: "pending", retryAfterSeconds: 45 });
    clock += 44_000;
    expect(await oauth.status(owner, company)).toMatchObject({ status: "pending", retryAfterSeconds: 1 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves a pending device code when transport cooldown prevents dispatch", async () => {
    await connect();
    clock += 5000;
    replies.push(new PoppyRateLimitError(30));
    await expect(oauth.status(owner, company)).rejects.toMatchObject({ retryAfterSeconds: 30 });
    expect((await state()).device).toMatchObject({ status: "pending", deviceCode: device.device_code, nextPollAt: clock + 30_000 });
    clock += 29_000;
    expect(await oauth.status(owner, company)).toMatchObject({ status: "pending", retryAfterSeconds: 1 });
    expect(request).toHaveBeenCalledTimes(2);
    clock += 1000;
    reply(tokens);
    expect(await oauth.status(owner, company)).toMatchObject({ status: "connected" });
  });

  it("preserves current access when replacement is declined or expires", async () => {
    await seed();
    const before = (await state()).grant;
    await connect(["orders:read", "profile:read"]);
    expect((await state()).grant).toEqual(before);
    clock += 5000;
    reply({ error: "access_denied" }, 400);
    expect(await oauth.status(owner, company)).toEqual({ status: "declined" });
    expect((await state()).grant).toEqual(before);
    expect((await state()).sessions).toEqual({ existing: "existing_session" });
    await connect(["orders:read", "profile:read"]);
    clock += 600_000;
    expect(await oauth.status(owner, company)).toEqual({ status: "expired" });
    expect((await state()).grant).toEqual(before);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([
    { ...tokens, scope: "orders:read account:delete" }, { ...tokens, scope: "" },
    { ...tokens, token_type: "DPoP" }, { ...tokens, refresh_token: undefined },
  ])("rejects invalid account grants while retaining the earlier grant", async token => {
    await seed();
    const before = (await state()).grant;
    await connect();
    clock += 5000;
    reply(token);
    await expect(oauth.status(owner, company)).rejects.toThrow();
    expect((await state()).grant).toEqual(before);
    expect((await state()).device?.status).not.toBe("pending");
    await expect(oauth.status(owner, company)).rejects.toThrow("uncertain");
  });

  it("does not poll another owner's pending request or reuse an uncertain consumed device code", async () => {
    await connect();
    expect(await oauth.status("different-owner", company)).toMatchObject({ status: "disconnected" });
    clock += 5000;
    replies.push(new Error("Poppy request failed."));
    await expect(oauth.status(owner, company)).rejects.toThrow("request failed");
    expect((await state()).device?.status).toBe("polling");
    await expect(oauth.status(owner, company)).rejects.toThrow("uncertain");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retains retired grants when replacement revocation fails, then disconnect revokes every grant", async () => {
    await seed();
    await connect();
    clock += 5000;
    reply({ ...tokens, access_token: "replacement-access", refresh_token: "replacement-refresh" });
    reply({ error: "temporarily_unavailable" }, 503);
    expect(await oauth.status(owner, company)).toMatchObject({ status: "connected" });
    expect((await state()).grant?.refreshToken).toBe("replacement-refresh");
    expect((await state()).retiredRefreshTokens).toEqual([tokens.refresh_token]);
    expect((await state()).sessions).toEqual({});
    reply({}); reply({});
    await oauth.disconnect(owner, company);
    const revoked = request.mock.calls.filter(([url]) => url === company.oauth!.revocation_endpoint)
      .map(([, options]) => new URLSearchParams(options!.body).get("token"));
    expect(revoked).toEqual([tokens.refresh_token, tokens.refresh_token, "replacement-refresh"]);
    expect((await state()).grant).toBeUndefined();
  });
});

describe("Poppy token lifetime and boundaries", () => {
  it.each([false, true])("refreshes for another resource and handles refresh rotation=%s", async rotate => {
    await seed();
    expect(await access()).toBe(tokens.access_token);
    expect(request).not.toHaveBeenCalled();
    const nextResource = "https://mcp.company.example/mcp";
    reply({ access_token: "next-access", token_type: "Bearer", expires_in: 3600, ...(rotate ? { refresh_token: "next-refresh" } : {}) });
    expect(await access(nextResource)).toBe("next-access");
    const form = new URLSearchParams(request.mock.calls[0][1]!.body);
    expect(form.get("resource")).toBe(nextResource);
    expect(form.get("scope")).toBe("orders:read");
    expect(form.get("refresh_token")).toBe(tokens.refresh_token);
    expect((await state()).grant).toMatchObject({ resource: nextResource, refreshToken: rotate ? "next-refresh" : tokens.refresh_token });
  });

  it("blocks refresh after an uncertain response and drops a definitively revoked grant", async () => {
    await seed();
    replies.push(new Error("Poppy request failed."));
    await expect(access(resource, true)).rejects.toThrow("request failed");
    expect((await state()).grant?.status).toBe("uncertain");
    await expect(access()).rejects.toThrow("blocked");
    await seed();
    reply({ error: "invalid_grant" }, 400);
    expect(await access(resource, true)).toBeUndefined();
    expect((await state()).grant).toBeUndefined();
    expect((await state()).sessions).toEqual({});
  });

  it("retains the existing grant and resource when a refresh is blocked before dispatch", async () => {
    await seed();
    const before = (await state()).grant;
    replies.push(new PoppyRateLimitError(30));
    await expect(access("https://api.company.example/other")).rejects.toMatchObject({ retryAfterSeconds: 30 });
    expect((await state()).grant).toEqual(before);
    expect((await state()).sessions).toEqual({ existing: "existing_session" });
    clock += 30_000;
    reply({ ...tokens, access_token: "refreshed-after-cooldown" });
    expect(await access(resource, true)).toBe("refreshed-after-cooldown");
  });

  it.each(["seconds", "http-date", "absent"])("retains authorization after an explicit429 refresh rejection with %s Retry-After", async form => {
    await seed();
    const before = (await state()).grant;
    const headers = form === "absent" ? undefined : { "retry-after": form === "seconds" ? "45" : new Date(clock + 45_000).toUTCString() };
    reply({ error: "rate_limited" }, 429, headers);
    await expect(access(resource, true)).rejects.toThrow(/rate limited/);
    expect((await state()).grant).toEqual(before);
    expect((await state()).sessions).toEqual({ existing: "existing_session" });
    clock += 45_000;
    reply({ ...tokens, access_token: "refreshed-after-429" });
    expect(await access(resource, true)).toBe("refreshed-after-429");
  });

  it("blocks local account use immediately when remote revocation fails and allows retry", async () => {
    await seed();
    reply({ error: "temporary" }, 503);
    await expect(oauth.disconnect(owner, company)).rejects.toThrow("blocked locally");
    expect((await state()).grant?.status).toBe("revoking");
    await expect(access()).rejects.toThrow("blocked");
    await expect(oauth.connect(owner, company, ["orders:read"])).rejects.toThrow("Finish disconnecting");
    reply({});
    expect(await oauth.disconnect(owner, company)).toEqual({ status: "disconnected" });
    expect((await state()).grant).toBeUndefined();
  });

  it("allows existing refresh/revocation when new sign-in is disabled", async () => {
    await seed();
    const disabled = { ...company, authDisabled: true };
    await expect(oauth.connect(owner, disabled, ["orders:read"])).rejects.toThrow("does not offer device sign-in");
    reply({ ...tokens, access_token: "refreshed-access" });
    expect(await store.withCompany(owner, company.identifier, (value, save) => oauth.accessToken(disabled, value, save, resource, undefined, true))).toBe("refreshed-access");
    reply({});
    expect(await oauth.disconnect(owner, disabled)).toEqual({ status: "disconnected" });
  });

  it("requires exact MCP resource and issuer binding before requesting scoped tokens", async () => {
    const server = "https://mcp.company.example/mcp";
    reply({ resource: server, authorization_servers: [company.identifier] });
    expect(await poppyResource(company, server, "mcp", undefined, request)).toBe(server);
    for (const metadata of [{ resource: "https://mcp.company.example/other", authorization_servers: [company.identifier] },
      { resource: server, authorization_servers: ["https://unrelated.example"] }]) {
      reply(metadata);
      await expect(poppyResource(company, server, "mcp", undefined, request)).rejects.toThrow();
    }
    reply({}, 404);
    expect(await poppyResource(company, resource, "openapi", undefined, request)).toBeUndefined();
    reply({}, 503);
    await expect(poppyResource(company, resource, "openapi", undefined, request)).rejects.toThrow("unavailable");
  });
});

describe("human sign-in destination", () => {
  it("accepts only the company's domain, issuer host, or their true subdomains", () => {
    for (const url of ["https://company.example/device", "https://login.company.example/device", "https://identity.company.example/device"])
      expect(checkVerificationUri(url, company)).toBe(url);
    for (const url of ["https://company.example.attacker.example/device", "https://notcompany.example/device", "https://attacker.example/company.example",
      "http://company.example/device", "https://secret@company.example/device", "https://company.example:8443/device", "https://company.example/device#code"])
      expect(() => checkVerificationUri(url, company)).toThrow("unrelated sign-in page");
  });
});
