import {
  Client, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError,
  type JsonSchemaType, type Tool,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

type JsonObject = Record<string, unknown>;
export type PoppyApiFailure = {
  error: "auth_required" | "insufficient_scope" | "api_error" | "invalid_parameters";
  message: string;
};
export type PoppyApiOperation = { id: string; description?: string; parameters: JsonObject };
export type PoppyApiDescription = { type: "mcp"; resource: string; operations: PoppyApiOperation[]; truncated?: boolean };
export type PoppyApiResult = { resource: string; operation: string; data: unknown; truncated?: boolean };
export type ReadMcpOptions = {
  url: string;
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
  operation?: string;
  parameters?: JsonObject;
  secrets?: string[];
};

const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_OPERATIONS = 100;
const AUTH_NAME = /(?:authorization|cookie|password|secret|credential|assertion|private.?key|token|capabilit|api.?key|poppy.?session|dpop)/i;
const UNSAFE_KEY = /^(?:__proto__|prototype|constructor)$/;

function hasCredentialFields(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (Array.isArray(value)) return value.some((item) => hasCredentialFields(item, depth + 1));
  return value !== null && typeof value === "object" && Object.entries(value).some(([key, item]) =>
    AUTH_NAME.test(key) || UNSAFE_KEY.test(key) || hasCredentialFields(item, depth + 1));
}

function sanitize(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 20) return "[depth limit]";
  if (Array.isArray(value)) return value.map((v) => sanitize(v, secrets, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !UNSAFE_KEY.test(key))
      .map(([key, v]) => [String(sanitize(key, secrets, depth + 1)), AUTH_NAME.test(key) ? "[redacted]" : sanitize(v, secrets, depth + 1)]));
  }
  if (typeof value !== "string") return value;
  let safe = value;
  for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, "[redacted]");
  if (/^\s*[\[{]/.test(safe)) {
    try { return JSON.stringify(sanitize(JSON.parse(safe), secrets, depth + 1)); }
    catch { /* Plain text is also a valid tool result. */ }
  }
  return safe.replace(/\b(?:Bearer|DPoP)\s+[A-Za-z0-9._~+\/-]+=*/gi, "[redacted authorization]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted JWT]");
}

function boundedData(data: unknown, secrets: string[]): Pick<PoppyApiResult, "data" | "truncated"> {
  const safe = sanitize(data, secrets);
  const encoded = JSON.stringify(safe);
  if (Buffer.byteLength(encoded) <= MAX_OUTPUT_BYTES - 1024) return { data: safe };
  return { data: { preview: Buffer.from(encoded).subarray(0, 14 * 1024).toString("utf8") }, truncated: true };
}

function catalog(resource: string, tools: Tool[], secrets: string[], truncated: boolean): PoppyApiDescription {
  const operations: PoppyApiOperation[] = [];
  for (const tool of tools) {
    const operation = sanitize({
      id: tool.name, description: tool.description, parameters: tool.inputSchema,
    }, secrets) as PoppyApiOperation;
    if (Buffer.byteLength(JSON.stringify({ type: "mcp", resource, operations: [...operations, operation] })) > MAX_OUTPUT_BYTES - 1024) break;
    operations.push(operation);
  }
  return { type: "mcp", resource, operations, ...(truncated || operations.length < tools.length ? { truncated: true } : {}) };
}

/** Bell's read-only policy and model-output boundary; the SDK owns MCP itself. */
export async function readMcp({ url, fetch, signal, operation, parameters = {}, secrets = [] }: ReadMcpOptions): Promise<PoppyApiDescription | PoppyApiResult | PoppyApiFailure> {
  const validator = new AjvJsonSchemaValidator();
  const client = new Client({ name: "bell", version: "0.1.0" }, {
    capabilities: {}, versionNegotiation: { mode: "auto" }, listMaxPages: 4, jsonSchemaValidator: validator,
  });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch, requestInit: { redirect: "error" },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  try {
    await client.connect(transport, { signal, timeout: 15_000 });
    const listing = await client.listTools(undefined, { signal, timeout: 15_000 });
    // A duplicate name must not let an unsafe definition inherit a safe annotation.
    const names = new Set<string>();
    const duplicates = new Set<string>();
    for (const tool of listing.tools) {
      if (names.has(tool.name)) duplicates.add(tool.name);
      names.add(tool.name);
    }
    const readOnly = listing.tools.filter((tool) => tool.annotations?.readOnlyHint === true
      && tool.annotations.destructiveHint !== true && !duplicates.has(tool.name) && !hasCredentialFields(tool.inputSchema));
    const allowed = readOnly.slice(0, MAX_OPERATIONS);
    if (operation === undefined) return catalog(url, allowed, secrets, readOnly.length > allowed.length);
    const tool = allowed.find((entry) => entry.name === operation);
    if (!tool) return { error: "invalid_parameters", message: "Choose an advertised, explicitly read-only operation." };
    if (hasCredentialFields(parameters) || secrets.some((secret) => secret && JSON.stringify(parameters).includes(secret))) {
      return { error: "invalid_parameters", message: "Do not supply credentials in operation parameters." };
    }
    if (!validator.getValidator(tool.inputSchema as JsonSchemaType)(parameters).valid) {
      return { error: "invalid_parameters", message: "Parameters must match the advertised operation schema." };
    }
    const result = await client.callTool({ name: operation, arguments: parameters }, { signal, timeout: 15_000, toolDefinition: tool });
    if (result.isError) return { error: "api_error", message: "The provider could not complete this read operation." };
    return { resource: url, operation, ...boundedData(result.structuredContent !== undefined ? result.structuredContent : { content: result.content }, secrets) };
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof SdkHttpError && error.status === 401) {
      return { error: "auth_required", message: "This API requires account access or an accepted agent identity." };
    }
    if (error instanceof SdkHttpError && error.status === 403) {
      return { error: "insufficient_scope", message: "This read requires additional account permission." };
    }
    return { error: "api_error", message: "The API request failed or was cancelled." };
  } finally {
    // Closing only releases this call's transport; it does not revoke the account grant.
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
