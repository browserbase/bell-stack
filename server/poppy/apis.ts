import { randomUUID } from "node:crypto";
import type { PoppyCompany } from "./discovery.js";
import { PoppyRateLimitError, poppyRetryAfterSeconds, requestPoppy } from "./http.js";

type JsonObject = Record<string, unknown>;
type Request = typeof requestPoppy;
type Reply = Awaited<ReturnType<Request>>;
type ProofHeaders = (method: string, url: string) => Record<string, string>;

export type PoppyApiFailure = {
  error: "auth_required" | "insufficient_scope" | "api_error" | "unsupported_api" | "invalid_parameters" | "session_ended" | "version_unsupported" | "invalid_session" | "rate_limited";
  message: string;
  scopes?: string[];
  retryAfterSeconds?: number;
};
export type PoppyApiOperation = {
  id: string;
  description?: string;
  parameters: JsonObject;
  scopes: string[];
  scopeAlternatives?: string[][];
  requiresAccount?: boolean;
};
export type PoppyApiDescription = {
  type: "openapi" | "mcp";
  resource: string;
  operations: PoppyApiOperation[];
  truncated?: boolean;
};
export type PoppyApiResult = {
  data: unknown;
  resource: string;
  operation: string;
  truncated?: boolean;
};
export type PoppyApiContext = {
  headers: ProofHeaders;
  signal?: AbortSignal;
  request?: Request;
  expectedResource?: string;
};

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_OPERATIONS = 100;
const MODERN = "2026-07-28";
const LEGACY = ["2025-11-25", "2025-06-18"];
const CLIENT = { name: "bell", version: "0.1.0" };
const AUTH_NAME = /(?:authorization|cookie|password|secret|credential|assertion|private.?key|access.?token|refresh.?token|id.?token|session.?token|client.?secret|api.?key|poppy.?session|dpop)/i;
const UNSAFE_KEY = /^(?:__proto__|prototype|constructor)$/;

class ApiError extends Error {
  constructor(readonly failure: PoppyApiFailure) {
    super(failure.message);
  }
}
function fail(error: PoppyApiFailure["error"], message: string): never {
  throw new ApiError({ error, message });
}
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requireObject(value: unknown): JsonObject {
  if (!object(value)) fail("unsupported_api", "The API document has an unsupported structure.");
  return value;
}
function https(value: string, base?: string): URL {
  if (/[\\\u0000-\u0020\u007f]/.test(value)) fail("unsupported_api", "The API contains an unsafe URL.");
  const url = new URL(value, base);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    fail("unsupported_api", "The API requires an HTTPS URL without credentials or a fragment.");
  }
  return url;
}
function apiAt(company: PoppyCompany, index: number) {
  if (!Number.isInteger(index) || index < 0 || !company.apis[index]) {
    fail("invalid_parameters", "Choose an API from the discovered company.");
  }
  const api = company.apis[index];
  https(api.url);
  return api;
}
function json(text: string): unknown {
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) fail("api_error", "The API response exceeds the size limit.");
  try { return JSON.parse(text) as unknown; }
  catch { return undefined; }
}
function challenge(reply: Reply): PoppyApiFailure | undefined {
  if (reply.status !== 401 && reply.status !== 403) return;
  const header = reply.headers.get("www-authenticate") ?? "";
  const insufficient = /\berror\s*=\s*"?insufficient_scope\b/i.test(header);
  const scopeText = /\bscope\s*=\s*"([^"]*)"/i.exec(header)?.[1] ?? "";
  const scopes = scopeText.split(/\s+/).filter((s) => /^[A-Za-z0-9:_./-]{1,128}$/.test(s)).slice(0, 20);
  return {
    error: insufficient ? "insufficient_scope" : "auth_required",
    message: insufficient ? "This read requires additional account permission." : "This API requires account access or an accepted agent identity.",
    ...(scopes.length ? { scopes } : {}),
  };
}
function rateLimited(retryAfterSeconds?: number): PoppyApiFailure {
  return {
    error: "rate_limited", message: "This endpoint is rate limited. Wait before retrying.",
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}
function checkReply(reply: Reply, expectedUrl: string): void {
  if (reply.status >= 300 && reply.status < 400 || reply.url !== expectedUrl) {
    fail("api_error", "API redirects are not supported.");
  }
  if (reply.status === 429) throw new ApiError(rateLimited(poppyRetryAfterSeconds(reply.headers)));
  const auth = challenge(reply);
  if (auth) throw new ApiError(auth);
  if (reply.status === 400) {
    const body = json(reply.text);
    if (object(body)) {
      if (body.error === "session_ended") fail("session_ended", "The company ended this agent session.");
      if (body.error === "version_unsupported") fail("version_unsupported", "The company no longer supports this Poppy version.");
      if (body.error === "invalid_session") fail("invalid_session", "The company did not accept this agent session.");
    }
  }
}
async function send(
  request: Request, url: string, options: Parameters<Request>[1],
): Promise<Reply> {
  const reply = await request(url, options);
  checkReply(reply, url);
  if (Buffer.byteLength(reply.text) > MAX_DOCUMENT_BYTES) fail("api_error", "The API response exceeds the size limit.");
  return reply;
}

// A deliberately bounded JSON Schema subset. Unknown constraints fail closed instead
// of silently weakening argument validation. References are resolved only in OpenAPI.
const SCHEMA_KEYS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const",
  "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "nullable",
  "description", "title", "default", "examples", "example", "$schema", "format",
  "readOnly", "writeOnly", "deprecated", "x-mcp-header",
]);
function schemaSupported(schema: unknown, depth = 0): schema is JsonObject {
  if (!object(schema) || depth > 8 || Object.keys(schema).some((k) => !SCHEMA_KEYS.has(k))) return false;
  if (!["object", "array", "string", "integer", "number", "boolean", "null"].includes(String(schema.type))) return false;
  if (schema.writeOnly === true) return false;
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isSafeInteger(schema[key]) || schema[key] < 0)) return false;
  }
  for (const key of ["minimum", "maximum"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) return false;
  }
  for (const [min, max] of [["minLength", "maxLength"], ["minItems", "maxItems"], ["minimum", "maximum"]]) {
    if (typeof schema[min] === "number" && typeof schema[max] === "number" && schema[min] > schema[max]) return false;
  }
  if (schema.format !== undefined && !["date", "date-time", "uuid", "uri", "email", "int32", "int64", "float", "double"].includes(String(schema.format))) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length > 100 || schema.enum.some(object))) return false;
  if (schema.type === "object") {
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return false;
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((k) => typeof k === "string"))) return false;
    const properties = schema.properties ?? {};
    if (!object(properties) || Object.keys(properties).length > 100) return false;
    if (Object.entries(properties).some(([k, v]) => UNSAFE_KEY.test(k) || AUTH_NAME.test(k) || !schemaSupported(v, depth + 1))) return false;
    if (Array.isArray(schema.required) && schema.required.some((k) => !Object.hasOwn(properties, String(k)))) return false;
  }
  if (schema.type === "array" && !schemaSupported(schema.items, depth + 1)) return false;
  return true;
}
function validArguments(value: unknown, schema: JsonObject, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null && schema.nullable === true) return true;
  if (schema.enum !== undefined && !(schema.enum as unknown[]).some((x) => x === value)) return false;
  if (schema.const !== undefined && schema.const !== value) return false;
  switch (schema.type) {
    case "object": {
      if (!object(value)) return false;
      const properties = (schema.properties ?? {}) as JsonObject;
      if (Object.keys(value).some((k) => !Object.hasOwn(properties, k) || UNSAFE_KEY.test(k) || AUTH_NAME.test(k))) return false;
      if ((schema.required as string[] | undefined)?.some((k) => !Object.hasOwn(value, k))) return false;
      return Object.entries(value).every(([k, v]) => validArguments(v, properties[k] as JsonObject, depth + 1));
    }
    case "array":
      return Array.isArray(value) && value.length <= Math.min(100, Number(schema.maxItems ?? 100)) && value.length >= Number(schema.minItems ?? 0) && value.every((v) => validArguments(v, schema.items as JsonObject, depth + 1));
    case "string":
      if (typeof value !== "string" || value.length > Math.min(8192, Number(schema.maxLength ?? 8192)) || value.length < Number(schema.minLength ?? 0) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return false;
      if (schema.format === "uuid" && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) return false;
      if (schema.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)))) return false;
      if (schema.format === "date-time" && (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) return false;
      if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
      if (schema.format === "uri") { try { new URL(value); } catch { return false; } }
      return true;
    case "integer":
    case "number":
      return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isSafeInteger(value)) && value >= Number(schema.minimum ?? -Infinity) && value <= Number(schema.maximum ?? Infinity);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}
function validateParameters(parameters: unknown, schema: JsonObject): asserts parameters is JsonObject {
  if (!schemaSupported(schema) || !validArguments(parameters, schema)) {
    fail("invalid_parameters", "Parameters must match the advertised read operation; unknown or credential parameters are not allowed.");
  }
}
function resolveLocal(value: unknown, document: JsonObject, seen = new Set<string>(), depth = 0): unknown {
  if (depth > 16) fail("unsupported_api", "The API schema is too deeply nested.");
  if (Array.isArray(value)) return value.map((v) => resolveLocal(v, document, seen, depth + 1));
  if (!object(value)) return value;
  if (Object.hasOwn(value, "$ref")) {
    const ref = value.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/components/") || seen.has(ref) || Object.keys(value).some((k) => !["$ref", "description", "summary"].includes(k))) {
      fail("unsupported_api", "Only nonrecursive local API schema references are supported.");
    }
    let target: unknown = document;
    for (const part of ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      if (!object(target) || UNSAFE_KEY.test(part) || !Object.hasOwn(target, part)) fail("unsupported_api", "The API schema reference is invalid.");
      target = target[part];
    }
    return resolveLocal(target, document, new Set([...seen, ref]), depth + 1);
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    if (UNSAFE_KEY.test(k)) fail("unsupported_api", "The API schema contains an unsafe member.");
    return [k, resolveLocal(v, document, seen, depth + 1)];
  }));
}

type OpenApiOperation = PoppyApiOperation & { path: string; parametersList: JsonObject[] };
type OpenApi = { resource: string; operations: OpenApiOperation[] };
function serverUrl(servers: unknown, documentUrl: string, fallback?: string): string {
  if (servers === undefined) return fallback ?? new URL(documentUrl).origin;
  if (!Array.isArray(servers) || !object(servers[0]) || typeof servers[0].url !== "string" || /[{}]/.test(servers[0].url)) {
    fail("unsupported_api", "Templated or invalid API servers are not supported.");
  }
  const url = https(servers[0].url, documentUrl);
  if (url.search) fail("unsupported_api", "API server URLs must not contain a query.");
  return url.href.replace(/\/$/, "");
}
function security(operation: JsonObject, document: JsonObject): Pick<PoppyApiOperation, "scopes" | "scopeAlternatives" | "requiresAccount"> {
  const requirements = operation.security ?? document.security ?? [];
  if (!Array.isArray(requirements)) fail("unsupported_api", "The API security requirements are invalid.");
  const alternatives: string[][] = [];
  const account: boolean[] = [];
  const schemes = object(document.components) && object(document.components.securitySchemes) ? document.components.securitySchemes : {};
  for (const requirement of requirements) {
    if (!object(requirement)) fail("unsupported_api", "The API security requirements are invalid.");
    const scopes: string[] = [];
    let needsAccount = false;
    for (const [name, values] of Object.entries(requirement)) {
      const scheme = requireObject(schemes[name]);
      if (!Array.isArray(values) || !values.every((s) => typeof s === "string" && /^[A-Za-z0-9:_./-]{1,128}$/.test(s))) fail("unsupported_api", "The API scopes are invalid.");
      if (scheme.type === "apiKey" && scheme.in === "header" && typeof scheme.name === "string" && scheme.name.toLowerCase() === "poppy-session") continue;
      if (scheme.type !== "oauth2" && scheme.type !== "openIdConnect" && !(scheme.type === "http" && scheme.scheme === "bearer")) fail("unsupported_api", "This API requires an unsupported authentication scheme.");
      needsAccount = true;
      scopes.push(...values as string[]);
    }
    alternatives.push([...new Set(scopes)]);
    account.push(needsAccount);
  }
  return { scopes: alternatives.length ? alternatives.reduce((a, b) => b.length < a.length ? b : a) : [], scopeAlternatives: alternatives, requiresAccount: account.length > 0 && account.every(Boolean) };
}
async function openApi(url: string, signal: AbortSignal | undefined, request: Request): Promise<OpenApi> {
  const reply = await send(request, url, { method: "GET", headers: { Accept: "application/json" }, signal });
  if (reply.status !== 200) fail("api_error", "The advertised API description is unavailable.");
  const document = requireObject(json(reply.text));
  if (typeof document.openapi !== "string" || !/^3\.[01]\.\d+$/.test(document.openapi)) fail("unsupported_api", "Only OpenAPI 3.0 and 3.1 JSON documents are supported.");
  const resource = serverUrl(document.servers, url);
  const operations: OpenApiOperation[] = [];
  const ids = new Set<string>();
  for (const [path, entry] of Object.entries(requireObject(document.paths))) {
    if (!object(entry) || !object(entry.get)) continue;
    try {
      if (!path.startsWith("/") || path.startsWith("//") || /[\\?#%\u0000-\u0020\u007f]/.test(path) || path.split("/").some((p) => p === "." || p === "..") || entry.$ref) continue;
      const op = entry.get;
      if (typeof op.operationId !== "string" || !op.operationId || op.operationId.length > 128 || op.requestBody) continue;
      const target = serverUrl(op.servers ?? entry.servers, url, resource);
      // Each description has one OAuth resource. Do not send that resource's token
      // to an operation whose server override selects a different resource.
      if (target !== resource) continue;
      const list: JsonObject[] = [];
      const merged = new Map<string, JsonObject>();
      for (const source of [entry.parameters ?? [], op.parameters ?? []]) {
        if (!Array.isArray(source)) fail("unsupported_api", "The API parameters are invalid.");
        for (const parameter of source) {
          const p = requireObject(resolveLocal(parameter, document));
          if (typeof p.name !== "string" || !p.name || p.name.length > 128 || AUTH_NAME.test(p.name) || UNSAFE_KEY.test(p.name) || !["path", "query"].includes(String(p.in)) || p.content || p.allowReserved === true || p.allowEmptyValue === true) fail("unsupported_api", "The API parameter location or encoding is unsupported.");
          if (p.style !== undefined && p.style !== (p.in === "path" ? "simple" : "form")) fail("unsupported_api", "The API parameter encoding is unsupported.");
          if (!schemaSupported(p.schema) || !["string", "number", "integer", "boolean"].includes(String(p.schema.type))) fail("unsupported_api", "Only scalar OpenAPI parameters are supported.");
          if (p.in === "path" && p.required !== true) fail("unsupported_api", "API path parameters must be required.");
          merged.set(`${p.in}:${p.name}`, p);
        }
      }
      const properties: JsonObject = {};
      const required: string[] = [];
      for (const p of merged.values()) {
        if (Object.hasOwn(properties, String(p.name))) fail("unsupported_api", "Parameter names must be unique across locations.");
        properties[String(p.name)] = p.schema;
        if (p.required === true) required.push(String(p.name));
        list.push(p);
      }
      const pathNames = [...path.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
      if (path.replace(/\{[^{}]+\}/g, "").match(/[{}]/) || pathNames.some((n) => !list.some((p) => p.in === "path" && p.name === n)) || list.some((p) => p.in === "path" && !pathNames.includes(String(p.name)))) continue;
      if (ids.has(op.operationId)) fail("unsupported_api", "The API contains ambiguous operation identifiers.");
      ids.add(op.operationId);
      operations.push({ id: op.operationId, description: String(op.summary ?? op.description ?? "").slice(0, 1500), parameters: { type: "object", properties, required, additionalProperties: false }, ...security(op, document), path, parametersList: list });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.message.includes("ambiguous")) throw error;
      // A rejected operation is never offered or callable; other independent GETs
      // in the document remain available.
    }
  }
  return { resource, operations };
}

function rpcReply(reply: Reply, id: string): JsonObject | undefined {
  const parse = (text: string) => {
    const value = json(text);
    return object(value) && value.jsonrpc === "2.0" && value.id === id ? value : undefined;
  };
  if (!(reply.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) return parse(reply.text);
  const events = reply.text.split(/\r?\n\r?\n/);
  // SSE dispatches only after a blank line. A complete JSON fragment in an
  // unfinished event is not yet a server response.
  events.pop();
  if (events.length > 1000) fail("api_error", "The MCP stream exceeds the event limit.");
  for (const event of events) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (data) { const result = parse(data); if (result) return result; }
  }
}
function encodedHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) && value.trim() === value && !/^=\?base64\?.*\?=$/.test(value)
    ? value : `=?base64?${Buffer.from(value).toString("base64")}?=`;
}
type McpSession = {
  url: string;
  version: string;
  sessionId?: string;
  context: PoppyApiContext;
};
async function rpc(session: McpSession, method: string, params: JsonObject = {}, notification = false, extraHeaders: Record<string, string> = {}) {
  const id = randomUUID();
  const modern = session.version === MODERN;
  const body = {
    jsonrpc: "2.0", ...(!notification ? { id } : {}), method,
    params: modern ? { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientInfo": CLIENT,
      "io.modelcontextprotocol/clientCapabilities": {},
    } } : params,
  };
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream", "Content-Type": "application/json",
    "MCP-Protocol-Version": session.version,
    ...(session.sessionId && !modern ? { "Mcp-Session-Id": session.sessionId } : {}),
    ...(modern ? { "Mcp-Method": method, ...(typeof params.name === "string" ? { "Mcp-Name": encodedHeader(params.name) } : {}) } : {}),
    ...extraHeaders,
    ...session.context.headers("POST", session.url),
  };
  const reply = await send(session.context.request ?? requestPoppy, session.url, { method: "POST", headers, body: JSON.stringify(body), signal: session.context.signal,
    ...(!notification ? { until: (text: string, responseHeaders: Headers) => Boolean(rpcReply({ status: 200, headers: responseHeaders, text, url: session.url }, id)) } : {}),
  });
  return { reply, message: notification ? undefined : rpcReply(reply, id) };
}
function rpcResult(result: Awaited<ReturnType<typeof rpc>>): JsonObject {
  if (result.reply.status < 200 || result.reply.status >= 300 || !result.message || object(result.message.error)) fail("api_error", "The MCP server could not complete this read.");
  const value = requireObject(result.message.result);
  if (value.resultType !== undefined && value.resultType !== "complete") fail("unsupported_api", "This MCP operation requires unsupported interactive input.");
  return value;
}
async function connectMcp(url: string, context: PoppyApiContext): Promise<McpSession> {
  const session: McpSession = { url, version: MODERN, context };
  const discovered = await rpc(session, "server/discover");
  const error = discovered.message?.error;
  if (discovered.reply.status === 200 && !error) {
    const result = rpcResult(discovered);
    if (!Array.isArray(result.supportedVersions) || !result.supportedVersions.includes(MODERN) || !object(result.capabilities)) fail("unsupported_api", "The MCP server does not advertise a supported protocol version.");
    return session;
  }
  let legacy = LEGACY[0];
  if (object(error) && error.code === -32022) {
    const versions = object(error.data) ? error.data.supported : undefined;
    legacy = LEGACY.find((v) => Array.isArray(versions) && versions.includes(v)) ?? "";
    if (!legacy) fail("unsupported_api", "The MCP server does not support a compatible protocol version.");
  } else if (!(discovered.reply.status === 400 || discovered.reply.status === 200 && object(error) && error.code === -32601) || object(error) && [-32020, -32021].includes(Number(error.code))) {
    fail("api_error", "The MCP server could not negotiate a read connection.");
  }
  session.version = legacy;
  const initialized = await rpc(session, "initialize", { protocolVersion: legacy, capabilities: {}, clientInfo: CLIENT });
  const result = rpcResult(initialized);
  if (!LEGACY.includes(String(result.protocolVersion)) || !object(result.capabilities) || !object(result.serverInfo)) fail("unsupported_api", "The MCP initialization response is incompatible.");
  session.version = String(result.protocolVersion);
  const sessionId = initialized.reply.headers.get("mcp-session-id");
  if (sessionId) {
    if (!/^[\x21-\x7e]{1,512}$/.test(sessionId)) fail("api_error", "The MCP session identifier is invalid.");
    session.sessionId = sessionId;
  }
  const acknowledged = await rpc(session, "notifications/initialized", {}, true);
  if (acknowledged.reply.status !== 202 && acknowledged.reply.status !== 200 && acknowledged.reply.status !== 204) fail("api_error", "The MCP server did not acknowledge initialization.");
  return session;
}
function parameterHeaders(schema: JsonObject, parameters: JsonObject, path: string[] = [], names = new Set<string>()): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, childValue] of Object.entries((schema.properties ?? {}) as JsonObject)) {
    const child = childValue as JsonObject;
    const value = parameters[name];
    if (child["x-mcp-header"] !== undefined) {
      const header = child["x-mcp-header"];
      if (typeof header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(header) || names.has(header.toLowerCase()) || !["string", "integer", "boolean"].includes(String(child.type))) fail("unsupported_api", "The MCP tool header mapping is invalid.");
      names.add(header.toLowerCase());
      if (value !== undefined && value !== null) headers[`Mcp-Param-${header}`] = encodedHeader(String(value));
    }
    if (child.type === "object") Object.assign(headers, parameterHeaders(child, object(value) ? value : {}, [...path, name], names));
    if (child.type === "array" && JSON.stringify(child.items).includes('"x-mcp-header"')) fail("unsupported_api", "MCP header mappings cannot occur inside arrays.");
  }
  return headers;
}
async function listMcp(session: McpSession): Promise<PoppyApiOperation[]> {
  const operations: PoppyApiOperation[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = rpcResult(await rpc(session, "tools/list", cursor ? { cursor } : {}));
    if (!Array.isArray(result.tools) || result.tools.length > 500) fail("unsupported_api", "The MCP tool listing is invalid or too large.");
    for (const tool of result.tools) {
      if (!object(tool) || typeof tool.name !== "string" || !tool.name || tool.name.length > 128 || !object(tool.annotations) || tool.annotations.readOnlyHint !== true || tool.annotations.destructiveHint === true || !schemaSupported(tool.inputSchema) || tool.inputSchema.type !== "object" || tool.inputSchema["x-mcp-header"] !== undefined) continue;
      if (names.has(tool.name)) fail("unsupported_api", "The MCP server advertises duplicate tool names.");
      try { parameterHeaders(tool.inputSchema, {}); } catch { continue; }
      names.add(tool.name);
      operations.push({ id: tool.name, description: typeof tool.description === "string" ? tool.description.slice(0, 1500) : undefined, parameters: tool.inputSchema, scopes: [] });
    }
    if (result.nextCursor === undefined) return operations;
    if (typeof result.nextCursor !== "string" || result.nextCursor.length > 4096 || cursors.has(result.nextCursor)) fail("api_error", "The MCP tool listing has an invalid pagination cursor.");
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  fail("api_error", "The MCP tool listing exceeds the pagination limit.");
}

function sanitized(value: unknown, depth = 0, secrets: string[] = []): unknown {
  if (depth > 20) return "[depth limit]";
  if (Array.isArray(value)) return value.map((v) => sanitized(v, depth + 1, secrets));
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([k]) => !UNSAFE_KEY.test(k)).map(([k, v]) => [k, AUTH_NAME.test(k) ? "[redacted]" : sanitized(v, depth + 1, secrets)]));
  if (typeof value === "string") {
    let safe = value;
    for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, "[redacted]");
    if (/^\s*[\[{]/.test(safe)) {
      const nested = json(safe);
      if (object(nested) || Array.isArray(nested)) return JSON.stringify(sanitized(nested, depth + 1, secrets));
    }
    return safe.replace(/\b(?:Bearer|DPoP)\s+[A-Za-z0-9._~+\/-]+=*/gi, "[redacted authorization]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted JWT]");
  }
  return value;
}
function boundedData(data: unknown, secrets: string[] = []): Pick<PoppyApiResult, "data" | "truncated"> {
  const safe = sanitized(data, 0, secrets);
  const encoded = JSON.stringify(safe);
  if (Buffer.byteLength(encoded) <= MAX_OUTPUT_BYTES - 1024) return { data: safe };
  // Keep an explicit, UTF-8-bounded preview rather than silently returning an
  // incomplete object that could be mistaken for the complete response.
  return { data: { preview: Buffer.from(encoded).subarray(0, 14 * 1024).toString("utf8") }, truncated: true };
}
function boundedDescription(description: PoppyApiDescription): PoppyApiDescription {
  const operations: PoppyApiOperation[] = [];
  for (const op of description.operations.slice(0, MAX_OPERATIONS)) {
    if (Buffer.byteLength(JSON.stringify({ ...description, operations: [...operations, op] })) > MAX_OUTPUT_BYTES - 1024) break;
    operations.push(op);
  }
  return { ...description, operations, ...(operations.length < description.operations.length ? { truncated: true } : {}) };
}
async function safeCall<T>(run: () => Promise<T>, secrets: string[] = []): Promise<T | PoppyApiFailure> {
  try { return sanitized(await run(), 0, secrets) as T; }
  catch (error) {
    if (error instanceof ApiError) return sanitized(error.failure, 0, secrets) as PoppyApiFailure;
    if (error instanceof PoppyRateLimitError) return rateLimited(error.retryAfterSeconds);
    return { error: "api_error", message: "The API request failed or was cancelled." };
  }
}

function trackHeaders(headers: ProofHeaders, secrets: string[]): ProofHeaders {
  return (method, url) => {
    const result = headers(method, url);
    for (const [name, value] of Object.entries(result)) {
      if (/^(authorization|poppy-session|dpop|cookie)$/i.test(name)) {
        secrets.push(value);
        if (/^authorization$/i.test(name)) secrets.push(value.replace(/^\S+\s+/, ""));
      }
    }
    return result;
  };
}

export async function describePoppyApi(
  company: PoppyCompany, apiIndex: number, signal?: AbortSignal,
  request: Request = requestPoppy, headers: ProofHeaders = () => ({}),
): Promise<PoppyApiDescription | PoppyApiFailure> {
  const secrets: string[] = [];
  return safeCall(async () => {
    const api = apiAt(company, apiIndex);
    if (api.type === "openapi") {
      const spec = await openApi(api.url, signal, request);
      return boundedDescription({ type: "openapi", resource: spec.resource, operations: spec.operations.map((op) => ({ id: op.id, description: op.description, parameters: op.parameters, scopes: op.scopes, scopeAlternatives: op.scopeAlternatives, requiresAccount: op.requiresAccount })) });
    }
    if (api.type === "mcp") {
      const session = await connectMcp(api.url, { headers: trackHeaders(headers, secrets), signal, request });
      if (session.sessionId) secrets.push(session.sessionId);
      return boundedDescription({ type: "mcp", resource: api.url, operations: await listMcp(session) });
    }
    fail("unsupported_api", "This advertised API type is not supported.");
  }, secrets);
}

export async function readPoppyApi(
  company: PoppyCompany, apiIndex: number, operation: string,
  parameters: Record<string, unknown>, context: PoppyApiContext,
): Promise<PoppyApiResult | PoppyApiFailure> {
  const secrets: string[] = [];
  context = { ...context, headers: trackHeaders(context.headers, secrets) };
  return safeCall(async () => {
    const api = apiAt(company, apiIndex);
    if (api.type === "openapi") {
      const spec = await openApi(api.url, context.signal, context.request ?? requestPoppy);
      if (context.expectedResource !== undefined && context.expectedResource !== spec.resource) fail("unsupported_api", "The API resource changed; discover it again before requesting account access.");
      const op = spec.operations.find((o) => o.id === operation);
      if (!op) fail("invalid_parameters", "Choose an advertised, supported GET operation.");
      validateParameters(parameters, op.parameters);
      let path = op.path;
      for (const p of op.parametersList.filter((p) => p.in === "path")) {
        const value = String(parameters[String(p.name)]);
        if (!value || /[\\/?#%]/.test(value) || value === "." || value === "..") fail("invalid_parameters", "Path parameters must be a single literal path segment.");
        path = path.replaceAll(`{${String(p.name)}}`, encodeURIComponent(value));
      }
      const url = https(`${spec.resource}${path}`);
      for (const p of op.parametersList.filter((p) => p.in === "query")) {
        const value = parameters[String(p.name)];
        if (value !== undefined) url.searchParams.set(String(p.name), String(value));
      }
      const reply = await send(context.request ?? requestPoppy, url.href, { method: "GET", headers: { Accept: "application/json", ...context.headers("GET", url.href) }, signal: context.signal });
      if (reply.status < 200 || reply.status >= 300) fail("api_error", "The API could not complete this read.");
      const data = json(reply.text);
      if (data === undefined) fail("api_error", "The API did not return a JSON response.");
      return { ...boundedData(data, secrets), resource: spec.resource, operation };
    }
    if (api.type === "mcp") {
      if (context.expectedResource !== undefined && context.expectedResource !== api.url) fail("unsupported_api", "The API resource changed; discover it again before requesting account access.");
      const session = await connectMcp(api.url, context);
      if (session.sessionId) secrets.push(session.sessionId);
      const op = (await listMcp(session)).find((o) => o.id === operation);
      if (!op) fail("invalid_parameters", "Choose an advertised tool explicitly marked read-only.");
      validateParameters(parameters, op.parameters);
      const result = rpcResult(await rpc(session, "tools/call", { name: operation, arguments: parameters }, false, session.version === MODERN ? parameterHeaders(op.parameters, parameters) : {}));
      if (result.isError === true) fail("api_error", "The MCP tool could not complete this read.");
      const content = Array.isArray(result.content) ? result.content.filter((item) => object(item) && item.type === "text" && typeof item.text === "string").map((item) => ({ type: "text", text: item.text })) : undefined;
      return { ...boundedData(result.structuredContent ?? { content: content ?? [] }, secrets), resource: api.url, operation };
    }
    fail("unsupported_api", "This advertised API type is not supported.");
  }, secrets);
}
