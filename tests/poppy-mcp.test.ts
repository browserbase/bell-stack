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

  it("excludes credential getters and tools requesting model-supplied credentials", async () => {
    const protectedTools = ["claim_token", "capability", "sessionToken"].map((field, index) => ({
      ...search, name: `lookup_${index}`, inputSchema: { type: "object" as const, properties: { [field]: { type: "string" } } },
    }));
    const credentialGetters = ["get_passcode", "get_one_time_code", "get_otp"].map((name) => ({
      ...search, name, inputSchema: { type: "object" as const, properties: {} },
    }));
    const http = fixture([[search, ...protectedTools, ...credentialGetters]]);
    const catalog = await readMcp({ url, fetch: http.fetch });
    expect("operations" in catalog && catalog.operations.map((tool) => tool.id)).toEqual(["search"]);
    for (const operation of ["lookup_0", ...credentialGetters.map(tool => tool.name)]) {
      expect(await readMcp({ url, fetch: http.fetch, operation, parameters: {} })).toMatchObject({ error: "invalid_parameters" });
    }
    expect(http.calls).not.toContain("tools/call");
  });

  it("rejects write operations and invalid arguments before calling a tool", async () => {
    for (const [operation, parameters] of [["delete", {}], ["search", { query: "INVALID" }], ["search", { query: "milk", access_token: "private" }]] as const) {
      const http = fixture([[search, { ...search, name: "delete", annotations: { destructiveHint: true } }]]);
      expect(await readMcp({ url, fetch: http.fetch, operation, parameters })).toMatchObject({ error: "invalid_parameters" });
      expect(http.calls).not.toContain("tools/call");
    }
  });

  it("executes an allowed read with SDK input validation and redacts provider output", async () => {
    const proof = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl";
    const http = fixture(undefined, {
      items: ["milk"], access_token: "private-token", message: "known-private-value",
      keyed: { "known-private-value": { [proof]: "visible result" } },
      account: { passcode: "private-passcode", one_time_code: "private-one-time-code", otp: "private-otp" },
      nested: JSON.stringify({ refresh_token: "private-refresh", account: { passcode: "private-passcode" }, proof, [proof]: { "known-private-value": "visible result" } }),
    });
    const result = await readMcp({ url, fetch: http.fetch, operation: "search", parameters: { query: "milk" }, secrets: ["known-private-value"] });
    expect(result).toMatchObject({ resource: url, operation: "search", data: { items: ["milk"], access_token: "[redacted]", message: "[redacted]" } });
    expect(result).toMatchObject({ data: { keyed: { "[redacted]": { "[redacted JWT]": "visible result" } } } });
    expect(result).toMatchObject({ data: { account: { passcode: "[redacted]", one_time_code: "[redacted]", otp: "[redacted]" } } });
    expect(JSON.stringify(result)).not.toMatch(/private-token|private-refresh|private-passcode|private-one-time-code|private-otp|known-private-value|eyJ/);
    expect(http.calls.filter((method) => method === "tools/call")).toHaveLength(1);
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
