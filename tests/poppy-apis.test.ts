import { describe, expect, it, vi } from "vitest";
import { describePoppyApi, readPoppyApi } from "../server/poppy/apis.js";
import type { PoppyCompany } from "../server/poppy/discovery.js";
import { PoppyRateLimitError, type PoppyRequestOptions, type PoppyResponse } from "../server/poppy/http.js";

const DOCUMENT = "https://shop.example/openapi.json";
const RESOURCE = "https://api.shop.example/v1";
const MCP = "https://grocer.example/mcp";
const MODERN = "2026-07-28";
function company(type = "openapi", url = DOCUMENT): PoppyCompany {
  return { version: "0.4", name: "Example", domain: "shop.example", origin: "https://shop.example", identifier: "https://shop.example", manifestUrl: "https://shop.example/.well-known/poppy.json", apis: [{ type, url }], scopes: { "orders:read": "Read orders" }, scopeHints: {}, authDisabled: false };
}
function reply(url: string, data: unknown, status = 200, headers: Record<string, string> = {}): PoppyResponse {
  return { url, status, headers: new Headers({ "content-type": "application/json", ...headers }), text: JSON.stringify(data) };
}
function document() {
  return {
    openapi: "3.1.0", servers: [{ url: RESOURCE }],
    components: { securitySchemes: { Account: { type: "http", scheme: "bearer" }, Agent: { type: "apiKey", in: "header", name: "Poppy-Session" } }, parameters: { cursor: { name: "cursor", in: "query", schema: { type: "string", maxLength: 256 } } } },
    paths: {
      "/catalog": { get: { operationId: "catalog" } },
      "/orders/{id}": { get: { operationId: "order", security: [{ Account: ["orders:read"], Agent: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { $ref: "#/components/parameters/cursor" }] } },
      "/account": { get: { operationId: "account", security: [{ Account: [] }] } },
      "/orders": { post: { operationId: "createOrder" } },
    },
  };
}
function headers() { return vi.fn((method: string, url: string) => ({ "Poppy-Session": `signed-proof-${method}-${url}`, Authorization: "Bearer test-account-token" })); }
function openApiRequest(doc: unknown = document(), result: unknown = { items: ["paper"] }) {
  return vi.fn(async (url: string, options?: PoppyRequestOptions) => {
    expect(options?.method).toBe("GET");
    return reply(url, url === DOCUMENT ? doc : result);
  });
}
const inputSchema = { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false };
const readTool = { name: "search", description: "Find current grocery offers", inputSchema, annotations: { readOnlyHint: true, destructiveHint: false } };
function rpcResponse(url: string, options: PoppyRequestOptions | undefined, result: unknown, status = 200, responseHeaders: Record<string, string> = {}) {
  const body = JSON.parse(options?.body ?? "{}") as { id?: string };
  return reply(url, { jsonrpc: "2.0", id: body.id, result }, status, responseHeaders);
}
function modernRequest(tools: unknown[] = [readTool], data: unknown = { offers: [{ price: 1.49 }] }) {
  return vi.fn(async (url: string, options?: PoppyRequestOptions) => {
    const body = JSON.parse(options?.body ?? "{}") as { method: string };
    if (body.method === "server/discover") return rpcResponse(url, options, { resultType: "complete", supportedVersions: [MODERN], capabilities: { tools: {} } });
    if (body.method === "tools/list") return rpcResponse(url, options, { resultType: "complete", tools });
    if (body.method === "tools/call") return rpcResponse(url, options, { resultType: "complete", structuredContent: data });
    throw new Error("Unexpected RPC");
  });
}

describe("Poppy OpenAPI reads", () => {
  it("describes only GETs and their account scopes without sending proofs to metadata", async () => {
    const request = openApiRequest();
    const proof = headers();
    const result = await describePoppyApi(company(), 0, undefined, request, proof);
    expect(result).toMatchObject({ type: "openapi", resource: RESOURCE, operations: [
      { id: "catalog", scopes: [], requiresAccount: false },
      { id: "order", scopes: ["orders:read"], requiresAccount: true },
      { id: "account", scopes: [], requiresAccount: true },
    ] });
    expect(proof).not.toHaveBeenCalled();
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ Accept: "application/json" });
  });

  it("derives one literal path and encoded query from the selected operation", async () => {
    const request = openApiRequest();
    const proof = headers();
    const result = await readPoppyApi(company(), 0, "order", { id: "order 42", cursor: "a&admin=true" }, { request, headers: proof, expectedResource: RESOURCE });
    const target = `${RESOURCE}/orders/order%2042?cursor=a%26admin%3Dtrue`;
    expect(result).toEqual({ data: { items: ["paper"] }, resource: RESOURCE, operation: "order" });
    expect(proof).toHaveBeenCalledExactlyOnceWith("GET", target);
    expect(request.mock.calls.map(([url]) => url)).toEqual([DOCUMENT, target]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer test-account-token" } });
    expect(request.mock.calls[1]?.[1]?.discoveryRedirects).toBeUndefined();
  });

  it.each([".", "..", "../other", "%2e%2e", "a/b", "a\\b", "a?b", "a#b", ""]) ("rejects path injection %j before signing", async (id) => {
    const request = openApiRequest();
    const proof = headers();
    expect(await readPoppyApi(company(), 0, "order", { id }, { request, headers: proof })).toMatchObject({ error: "invalid_parameters" });
    expect(proof).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown or credential arguments and operations", async () => {
    for (const [operation, parameters] of [["order", { id: "one", Authorization: "secret" }], ["order", { id: "one", url: "https://elsewhere.example" }], ["https://elsewhere.example", {}], ["createOrder", {}]] as const) {
      const request = openApiRequest();
      const proof = headers();
      expect(await readPoppyApi(company(), 0, operation, parameters, { request, headers: proof })).toMatchObject({ error: "invalid_parameters" });
      expect(proof).not.toHaveBeenCalled();
    }
  });

  it("omits cross-resource overrides, external references, and credential/header parameters", async () => {
    const doc = document();
    Object.assign(doc.paths, {
      "/other": { get: { operationId: "other", servers: [{ url: "https://other.example" }] } },
      "/external": { get: { operationId: "external", parameters: [{ $ref: "https://other.example/schema.json" }] } },
      "/header": { get: { operationId: "header", parameters: [{ name: "x-custom", in: "header", schema: { type: "string" } }] } },
      "/credential": { get: { operationId: "credential", parameters: [{ name: "access_token", in: "query", schema: { type: "string" } }] } },
      "/pattern": { get: { operationId: "pattern", parameters: [{ name: "q", in: "query", schema: { type: "string", pattern: "^[a-z]+$" } }] } },
    });
    const request = openApiRequest(doc);
    const description = await describePoppyApi(company(), 0, undefined, request);
    expect("operations" in description && description.operations.map((op) => op.id)).toEqual(["catalog", "order", "account"]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("pins the authenticated resource when the fetched document changes", async () => {
    const doc = document();
    doc.servers[0]!.url = "https://other.example";
    const request = openApiRequest(doc);
    const proof = headers();
    expect(await readPoppyApi(company(), 0, "catalog", {}, { request, headers: proof, expectedResource: RESOURCE })).toMatchObject({ error: "unsupported_api" });
    expect(proof).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["http://api.shop.example", "https://user:password@api.shop.example", "https://api.shop.example/{tenant}", "https://api.shop.example?redirect=1"]) ("rejects unsafe server %s", async (url) => {
    const doc = document();
    doc.servers[0]!.url = url;
    expect(await describePoppyApi(company(), 0, undefined, openApiRequest(doc))).toMatchObject({ error: "unsupported_api" });
  });

  it("returns structured authentication challenges without private provider details", async () => {
    const request = vi.fn(async (url: string) => url === DOCUMENT ? reply(url, document()) : reply(url, { error_description: "private test-account-token" }, 403, { "www-authenticate": 'Bearer error="insufficient_scope", scope="orders:read addresses", error_description="private test-account-token"' }));
    const result = await readPoppyApi(company(), 0, "catalog", {}, { request, headers: headers() });
    expect(result).toEqual({ error: "insufficient_scope", message: "This read requires additional account permission.", scopes: ["orders:read", "addresses"] });
    expect(JSON.stringify(result)).not.toContain("test-account-token");
  });

  it("rejects redirects and never follows a new resource", async () => {
    const request = vi.fn(async (url: string) => url === DOCUMENT ? reply(url, document()) : reply(url, {}, 302, { location: "https://other.example" }));
    expect(await readPoppyApi(company(), 0, "catalog", {}, { request, headers: headers() })).toMatchObject({ error: "api_error" });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("Poppy MCP reads", () => {
  it("negotiates the modern protocol and signs each request separately", async () => {
    const request = modernRequest([readTool, { ...readTool, name: "delete", annotations: { readOnlyHint: true, destructiveHint: true } }, { ...readTool, name: "unknown", annotations: {} }]);
    const proof = headers();
    const description = await describePoppyApi(company("mcp", MCP), 0, undefined, request, proof);
    expect(description).toMatchObject({ type: "mcp", resource: MCP, operations: [{ id: "search" }] });
    expect("operations" in description && description.operations).toHaveLength(1);
    const result = await readPoppyApi(company("mcp", MCP), 0, "search", { query: "oat milk" }, { request, headers: proof, expectedResource: MCP });
    expect(result).toEqual({ data: { offers: [{ price: 1.49 }] }, resource: MCP, operation: "search" });
    expect(proof).toHaveBeenCalledTimes(5);
    for (const [, options] of request.mock.calls) {
      const body = JSON.parse(options?.body ?? "{}");
      expect(options?.headers).toMatchObject({ "MCP-Protocol-Version": MODERN, "Mcp-Method": body.method });
      expect(body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe(MODERN);
    }
    expect(request.mock.calls.at(-1)?.[1]?.headers?.["Mcp-Name"]).toBe("search");
  });

  it.each([400, 200])("negotiates legacy MCP after HTTP %i method-not-found and keeps its session headers", async (status) => {
    const request = vi.fn(async (url: string, options?: PoppyRequestOptions) => {
      const body = JSON.parse(options?.body ?? "{}");
      if (body.method === "server/discover") return reply(url, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }, status);
      if (body.method === "initialize") return rpcResponse(url, options, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "example", version: "1" } }, 200, { "mcp-session-id": "session-from-initialize" });
      expect(options?.headers?.["Mcp-Session-Id"]).toBe("session-from-initialize");
      expect(options?.headers?.["MCP-Protocol-Version"]).toBe("2025-06-18");
      expect(options?.headers?.["Mcp-Method"]).toBeUndefined();
      if (body.method === "notifications/initialized") return { ...reply(url, undefined, 202), text: "" };
      if (body.method === "tools/list") return rpcResponse(url, options, { tools: [readTool] });
      return rpcResponse(url, options, { content: [{ type: "text", text: "Current offer: 1.49" }] });
    });
    const result = await readPoppyApi(company("mcp", MCP), 0, "search", { query: "milk" }, { request, headers: headers() });
    expect(result).toMatchObject({ data: { content: [{ type: "text", text: "Current offer: 1.49" }] } });
    expect(request.mock.calls.map(([, options]) => JSON.parse(options?.body ?? "{}").method)).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list", "tools/call"]);
  });

  it("consumes only the matching SSE result and stops persistent streams immediately", async () => {
    const base = modernRequest();
    const request = vi.fn(async (url: string, options?: PoppyRequestOptions) => {
      const response = await base(url, options);
      const body = JSON.parse(options?.body ?? "{}");
      const noise = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "other-request", result: { offers: ["wrong"] } })}\n\n`;
      const streamHeaders = new Headers({ "content-type": "text/event-stream" });
      expect(options?.until?.(noise, streamHeaders)).toBe(false);
      expect(options?.until?.(`${noise}data: ${response.text}`, streamHeaders)).toBe(false);
      const text = `${noise}data: ${response.text}\n\n`;
      expect(options?.until?.(text, streamHeaders)).toBe(true);
      if (body.method === "tools/call") expect(text).toContain('"price":1.49');
      return { ...response, headers: streamHeaders, text };
    });
    expect(await readPoppyApi(company("mcp", MCP), 0, "search", { query: "milk" }, { request, headers: headers() })).toMatchObject({ data: { offers: [{ price: 1.49 }] } });
  });

  it("encodes declared modern header parameters and cannot override auth", async () => {
    const tool = { ...readTool, inputSchema: { ...inputSchema, properties: { query: { type: "string", "x-mcp-header": "Query" } } } };
    const request = modernRequest([tool]);
    expect(await readPoppyApi(company("mcp", MCP), 0, "search", { query: "Hafermilch €" }, { request, headers: headers() })).toHaveProperty("data");
    expect(request.mock.calls.at(-1)?.[1]?.headers?.["Mcp-Param-Query"]).toBe(`=?base64?${Buffer.from("Hafermilch €").toString("base64")}?=`);
    expect(request.mock.calls.at(-1)?.[1]?.headers?.Authorization).toBe("Bearer test-account-token");
  });

  it("does not downgrade modern header/authentication errors", async () => {
    for (const code of [-32020, -32021]) {
      const request = vi.fn(async (url: string, options?: PoppyRequestOptions) => reply(url, { jsonrpc: "2.0", id: JSON.parse(options?.body ?? "{}").id, error: { code, message: "private error" } }, 400));
      expect(await describePoppyApi(company("mcp", MCP), 0, undefined, request)).toMatchObject({ error: "api_error" });
      expect(request).toHaveBeenCalledTimes(1);
    }
    const request = vi.fn(async (url: string) => reply(url, { error: "invalid_token", private: "secret" }, 401));
    expect(await describePoppyApi(company("mcp", MCP), 0, undefined, request)).toMatchObject({ error: "auth_required" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["session_ended", "version_unsupported", "invalid_session"])("preserves Poppy %s without legacy fallback or private error details", async (error) => {
    const request = vi.fn(async (url: string) => reply(url, { error, error_description: "test-account-token" }, 400));
    const result = await describePoppyApi(company("mcp", MCP), 0, undefined, request, headers());
    expect(result).toMatchObject({ error });
    expect(JSON.stringify(result)).not.toContain("test-account-token");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe schemas and tools without explicit read-only annotations before tools/call", async () => {
    const unsafe = [
      { ...readTool, annotations: { destructiveHint: false } },
      { ...readTool, inputSchema: { ...inputSchema, properties: { password: { type: "string" } }, required: [] } },
      { ...readTool, inputSchema: { ...inputSchema, additionalProperties: true } },
      { ...readTool, inputSchema: { $ref: "https://other.example/schema.json" } },
      { ...readTool, inputSchema: { type: "array", items: { type: "string" } } },
      { ...readTool, inputSchema: { ...inputSchema, "x-mcp-header": "Root" } },
      { ...readTool, inputSchema: { ...inputSchema, properties: { query: { type: "string", maxLength: "x" } } } },
      { ...readTool, inputSchema: { ...inputSchema, properties: { query: { type: "string", "x-mcp-header": "Query\r\nAuthorization" } } } },
    ];
    for (const tool of unsafe) {
      const request = modernRequest([tool]);
      expect(await readPoppyApi(company("mcp", MCP), 0, "search", { query: "milk" }, { request, headers: headers() })).toMatchObject({ error: "invalid_parameters" });
      expect(request).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects mismatched response ids and interactive results", async () => {
    const wrongId = vi.fn(async (url: string) => reply(url, { jsonrpc: "2.0", id: "unrelated", result: {} }));
    expect(await describePoppyApi(company("mcp", MCP), 0, undefined, wrongId)).toMatchObject({ error: "api_error" });
    const interactive = vi.fn(async (url: string, options?: PoppyRequestOptions) => rpcResponse(url, options, { resultType: "input_required", request: { secret: "private" } }));
    expect(await describePoppyApi(company("mcp", MCP), 0, undefined, interactive)).toMatchObject({ error: "unsupported_api" });
  });

  it("pins the MCP resource before sending any signed request", async () => {
    const request = modernRequest();
    const proof = headers();
    expect(await readPoppyApi(company("mcp", MCP), 0, "search", { query: "milk" }, { request, headers: proof, expectedResource: "https://other.example/mcp" })).toMatchObject({ error: "unsupported_api" });
    expect(request).not.toHaveBeenCalled();
    expect(proof).not.toHaveBeenCalled();
  });
});

describe("Poppy response boundaries", () => {
  it.each(["seconds", "http-date"])("returns explicit429 timing from %s without exposing bodies or retrying", async form => {
    const clock = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(clock);
    try {
      const retry = form === "seconds" ? "45" : new Date(clock + 45_000).toUTCString();
      const request = vi.fn(async (url: string) => url === DOCUMENT ? reply(url, document())
        : reply(url, { message: "private test-account-token" }, 429, { "retry-after": retry }));
      const result = await readPoppyApi(company(), 0, "catalog", {}, { request, headers: headers() });
      expect(result).toEqual({ error: "rate_limited", message: "This endpoint is rate limited. Wait before retrying.", retryAfterSeconds: 45 });
      expect(request).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain("test-account-token");
    } finally { now.mockRestore(); }
  });

  it("preserves the remaining transport cooldown in its structured result", async () => {
    const request = vi.fn(async () => { throw new PoppyRateLimitError(17); });
    const result = await describePoppyApi(company(), 0, undefined, request);
    expect(result).toMatchObject({ error: "rate_limited", retryAfterSeconds: 17 });
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not negotiate another MCP version or invent timing after429 without Retry-After", async () => {
    const request = vi.fn(async (url: string) => reply(url, { private: "diagnostic" }, 429));
    const result = await describePoppyApi(company("mcp", MCP), 0, undefined, request, headers());
    expect(result).toEqual({ error: "rate_limited", message: "This endpoint is rate limited. Wait before retrying." });
    expect(request).toHaveBeenCalledOnce();
  });

  it("redacts nested credentials and echoed signing material", async () => {
    const request = openApiRequest(document(), { access_token: "private-account", debug: "test-account-token", nested: JSON.stringify({ refresh_token: "private-refresh", message: `signed-proof-GET-${RESOURCE}/catalog` }) });
    const result = await readPoppyApi(company(), 0, "catalog", {}, { request, headers: headers() });
    const encoded = JSON.stringify(result);
    for (const secret of ["private-account", "private-refresh", "test-account-token", "signed-proof"]) expect(encoded).not.toContain(secret);
    expect(encoded).toContain("[redacted]");
  });

  it("bounds large responses with an explicit truncation indicator", async () => {
    const request = openApiRequest(document(), { items: Array.from({ length: 4000 }, () => ({ description: 'A long description with "quoted" values '.repeat(10) })) });
    const result = await readPoppyApi(company(), 0, "catalog", {}, { request, headers: headers() });
    // A document over the transport limit is rejected before trying to summarize.
    expect(result).toMatchObject({ error: "api_error" });
    const withinTransport = openApiRequest(document(), { items: Array.from({ length: 2000 }, () => ({ description: 'A long description with "quoted" values' })) });
    const bounded = await readPoppyApi(company(), 0, "catalog", {}, { request: withinTransport, headers: headers() });
    expect(bounded).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(32 * 1024);
  });

  it("does not silently drop array entries below the output limit", async () => {
    const request = openApiRequest(document(), Array.from({ length: 1500 }, (_, index) => index));
    const result = await readPoppyApi(company(), 0, "catalog", {}, { request, headers: headers() });
    expect("data" in result && result.data).toHaveLength(1500);
    expect(result).not.toHaveProperty("truncated");
  });
});
