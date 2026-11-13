import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";
import { PoppyClient } from "../server/poppy/client";
import { PoppyIdentity } from "../server/poppy/identity";
import { PoppyStore } from "../server/poppy/store";

const network = vi.hoisted(() => ({ fetch: undefined as typeof globalThis.fetch | undefined }));
vi.mock("@datalayer/personal-agent-protocol/server", async (original) => ({
  ...await original<typeof import("@datalayer/personal-agent-protocol/server")>(),
  createResolvingFetch: () => network.fetch,
  NodeUrlSafetyPolicy: class { async assertSafe() {} },
}));

const company = "https://catalog.example";
const issuer = "https://auth.catalog.example";
const mcp = `${company}/mcp`;
const clientId = "https://bell.example/poppy/agent.json";
const scope = "catalog:read";
const privateValues = ["private-device-code", "private-initial-access", "private-refresh-0", "private-refresh-1", "private-resource-access-1"];

function provider() {
  const requests: { url: string; method: string; headers: Headers; body: string }[] = [];
  const state = { approved: false, version: "0.4", refreshes: 0, failRefresh: false, failRevoke: false };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.text();
    requests.push({ url: request.url, method: request.method, headers: request.headers, body });
    if (request.url === `${company}/.well-known/poppy.json`) return Response.json({
      protocol_version: state.version, organization: { name: "Example Catalog", domain: "catalog.example" },
      auth: { issuer, scopes: { [scope]: "Read catalog data" } },
      apis: [{ type: "mcp", url: mcp, description: "Read catalog data" }],
    });
    if (request.url === `${company}/.well-known/oauth-protected-resource`) return Response.json({ resource: company, authorization_servers: [issuer] });
    if (request.url === `${company}/.well-known/oauth-protected-resource/mcp`) return Response.json({ resource: mcp, authorization_servers: [issuer] });
    if (request.url === `${issuer}/.well-known/oauth-authorization-server`) return Response.json({
      issuer, protected_resources: [company], token_endpoint: `${issuer}/token`, revocation_endpoint: `${issuer}/revoke`,
      device_authorization_endpoint: `${issuer}/device`, scopes_supported: [scope],
      grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    });
    if (request.url === `${issuer}/device`) return Response.json({
      device_code: "private-device-code", user_code: "TEST-CODE", verification_uri: `${issuer}/verify`, expires_in: 600, interval: 1,
    });
    const form = new URLSearchParams(body);
    if (request.url === `${issuer}/token`) {
      if (form.get("grant_type") === "refresh_token") {
        if (state.failRefresh) return Response.json({ error: "temporarily_unavailable", error_description: "private-refresh-0" }, { status: 503 });
        state.refreshes++;
        return Response.json({ access_token: `private-resource-access-${state.refreshes}`, refresh_token: `private-refresh-${state.refreshes}`, token_type: "Bearer", scope, expires_in: 3600 });
      }
      if (!state.approved) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return Response.json({ access_token: "private-initial-access", refresh_token: "private-refresh-0", token_type: "Bearer", scope, expires_in: 3600 });
    }
    if (request.url === `${issuer}/revoke`) return state.failRevoke
      ? Response.json({ error: "temporarily_unavailable", error_description: "private-refresh-1" }, { status: 503 })
      : new Response(null, { status: 200 });
    if (request.url === mcp) {
      if (!request.headers.has("authorization")) return new Response("private provider detail", { status: 401 });
      if (request.method === "GET") return new Response(null, { status: 405 });
      const rpc = JSON.parse(body);
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "server/discover") return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
      let result: unknown;
      if (rpc.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "catalog", version: "1" } };
      if (rpc.method === "tools/list") result = { tools: [{ name: "search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] };
      if (rpc.method === "tools/call") result = { content: [], structuredContent: {
        items: ["milk"], access_token: "private-initial-access", echo: request.headers.get("authorization"), proof: request.headers.get("poppy-session"),
      } };
      if (result) return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    }
    throw new Error(`Unexpected fixture request: ${request.url}`);
  };
  return { fetch, requests, state };
}

let directory: string;
let config: { path: string; encryptionKey: Buffer; clientId: string };
let identity: PoppyIdentity;
let remote: ReturnType<typeof provider>;
function client() { return new PoppyClient(identity, new PoppyStore(config)); }
async function signedIn() {
  const start = await client().connect("owner-a", "conversation", company, 0, [scope]);
  remote.state.approved = true;
  vi.setSystemTime(Date.now() + 2000);
  const status = await client().status("owner-a", company);
  expect(status).toMatchObject({ status: "connected", scopes: [scope] });
  return { start, status };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  directory = await mkdtemp(path.join(tmpdir(), "bell-poppy-sdk-"));
  config = { path: path.join(directory, "state.enc.json"), encryptionKey: randomBytes(32), clientId };
  const privateJwk = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
  identity = new PoppyIdentity({ clientId, privateJwk });
  remote = provider();
  network.fetch = remote.fetch;
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

describe("Bell's SDK-backed Poppy accounts", () => {
  it("resumes persisted SDK sign-in state and keeps tokens out of model results and disk plaintext", async () => {
    const start = await client().connect("owner-a", "conversation", company, 0, [scope]);
    expect(start).toMatchObject({ status: "sign_in_required", userCode: "TEST-CODE", verificationUri: `${issuer}/verify` });
    // A fresh client/store must restore SDK Date and SecretValue instances before polling.
    expect(await client().status("owner-a", company)).toMatchObject({ status: "pending" });
    expect(remote.requests.filter((entry) => entry.url === `${issuer}/token`)).toHaveLength(0);
    remote.state.approved = true;
    vi.setSystemTime(Date.now() + 2000);
    const status = await client().status("owner-a", company);
    expect(status).toMatchObject({ status: "connected", scopes: [scope] });
    const read = await client().read("owner-a", "conversation", company, 0, "search", {});
    expect(read).toMatchObject({ data: { items: ["milk"], access_token: "[redacted]", proof: expect.stringContaining("[redacted") } });
    const exposed = JSON.stringify([start, status, read]) + await readFile(config.path, "utf8");
    for (const value of privateValues) expect(exposed).not.toContain(value);
    const refresh = remote.requests.find((entry) => new URLSearchParams(entry.body).get("grant_type") === "refresh_token");
    expect(new URLSearchParams(refresh!.body).get("resource")).toBe(mcp);
    const signedRead = remote.requests.find((entry) => entry.url === mcp && entry.method === "POST");
    expect(signedRead?.headers.get("authorization")).toBe("Bearer private-resource-access-1");
    expect(signedRead?.headers.get("poppy-session")).toMatch(/^eyJ/);
    await client().disconnect("owner-a", company);
    const revoke = remote.requests.find((entry) => entry.url === `${issuer}/revoke`);
    expect(new URLSearchParams(revoke!.body).get("token")).toBe("private-refresh-1");
    expect(await client().status("owner-a", company)).toMatchObject({ status: "disconnected" });
  });

  it("isolates owners' account grants and pairwise session identities", async () => {
    await signedIn();
    await client().read("owner-a", "same-conversation", company, 0, "search", {});
    expect(await client().status("owner-b", company)).toMatchObject({ status: "disconnected" });
    const before = remote.requests.length;
    expect(await client().read("owner-b", "same-conversation", company, 0, "search", {})).toMatchObject({ error: "auth_required" });
    const secondOwner = remote.requests.slice(before).filter((entry) => entry.url === mcp);
    expect(secondOwner.length).toBeGreaterThan(0);
    expect(secondOwner.every((entry) => !entry.headers.has("authorization"))).toBe(true);
    const firstProof = remote.requests.find((entry) => entry.url === mcp)!.headers.get("poppy-session")!;
    const secondProof = secondOwner[0].headers.get("poppy-session")!;
    expect(decodeJwt(firstProof).sub).not.toBe(decodeJwt(secondProof).sub);
    expect(await client().status("owner-a", company)).toMatchObject({ status: "connected" });
  });

  it("fails closed after an ambiguous credential mutation until disconnect recovers it", async () => {
    await signedIn();
    remote.state.failRefresh = true;
    await expect(client().read("owner-a", "conversation", company, 0, "search", {})).rejects.toThrow("Poppy SDK request failed");
    expect(await client().status("owner-a", company)).toMatchObject({ status: "recovery_required" });
    const before = remote.requests.filter((entry) => [mcp, `${issuer}/token`].includes(entry.url)).length;
    await expect(client().read("owner-a", "conversation", company, 0, "search", {})).rejects.toThrow("needs recovery");
    expect(remote.requests.filter((entry) => [mcp, `${issuer}/token`].includes(entry.url))).toHaveLength(before);
    remote.state.failRevoke = true;
    await expect(client().disconnect("owner-a", company)).rejects.toThrow("Poppy SDK request failed");
    expect(await client().status("owner-a", company)).toMatchObject({ status: "recovery_required" });
    remote.state.failRevoke = false;
    expect(await client().disconnect("owner-a", company)).toMatchObject({ status: "disconnected" });
  });

  it("reports the installed SDK's unsupported version without a local compatibility implementation", async () => {
    remote.state.version = "0.3";
    await expect(client().discover(company)).rejects.toThrow("unsupported by the installed SDK");
    expect(remote.requests.every((entry) => entry.method === "GET")).toBe(true);
  });
});
