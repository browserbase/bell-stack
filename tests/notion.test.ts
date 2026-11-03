import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionPrincipal } from "eve/connections";
import { hash } from "../server/encrypted-record";
import { notionConfig, notionOwner } from "../server/notion/config";
import { notionCallback } from "../server/notion/callback";
import { NotionOAuth } from "../server/notion/oauth";
import type { LockedState, NotionPersistence, NotionState } from "../server/notion/store";
import { notionPrincipal, createNotionAuth } from "../agent/lib/notion-auth";

import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";
import { AuthKey, SessionIdKey, SessionKey } from "../node_modules/eve/dist/src/context/keys.js";
import { CallbackBaseUrlKey, PendingAuthorizationResultKey, isAuthorizationSignal } from "../node_modules/eve/dist/src/harness/authorization.js";
import { createAuthorizationExecution } from "../node_modules/eve/dist/src/runtime/connections/scoped-authorization.js";
import { resolveWorkflowCallbackBaseUrl } from "../node_modules/eve/dist/src/execution/workflow-callback-url.js";

const owner: ConnectionPrincipal = { type: "user", issuer: "bell:operator", id: "operator" };
const sender: ConnectionPrincipal = { type: "user", issuer: "linq", id: "linq:sender" };
const callbackUrl = "http://127.0.0.1:4274/eve/v1/connections/notion/callback/attempt/capability";
const config = { origin: "https://bell.example", redirectUri: "https://bell.example/api/notion/oauth/callback",
  databaseUrl: "postgres://unused", key: Buffer.alloc(32, 1) };
const metadata = { issuer: "https://mcp.notion.com", authorization_endpoint: "https://mcp.notion.com/authorize",
  token_endpoint: "https://mcp.notion.com/token", registration_endpoint: "https://mcp.notion.com/register", revocation_endpoint: "https://mcp.notion.com/token" };

class MemoryStore implements NotionPersistence {
  rows = new Map<string, NotionState>();
  async findOwner(stateHash: string) {
    return [...this.rows].find(([, value]) => value.pending && hash(value.pending.state) === stateHash)?.[0];
  }
  async withOwner<T>(key: string, operation: (state: LockedState) => Promise<T>): Promise<T> {
    const value = structuredClone(this.rows.get(key) ?? {});
    return operation({ value, save: async () => { this.rows.set(key, structuredClone(value)); } });
  }
}

function fixture() {
  const store = new MemoryStore();
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("oauth-authorization-server")) return Response.json(metadata);
    if (url.endsWith("/register")) return Response.json({ client_id: "registered-client" }, { status: 201 });
    if (url.endsWith("/token") && new URLSearchParams(String(init?.body)).has("token")) return new Response(null, { status: 200 });
    if (url.endsWith("/token")) return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 });
    throw new Error("Unexpected request");
  });
  let now = 1_000_000;
  const oauth = new NotionOAuth(config, store, fetcher, () => now);
  return { store, fetcher, oauth, advance: (milliseconds: number) => { now += milliseconds; } };
}

async function authorize(f: ReturnType<typeof fixture>) {
  const start = await f.oauth.start(owner, callbackUrl);
  const state = new URL(start.challenge.url).searchParams.get("state")!;
  const params = { state, code: "authorization-code" };
  await f.oauth.forward(params);
  await f.oauth.complete(owner, callbackUrl, start.resume, params);
  return { start, params };
}

afterEach(() => vi.unstubAllEnvs());

describe("Notion OAuth", () => {
  it("persists registration and PKCE, reuses pending consent, and forwards only the stored Eve capability", async () => {
    const f = fixture();
    const first = await f.oauth.start(owner, callbackUrl);
    const again = await f.oauth.start(owner, callbackUrl);
    expect(again).toEqual(first);
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/register"))).toHaveLength(1);
    const url = new URL(first.challenge.url);
    const pending = f.store.rows.get(notionOwner(owner))!.pending!;
    expect(url.searchParams.get("code_challenge")).toBe(hash(pending.verifier));
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    const target = new URL(await f.oauth.forward({ state: pending.state, code: "code", iss: metadata.issuer, returnTo: "https://evil.example" }));
    expect(target.origin).toBe(config.origin);
    expect(target.pathname).toBe(new URL(callbackUrl).pathname);
    expect(target.searchParams.has("returnTo")).toBe(false);
  });

  it("rejects wrong owners, callback capabilities and state before exchanging a code", async () => {
    const f = fixture();
    const start = await f.oauth.start(owner, callbackUrl);
    const state = new URL(start.challenge.url).searchParams.get("state")!;
    await expect(f.oauth.forward({ state: "x".repeat(43), code: "code" })).rejects.toThrow();
    await expect(f.oauth.forward({ state, code: "code", iss: "https://evil.example" })).rejects.toThrow();
    await f.oauth.forward({ state, code: "code" });
    await expect(f.oauth.complete(sender, callbackUrl, start.resume, { state, code: "code" })).rejects.toThrow();
    await expect(f.oauth.complete(owner, callbackUrl + "wrong", start.resume, { state, code: "code" })).rejects.toThrow();
    expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/token"))).toBe(false);
  });

  it("completes a durable replay without exchanging the same code twice", async () => {
    const f = fixture();
    const { start, params } = await authorize(f);
    expect(await f.oauth.complete(owner, callbackUrl, start.resume, params)).toEqual({ token: "access", expiresAt: 4_600_000 });
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(1);
    expect(f.store.rows.get(notionOwner(owner))!.pending!.verifier).toBe("");
    await expect(f.oauth.getToken(sender)).rejects.toThrow();
  });

  it("rejects expired or denied consent", async () => {
    const f = fixture();
    const start = await f.oauth.start(owner, callbackUrl);
    const state = new URL(start.challenge.url).searchParams.get("state")!;
    await f.oauth.forward({ state, error: "access_denied" });
    await expect(f.oauth.complete(owner, callbackUrl, start.resume, { state, error: "access_denied" })).rejects.toThrow();
    f.advance(11 * 60_000);
    await expect(f.oauth.forward({ state, code: "code" })).rejects.toThrow();
    expect((await f.oauth.status(owner)).status).toBe("disconnected");
  });

  it("persists refresh rotation and stops retrying a rejected refresh", async () => {
    const f = fixture();
    await authorize(f);
    f.advance(3_600_000);
    f.fetcher.mockImplementation(async input => String(input).endsWith("/token")
      ? Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600 })
      : Response.json(metadata));
    expect((await f.oauth.getToken(owner)).token).toBe("rotated-access");
    expect(f.store.rows.get(notionOwner(owner))!.tokens!.refreshToken).toBe("rotated-refresh");
    f.advance(3_600_000);
    f.fetcher.mockImplementation(async input => String(input).endsWith("/token")
      ? Response.json({ error: "invalid_grant" }, { status: 400 }) : Response.json(metadata));
    await expect(f.oauth.getToken(owner)).rejects.toThrow();
    expect(f.store.rows.get(notionOwner(owner))!.status).toBe("reconnect");
    const count = f.fetcher.mock.calls.length;
    await expect(f.oauth.getToken(owner)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(count);
  });

  it("leaves a lost single-use code exchange blocked instead of replaying it", async () => {
    const f = fixture();
    const start = await f.oauth.start(owner, callbackUrl);
    const params = { state: new URL(start.challenge.url).searchParams.get("state")!, code: "code" };
    await f.oauth.forward(params);
    f.fetcher.mockImplementation(async input => {
      if (String(input).endsWith("/token")) throw new Error("Lost response with private upstream details");
      return Response.json(metadata);
    });
    await expect(f.oauth.complete(owner, callbackUrl, start.resume, params)).rejects.toThrow();
    const count = f.fetcher.mock.calls.length;
    await expect(f.oauth.complete(owner, callbackUrl, start.resume, params)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(count);
    expect(f.store.rows.get(notionOwner(owner))!.pending!.status).toBe("exchanging");
  });

  it("disconnects only the caller and prevents late consent from restoring a grant", async () => {
    const f = fixture();
    const { params } = await authorize(f);
    await f.oauth.start(sender, callbackUrl);
    expect(await f.oauth.disconnect(owner)).toMatchObject({ status: "disconnected" });
    await expect(f.oauth.forward(params)).rejects.toThrow();
    await expect(f.oauth.getToken(owner)).rejects.toThrow();
    expect(f.store.rows.get(notionOwner(sender))!.pending).toBeDefined();
    expect(f.store.rows.get(notionOwner(owner))!.client!.id).toBe("registered-client");
  });

  it("refuses OAuth discovery that would send credentials to another host", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(Response.json({ ...metadata, token_endpoint: "https://evil.example/token" }));
    await expect(f.oauth.start(owner, callbackUrl)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
});

it("validates enabled configuration and refuses application or unrelated user identities", () => {
  expect(() => notionConfig()).toThrow();
  vi.stubEnv("NOTION_ENABLED", "true");
  vi.stubEnv("BELL_PUBLIC_URL", config.origin);
  vi.stubEnv("DATABASE_URL", config.databaseUrl);
  vi.stubEnv("NOTION_TOKEN_ENCRYPTION_KEY", config.key.toString("base64"));
  expect(notionConfig()).toEqual(config);
  expect(() => notionOwner({ type: "app" })).toThrow();
  expect(() => notionOwner({ type: "user", issuer: "other", id: "operator" })).toThrow();
  expect(() => notionPrincipal({ session: { auth: { current: { principalType: "runtime" } } } } as never)).toThrow();
  vi.stubEnv("BELL_PUBLIC_URL", "http://public.example");
  expect(() => notionConfig()).toThrow();
});

it("keeps callback responses private and rejects duplicate parameters before accessing storage", async () => {
  vi.stubEnv("NOTION_ENABLED", "false");
  expect((await notionCallback(new Request("https://bell.example/api/notion/oauth/callback"))).status).toBe(404);
  vi.stubEnv("NOTION_ENABLED", "true");
  const service = vi.fn(() => { throw new Error("Must not access storage"); });
  const response = await notionCallback(new Request("https://bell.example/api/notion/oauth/callback?state=a&state=b&code=c"), service);
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(service).not.toHaveBeenCalled();
});


it("blocks access and replacement consent until a failed remote revocation is retried", async () => {
  const f = fixture();
  const { params } = await authorize(f);
  f.fetcher.mockImplementation(async input => String(input).endsWith("/token")
    ? new Response(null, { status: 503 }) : Response.json(metadata));
  await expect(f.oauth.disconnect(owner)).rejects.toMatchObject({ reason: "revocation_failed_retry_disconnect" });
  expect(await f.oauth.status(owner)).toMatchObject({ status: "disconnect_pending" });
  expect(f.store.rows.get(notionOwner(owner))!.tokens).toBeDefined();
  await expect(f.oauth.getToken(owner)).rejects.toMatchObject({ reason: "disconnect_pending" });
  await expect(f.oauth.start(owner, callbackUrl)).rejects.toMatchObject({ reason: "disconnect_pending" });
  await expect(f.oauth.forward(params)).rejects.toThrow();
  f.fetcher.mockImplementation(async input => String(input).endsWith("/token")
    ? new Response(null, { status: 200 }) : Response.json(metadata));
  expect(await f.oauth.disconnect(owner)).toEqual({ status: "disconnected" });
  const call = f.fetcher.mock.calls.at(-1)!;
  const body = new URLSearchParams(String(call[1]?.body));
  expect(body.get("token")).toBe("refresh");
  expect(body.get("token_type_hint")).toBe("refresh_token");
  expect(body.has("grant_type")).toBe(false);
  expect(f.store.rows.get(notionOwner(owner))!.tokens).toBeUndefined();
});

it("revokes the old grant before replacement consent and re-registers changed redirects", async () => {
  const f = fixture();
  await authorize(f);
  const oldState = f.store.rows.get(notionOwner(owner))!;
  oldState.client!.redirectUri = "https://old.example/api/notion/oauth/callback";
  await f.oauth.start(owner, callbackUrl);
  const calls = f.fetcher.mock.calls;
  const revoke = calls.findIndex(([, init]) => new URLSearchParams(String(init?.body)).has("token"));
  const registrations = calls.flatMap(([url], index) => String(url).endsWith("/register") ? [index] : []);
  expect(registrations).toHaveLength(2);
  expect(revoke).toBeLessThan(registrations[1]);
  expect(f.store.rows.get(notionOwner(owner))!.client!.redirectUri).toBe(config.redirectUri);
});

it("parks and resumes through Eve's actual authorization lifecycle without journaling credentials", async () => {
  const f = fixture();
  const auth = { principalType: "user" as const, principalId: "operator", issuer: "bell:operator", authenticator: "http-basic", attributes: {} };
  const context = new ContextContainer();
  context.set(AuthKey, auth);
  context.set(SessionIdKey, "notion-test-session");
  context.set(SessionKey, { sessionId: "notion-test-session", auth: { current: auth } } as never);
  context.set(CallbackBaseUrlKey, resolveWorkflowCallbackBaseUrl(config.origin));
  const scoped = { scope: "notion", authorization: createNotionAuth(() => f.oauth), connection: { url: "https://mcp.notion.com/mcp" } };
  await contextStorage.run(context, async () => {
    const execution = createAuthorizationExecution();
    const signal = await execution.run(() => execution.getToken(scoped));
    if (!isAuthorizationSignal(signal)) throw new Error("Expected Eve consent suspension");
    const challenge = signal.challenges[0];
    expect(challenge.resume).toEqual({ attemptId: expect.any(String) });
    const state = new URL(challenge.challenge.url!).searchParams.get("state")!;
    const target = new URL(await f.oauth.forward({ state, code: "runtime-code" }));
    expect(target.pathname).toBe(new URL(challenge.hookUrl).pathname);
    context.set(PendingAuthorizationResultKey, [{
      name: challenge.name, attemptId: challenge.attemptId, instanceId: challenge.instanceId,
      principal: challenge.principal, resume: challenge.resume, hookUrl: challenge.hookUrl,
      callback: { method: "GET", params: Object.fromEntries(target.searchParams) },
    }]);
    expect(await createAuthorizationExecution().getToken(scoped)).toMatchObject({ token: "access" });
  });
});

it("omits unsupported callers and checks the stored grant before tools can reuse an Eve bearer", async () => {
  vi.stubEnv("NOTION_ENABLED", "true");
  const definition = (await import("../agent/connections/notion")).default;
  const session = { id: "test", auth: { current: {
    principalType: "user" as const, principalId: "operator", issuer: "bell:operator", authenticator: "http-basic", attributes: {},
  } } };
  const resolver = definition.events["turn.started"]!;
  expect(await resolver({}, { session: { ...session, auth: { current: { principalType: "runtime" } } } } as never)).toBeNull();
  const connection = await resolver({}, { session, channel: {} } as never);
  if (!connection || !("url" in connection) || typeof connection.approval !== "function") throw new Error("Expected an MCP connection with approval policy");
  const f = fixture();
  await authorize(f);
  const oauthModule = await import("../server/notion/oauth");
  const service = vi.spyOn(oauthModule, "getNotionOAuth").mockReturnValue(f.oauth);
  try {
    expect(await connection.approval({ toolName: "notion__notion-fetch" } as never)).toBe("not-applicable");
    expect(await connection.approval({ toolName: "notion__notion-delete-pages" } as never)).toBe("user-approval");
    await f.oauth.disconnect(owner);
    expect(await connection.approval({ toolName: "notion__notion-fetch" } as never)).toBe("denied");
    expect(await connection.approval({ toolName: "notion" } as never)).toBe("not-applicable");
    const status = vi.spyOn(f.oauth, "status").mockRejectedValueOnce(new Error("private database diagnostic"));
    await expect(connection.approval({ toolName: "notion__notion-fetch" } as never))
      .rejects.toMatchObject({ reason: "notion_request_failed" });
    status.mockRestore();
  } finally { service.mockRestore(); }
  vi.stubEnv("NOTION_ENABLED", "false");
  expect(await resolver({}, { session, channel: {} } as never)).toBeNull();
});

it("validates the personal Notion connection through Eve's runtime resolver", async () => {
  vi.stubEnv("NOTION_ENABLED", "true");
  const definition = (await import("../agent/connections/notion")).default;
  const { resolveDynamicConnectionValue } = await import("../node_modules/eve/dist/src/runtime/resolve-connection.js");
  for (const current of [
    { principalType: "user", principalId: "operator", issuer: "bell:operator", authenticator: "http-basic", attributes: {} },
    { principalType: "user", principalId: "linq:sender", issuer: "linq", authenticator: "linq-message", attributes: {} },
  ]) {
    const value = await definition.events["turn.started"]!({}, { session: { id: "test", auth: { current } }, channel: {} } as never);
    const resolved = resolveDynamicConnectionValue(value, {
      connectionName: "notion", logicalPath: "connections/notion.ts", sourceId: "notion-test", sourceKind: "module",
    });
    expect(resolved).toMatchObject({ connectionName: "notion", url: "https://mcp.notion.com/mcp" });
  }
});
