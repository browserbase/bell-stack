import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverPoppy } from "../server/poppy/discovery";
import { isPublicPoppyAddress, publicPoppyUrl, requestPoppy } from "../server/poppy/http";

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("node:https", () => ({ request: network.request }));

const origin = "https://shop.example.com", issuer = "https://auth.example.com/tenant";
const manifestUrl = origin + "/.well-known/poppy.json";
const resourceUrl = origin + "/.well-known/oauth-protected-resource";
const metadataUrl = "https://auth.example.com/.well-known/oauth-authorization-server/tenant";
const document = () => ({
  protocol_version: "0.4", organization: { name: "Example shop", domain: "shop.example.com" },
  apis: [{ type: "openapi", url: origin + "/openapi.json" }],
  auth: { scopes: { "orders:read": "Read orders" }, scope_hints: { "orders:read": { changes: "none", personal_data: true } } },
});
const resource = () => ({ resource: origin, authorization_servers: [issuer], scopes_supported: ["orders:read"] });
const metadata = () => ({
  issuer, protected_resources: [origin], token_endpoint: issuer + "/token", revocation_endpoint: issuer + "/revoke",
  device_authorization_endpoint: issuer + "/device", grant_types_supported: ["refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
  scopes_supported: ["profile"],
});
function fixture(overrides: Record<string, { body?: unknown; status?: number; finalUrl?: string }> = {}) {
  const bodies: Record<string, unknown> = { [manifestUrl]: document(), [resourceUrl]: resource(), [metadataUrl]: metadata() };
  return vi.fn<typeof requestPoppy>(async url => {
    const override = overrides[url];
    return { status: override?.status ?? 200, headers: new Headers(), text: JSON.stringify(override?.body ?? bodies[url]), url: override?.finalUrl ?? url };
  });
}

beforeEach(() => { network.lookup.mockReset(); network.request.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Poppy company discovery", () => {
  it("discovers a path-based issuer, requires its backlink, and retains scopes and account access", async () => {
    const request = fixture();
    const company = await discoverPoppy(origin + "/product/42?campaign=test", undefined, request);
    expect(company).toMatchObject({ version: "0.4", domain: "shop.example.com", origin, identifier: issuer, manifestUrl,
      oauth: { issuer, scopes_supported: ["orders:read", "profile"] }, authDisabled: false,
      scopes: { "orders:read": "Read orders" }, scopeHints: { "orders:read": { changes: "none", personal_data: true } } });
    expect(request.mock.calls.map(([url]) => url)).toEqual([manifestUrl, resourceUrl, metadataUrl]);
    expect(request.mock.calls[0][1]).toMatchObject({ discoveryRedirects: true });
    expect(request.mock.calls.slice(1).every(([, options]) => !options?.discoveryRedirects)).toBe(true);
  });

  it.each(["0.3", "0.4", "1.0", "1.2"])("supports the common discovery/API subset for version %s", async version => {
    const company = await discoverPoppy(origin, undefined, fixture({ [manifestUrl]: { body: { ...document(), protocol_version: version } } }));
    expect(company.version).toBe(version);
  });

  it("uses the final host after canonical-domain redirects", async () => {
    const request = fixture();
    request.mockImplementationOnce(async () => ({ status: 200, headers: new Headers(), text: JSON.stringify(document()), url: manifestUrl }));
    expect((await discoverPoppy("https://www.example.com", undefined, request)).origin).toBe(origin);
    expect(request.mock.calls[1][0]).toBe(resourceUrl);
  });

  it.each([origin + "/uploads/poppy.json", manifestUrl + "?v=1"])("rejects a discovery response served at %s", async finalUrl => {
    const request = fixture({ [manifestUrl]: { finalUrl } });
    await expect(discoverPoppy(origin, undefined, request)).rejects.toThrow("well-known path");
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a copied manifest claiming another domain before contacting its issuer", async () => {
    const request = fixture({ [manifestUrl]: { body: { ...document(), organization: { name: "Copied", domain: "victim.example.com" } } } });
    await expect(discoverPoppy(origin, undefined, request)).rejects.toThrow("domain does not match");
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([404, 200])("accepts explicit absence of an issuer (HTTP %i) for signed-out APIs", async status => {
    const request = fixture({ [resourceUrl]: { status, body: { resource: origin } } });
    expect(await discoverPoppy(origin, undefined, request)).toMatchObject({ identifier: origin, authDisabled: true, oauth: undefined });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 429, 500, 503])("does not turn HTTP %i into a signed-out identity", async status => {
    await expect(discoverPoppy(origin, undefined, fixture({ [resourceUrl]: { status } }))).rejects.toThrow(`HTTP ${status}`);
  });

  it.each([
    { resource: origin + "/" }, { resource: "https://victim.example.com", authorization_servers: [] },
    { resource: origin, authorization_servers: "invalid" }, { malformed: true },
  ])("rejects invalid protected-resource metadata without domain fallback", async body => {
    await expect(discoverPoppy(origin, undefined, fixture({ [resourceUrl]: { body } }))).rejects.toThrow(/protected resource/);
  });

  it("requires manifest selection when several issuers serve a resource", async () => {
    const servers = { ...resource(), authorization_servers: [issuer, "https://staff.example.com"] };
    await expect(discoverPoppy(origin, undefined, fixture({ [resourceUrl]: { body: servers } }))).rejects.toThrow("chosen issuer");
    const request = fixture({ [resourceUrl]: { body: servers }, [manifestUrl]: { body: { ...document(), auth: { issuer } } } });
    expect((await discoverPoppy(origin, undefined, request)).identifier).toBe(issuer);
  });

  it("rejects an explicitly claimed issuer when the resource has none", async () => {
    await expect(discoverPoppy(origin, undefined, fixture({
      [manifestUrl]: { body: { ...document(), auth: { issuer } } }, [resourceUrl]: { status: 404 },
    }))).rejects.toThrow("without protected resource metadata");
  });

  it.each([
    { issuer: issuer + "/" }, { protected_resources: [origin + "/"] }, { protected_resources: ["https://victim.example.com"] },
    { token_endpoint: "http://auth.example.com/token" }, { revocation_endpoint: "https://127.0.0.1/revoke" },
    { grant_types_supported: ["authorization_code"] }, { device_authorization_endpoint: null },
  ])("rejects an unverified or unusable authorization server", async override => {
    await expect(discoverPoppy(origin, undefined, fixture({ [metadataUrl]: { body: { ...metadata(), ...override } } }))).rejects.toThrow(/issuer|authorization server/);
  });

  it("compares domain case only while preserving exact issuer identity", async () => {
    const request = fixture({ [manifestUrl]: { body: { ...document(), organization: { name: "Example", domain: "SHOP.EXAMPLE.COM" } } },
      [metadataUrl]: { body: { ...metadata(), protected_resources: ["https://SHOP.EXAMPLE.COM"] } } });
    expect((await discoverPoppy(origin, undefined, request)).identifier).toBe(issuer);
  });

  it("retains a disabled issuer as identity and treats unknown scope effects conservatively", async () => {
    const request = fixture({ [manifestUrl]: { body: { ...document(), auth: { disabled: true, scope_hints: { custom: { changes: "future_value", personal_data: false } } } } } });
    expect(await discoverPoppy(origin, undefined, request)).toMatchObject({ identifier: issuer, authDisabled: true, scopeHints: { custom: { changes: "irreversible" } } });
  });

  it.each([
    { apis: [] }, { apis: [], web: { disabled: true } }, { apis: [{ type: "openapi", url: "http://example.com/openapi.json" }] },
    { apis: [], agent: { protocols: [] } }, { auth: { scope_hints: { read: { changes: "none" } } } },
  ])("does not invent usable capabilities for invalid declarations", async override => {
    await expect(discoverPoppy(origin, undefined, fixture({ [manifestUrl]: { body: { ...document(), ...override } } }))).rejects.toThrow("invalid manifest");
  });

  it("negotiates the newest compatible version and prohibits redirects for its document", async () => {
    const alternate = origin + "/poppy/1.json";
    const request = fixture({
      [manifestUrl]: { body: { ...document(), supported_versions: { "0.3": origin + "/poppy/03.json", "1.0": alternate } } },
      [alternate]: { body: { ...document(), protocol_version: "1.0" } },
    });
    expect(await discoverPoppy(origin, undefined, request)).toMatchObject({ version: "1.0", manifestUrl: alternate });
    expect(request.mock.calls[1]).toEqual([alternate, { signal: undefined }]);
  });

  it.each([
    { alternate: "https://other.example.com/poppy.json", body: { ...document(), protocol_version: "1.0" } },
    { alternate: origin + "/poppy/1.json", body: document() },
    { alternate: origin + "/poppy/1.json", body: { ...document(), protocol_version: "1.0", supported_versions: {} } },
  ])("rejects a misleading version advertisement", async ({ alternate, body }) => {
    const request = fixture({ [manifestUrl]: { body: { ...document(), supported_versions: { "1.0": alternate } } }, [alternate]: { body } });
    await expect(discoverPoppy(origin, undefined, request)).rejects.toThrow(/version document/);
  });

  it("rejects a redirected version document and incompatible major version", async () => {
    const alternate = origin + "/poppy/1.json";
    await expect(discoverPoppy(origin, undefined, fixture({
      [manifestUrl]: { body: { ...document(), supported_versions: { "1.0": alternate } } },
      [alternate]: { status: 302 },
    }))).rejects.toThrow("HTTP 302");
    await expect(discoverPoppy(origin, undefined, fixture({ [manifestUrl]: { body: { ...document(), protocol_version: "2.0" } } }))).rejects.toThrow("unsupported");
  });
});

describe("Poppy public HTTPS transport", () => {
  it.each(["127.0.0.1", "0.0.0.0", "10.2.3.4", "100.64.0.1", "169.254.169.254", "172.31.255.255", "192.168.0.1", "192.0.2.1", "198.18.0.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "3fff::1"])("blocks nonpublic address %s", address => {
    expect(isPublicPoppyAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("accepts public address %s", address => expect(isPublicPoppyAddress(address)).toBe(true));
  it.each(["http://example.com", "file:///etc/passwd", "https://localhost", "https://service.internal", "https://0x7f000001", "https://2130706433", "https://[::ffff:127.0.0.1]", "https://user:secret@example.com", "https://example.com:8443", "https://example.com/#secret"])("rejects unsafe URL %s without a network request", async url => {
    expect(() => publicPoppyUrl(url)).toThrow("public HTTPS");
    await expect(requestPoppy(url)).rejects.toThrow("public HTTPS");
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.request).not.toHaveBeenCalled();
  });

  it.each([{ addresses: [{ address: "10.0.0.1", family: 4 }] }, { addresses: [{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }] }])("rejects private DNS results before opening a socket", async ({ addresses }) => {
    network.lookup.mockResolvedValue(addresses);
    await expect(requestPoppy(origin)).rejects.toThrow("destination is not public");
    expect(network.request).not.toHaveBeenCalled();
  });

  function wire(replies: Array<{ status?: number; headers?: Record<string, string>; chunks?: Buffer[]; error?: string; keepOpen?: boolean }>) {
    const sockets: Array<EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> = [];
    network.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    network.request.mockImplementation((_url, _options, callback) => {
      const socket = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
      sockets.push(socket);
      const reply = replies.shift() ?? {};
      socket.end.mockImplementation(() => {
        queueMicrotask(() => {
          if (reply.error) { socket.emit("error", new Error(reply.error)); return; }
          const response = Object.assign(new EventEmitter(), { statusCode: reply.status ?? 200, headers: reply.headers ?? {}, destroy: vi.fn() });
          callback(response);
          for (const chunk of reply.chunks ?? [Buffer.from("{}")]) response.emit("data", chunk);
          if (!reply.keepOpen) response.emit("end");
        });
      });
      return socket;
    });
    return sockets;
  }

  it("pins the checked DNS address into the socket lookup to prevent rebinding", async () => {
    wire([{}]);
    await requestPoppy(origin);
    const options = network.request.mock.calls[0][1];
    const callback = vi.fn();
    options.lookup("shop.example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(options.agent).toBe(false);
    expect(network.lookup).toHaveBeenCalledOnce();
  });

  it("follows public HTTPS discovery redirects but never credential-bearing requests", async () => {
    wire([{ status: 302, headers: { location: manifestUrl } }, {}]);
    expect((await requestPoppy("https://www.example.com/.well-known/poppy.json", { discoveryRedirects: true })).url).toBe(manifestUrl);
    expect(network.request).toHaveBeenCalledTimes(2);
    await expect(requestPoppy(origin, { discoveryRedirects: true, headers: { Authorization: "Bearer secret" } })).rejects.toThrow("credential-free GET");
    await expect(requestPoppy(origin, { discoveryRedirects: true, method: "POST", body: "secret" })).rejects.toThrow("credential-free GET");
    expect(network.request).toHaveBeenCalledTimes(2);
  });

  it("does not forward tokens on redirects from resource endpoints", async () => {
    wire([{ status: 307, headers: { location: "https://attacker.example.com" } }]);
    expect((await requestPoppy(origin, { headers: { Authorization: "Bearer secret" } })).status).toBe(307);
    expect(network.request).toHaveBeenCalledOnce();
  });

  it.each(["http://example.com", "https://127.0.0.1", "https://[::ffff:169.254.169.254]"])("blocks a discovery redirect to %s", async location => {
    wire([{ status: 302, headers: { location } }]);
    await expect(requestPoppy(origin, { discoveryRedirects: true })).rejects.toThrow("redirect is not a public HTTPS");
    expect(network.request).toHaveBeenCalledOnce();
  });

  it("bounds redirect chains", async () => {
    wire(Array(5).fill({ status: 302, headers: { location: manifestUrl } }));
    await expect(requestPoppy(origin, { discoveryRedirects: true })).rejects.toThrow("redirect failed");
    expect(network.request).toHaveBeenCalledTimes(4);
  });

  it.each([true, false])("bounds response bytes with or without content-length (%s)", async length => {
    const sockets = wire([{ headers: length ? { "content-length": "1048577" } : {}, chunks: [Buffer.alloc(1048576), Buffer.from("x")] }]);
    await expect(requestPoppy(origin)).rejects.toThrow("1 MiB limit");
    expect(sockets[0].destroy).toHaveBeenCalled();
  });

  it("finishes an SSE response once its matching reply arrives even if the stream stays open", async () => {
    const sockets = wire([{ headers: { "content-type": "text/event-stream" }, chunks: [Buffer.from('data: {"jsonrpc":"2.0","id":"a","result":{}}\n\n')], keepOpen: true }]);
    const result = await requestPoppy(origin, { until: (text, headers) => headers.get("content-type") === "text/event-stream" && text.includes('"id":"a"') && text.endsWith("\n\n") });
    expect(result.text).toContain('"result":{}');
    expect(sockets[0].destroy).toHaveBeenCalledOnce();
  });

  it("sanitizes synchronous socket errors before they can reveal header values", async () => {
    network.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    network.request.mockImplementation(() => { throw new Error("secret Authorization value"); });
    await expect(requestPoppy(origin)).rejects.toThrow(/^Poppy request failed\.$/);
  });

  it("honors numeric Retry-After before DNS, shares it across query variants, and expires it", async () => {
    let now = Date.parse("2040-11-12T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    wire([{ status: 429, headers: { "retry-after": "60" } }, {}]);
    const endpoint = origin + "/limited/search";
    expect((await requestPoppy(endpoint + "?q=first")).status).toBe(429);
    now += 500;
    await expect(requestPoppy(endpoint + "?q=second")).rejects.toMatchObject({ name: "PoppyRateLimitError", retryAfterSeconds: 60 });
    expect(network.lookup).toHaveBeenCalledOnce();
    expect(network.request).toHaveBeenCalledOnce();
    now += 59_500;
    expect((await requestPoppy(endpoint)).status).toBe(200);
    expect(network.request).toHaveBeenCalledTimes(2);
  });

  it.each(["Mon, 12 Nov 2040 12:02:00 GMT", "Monday, 12-Nov-40 12:02:00 GMT", "Mon Nov 12 12:02:00 2040"])("honors HTTP-date Retry-After %s", async date => {
    const now = Date.parse("2040-11-12T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    wire([{ status: 429, headers: { "retry-after": date } }]);
    const endpoint = origin + "/limited/date-" + encodeURIComponent(date);
    await requestPoppy(endpoint);
    await expect(requestPoppy(endpoint)).rejects.toMatchObject({ retryAfterSeconds: 120 });
    expect(network.request).toHaveBeenCalledOnce();
  });

  it("keeps rate limits local to the endpoint and HTTP method", async () => {
    wire([{ status: 429, headers: { "retry-after": "60" } }, {}, {}, {}]);
    await requestPoppy(origin + "/limited/orders", { method: "POST" });
    expect((await requestPoppy(origin + "/limited/orders", { method: "GET" })).status).toBe(200);
    expect((await requestPoppy(origin + "/limited/catalog", { method: "POST" })).status).toBe(200);
    expect((await requestPoppy("https://other.example.com/limited/orders", { method: "POST" })).status).toBe(200);
    await expect(requestPoppy(origin + "/limited/orders", { method: "POST" })).rejects.toThrow("rate limited");
    expect(network.request).toHaveBeenCalledTimes(4);
  });

  it.each(["nonsense-secret", "-1", "1.5", "November 2099", "Mon, 01 Jan 2001 00:00:00 GMT", "0"])("ignores malformed or expired Retry-After %s without exposing it", async value => {
    wire([{ status: 429, headers: { "retry-after": value } }, {}]);
    const endpoint = origin + "/limited/invalid-" + encodeURIComponent(value);
    await requestPoppy(endpoint);
    expect((await requestPoppy(endpoint)).status).toBe(200);
    expect(network.request).toHaveBeenCalledTimes(2);
  });

  it("remembers a rate limit even when the response body exceeds its limit", async () => {
    wire([{ status: 429, headers: { "retry-after": "60", "content-length": "1048577" } }]);
    const endpoint = origin + "/limited/oversized";
    await expect(requestPoppy(endpoint)).rejects.toThrow("1 MiB limit");
    await expect(requestPoppy(endpoint)).rejects.toThrow(/^Poppy endpoint is rate limited\. Retry in 60 seconds\.$/);
    expect(network.request).toHaveBeenCalledOnce();
  });

  it("preserves UTF-8 characters split across network chunks", async () => {
    const data = Buffer.from('{"value":"東京 café"}');
    wire([{ chunks: [...data].map(byte => Buffer.from([byte])) }]);
    expect((await requestPoppy(origin)).text).toBe(data.toString("utf8"));
  });

  it("sanitizes transport errors and cancellation reasons", async () => {
    wire([{ error: "private-token secret-request-body" }]);
    await expect(requestPoppy(origin)).rejects.toThrow(/^Poppy request failed\.$/);
    const canceled = AbortSignal.abort(new Error("secret cancellation reason"));
    await expect(requestPoppy(origin, { signal: canceled })).rejects.toMatchObject({ name: "AbortError", message: "Poppy request interrupted." });
    expect(network.request).toHaveBeenCalledOnce();
  });

  it("aborts stalled DNS resolution at the request deadline", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    network.lookup.mockReturnValue(new Promise(() => {}));
    const pending = requestPoppy(origin);
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError", message: "Poppy request interrupted." });
    deadline.abort(new DOMException("private timeout context", "TimeoutError"));
    await rejected;
    expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000);
    expect(network.request).not.toHaveBeenCalled();
  });
});
