import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/client";
import { readMcp } from "../server/poppy/apis.js";

const url = "https://catalog.example/mcp";
const search: Tool = {
  name: "search", description: "Search the public catalog",
  inputSchema: { type: "object", properties: { query: { type: "string", pattern: "^[a-z]+$" } }, required: ["query"], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false },
};

// The real SDK connects to this HTTP fixture; assertions cover Bell's app policy.
function fixture(pages: Tool[][] = [[search]], data: unknown = { items: ["milk"] }) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push(body.method);
    if (body.method === "notifications/initialized" || body.method === "notifications/cancelled") return new Response(null, { status: 202 });
    if (body.method === "server/discover") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
    let result: unknown;
    if (body.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "test-catalog", version: "1" } };
    if (body.method === "tools/list") {
      const page = Number(body.params?.cursor ?? 0);
      result = { tools: pages[page], ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}) };
    }
    if (body.method === "tools/call") result = { content: [], structuredContent: data };
    if (!result) throw new Error("Unexpected fixture request");
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
  return { fetch, calls };
}

describe("Bell's MCP adapter", () => {
  it("lists only unambiguous explicitly read-only tools across SDK pagination", async () => {
    const http = fixture([[search, { ...search, name: "write", annotations: {} }, { ...search, name: "duplicate" }], [
      { ...search, name: "delete", annotations: { readOnlyHint: true, destructiveHint: true } },
      { ...search, name: "duplicate", annotations: {} }, { ...search, name: "details" },
    ]]);
    const result = await readMcp({ url, fetch: http.fetch });
    expect("operations" in result && result.operations.map((tool) => tool.id)).toEqual(["search", "details"]);
    expect(http.calls).not.toContain("tools/call");
  });

  it("preserves token-related business fields without guessing tool permissions from names", async () => {
    const tokenize: Tool = {
      ...search, name: "tokenize_text",
      inputSchema: { type: "object", properties: { continuation_token: { type: "string" } }, required: ["continuation_token"], additionalProperties: false },
    };
    const data = { continuation_token: "page-two", token_count: 12, secret: "a book title" };
    const http = fixture([[tokenize]], data);
    const catalog = await readMcp({ url, fetch: http.fetch });
    expect(catalog).toMatchObject({ operations: [{ id: "tokenize_text", parameters: tokenize.inputSchema }] });
    expect(await readMcp({ url, fetch: http.fetch, operation: "tokenize_text", parameters: { continuation_token: "page-one" } })).toMatchObject({ data });
    expect(http.calls.filter(method => method === "tools/call")).toHaveLength(1);
  });

  it("rejects exact known credentials in argument values and keys, including JSON escapes", async () => {
    const secret = 'known-"quoted"-value\\with-newline\n';
    const tool: Tool = { ...search, inputSchema: { type: "object", additionalProperties: true } };
    for (const parameters of [{ nested: { value: secret } }, { [secret]: "value" }]) {
      const http = fixture([[tool]]);
      expect(await readMcp({ url, fetch: http.fetch, operation: "search", parameters, secrets: [secret] })).toMatchObject({ error: "invalid_parameters" });
      expect(http.calls).not.toContain("tools/call");
    }
  });

  it("rejects write operations and invalid arguments before calling a tool", async () => {
    for (const [operation, parameters] of [["delete", {}], ["search", { query: "INVALID" }], ["search", { query: "milk", access_token: "private" }]] as const) {
      const http = fixture([[search, { ...search, name: "delete", annotations: { destructiveHint: true } }]]);
      expect(await readMcp({ url, fetch: http.fetch, operation, parameters })).toMatchObject({ error: "invalid_parameters" });
      expect(http.calls).not.toContain("tools/call");
    }
  });

  it("redacts only known credentials across result data, keys, embedded JSON, and metadata", async () => {
    const secret = "known-private-value";
    const escapedSecret = 'known-"quoted"-value\\with-newline\n';
    const proof = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl";
    const resource = `${url}?echo=${secret}`;
    const operation = `search_${secret}`;
    const tool = { ...search, name: operation, description: `Example ${secret}` };
    const data = {
      items: ["milk"], access_token: secret, keyed: { [secret]: { [escapedSecret]: "result" } },
      nested: JSON.stringify({ credential: escapedSecret, [secret]: "result" }),
      account: { pin: "123456", password: "unknown-provider-value" }, proof,
      reflectedDuringCall: "new-private-value",
    };
    const http = fixture([[tool]], data);
    const secrets = [secret, escapedSecret];
    const catalog = await readMcp({ url: resource, fetch: http.fetch, secrets });
    expect(catalog).toMatchObject({ resource: `${url}?echo=[redacted]`, operations: [{ id: "search_[redacted]", description: "Example [redacted]" }] });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (JSON.parse(String(init?.body ?? "{}")).method === "tools/call") secrets.push("new-private-value");
      return http.fetch(input, init);
    };
    const result = await readMcp({ url: resource, fetch, operation, parameters: { query: "milk" }, secrets });
    expect(result).toMatchObject({ resource: `${url}?echo=[redacted]`, operation: "search_[redacted]", data: {
      items: ["milk"], access_token: "[redacted]", keyed: { "[redacted]": { "[redacted]": "result" } },
      nested: JSON.stringify({ credential: "[redacted]", "[redacted]": "result" }),
      account: data.account, proof, reflectedDuringCall: "[redacted]",
    } });
    for (const value of secrets) expect(JSON.stringify(result)).not.toContain(JSON.stringify(value).slice(1, -1));
    expect(http.calls.filter(method => method === "tools/call")).toHaveLength(1);
  });

  it("bounds the catalog and labels truncated output", async () => {
    const listing = fixture([Array.from({ length: 101 }, (_, i) => ({ ...search, name: `search_${i}` }))]);
    const catalog = await readMcp({ url, fetch: listing.fetch });
    expect("operations" in catalog && catalog.operations.length).toBeLessThanOrEqual(100);
    expect(catalog).toMatchObject({ truncated: true });
    const http = fixture(undefined, { message: "雪".repeat(30_000) });
    const result = await readMcp({ url, fetch: http.fetch, operation: "search", parameters: { query: "milk" } });
    expect(result).toMatchObject({ truncated: true, data: { preview: expect.any(String) } });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32 * 1024);
  });

  it("does not expose transport failure bodies to the model", async () => {
    const fetch: typeof globalThis.fetch = async () => new Response("private provider credential", { status: 401 });
    const result = await readMcp({ url, fetch });
    expect(result).toMatchObject({ error: "auth_required" });
    expect(JSON.stringify(result)).not.toContain("private provider credential");
  });
});
