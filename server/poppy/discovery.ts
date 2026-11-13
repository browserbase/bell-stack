import { z } from "zod";
import { publicPoppyUrl, requestPoppy } from "./http";

export type PoppyCompany = {
  version: string;
  name: string;
  domain: string;
  origin: string;
  identifier: string;
  manifestUrl: string;
  apis: Array<{ type: string; url: string; description?: string }>;
  scopes: Record<string, string>;
  scopeHints: Record<string, { changes: string; personal_data: boolean }>;
  oauth?: {
    issuer: string;
    token_endpoint: string;
    revocation_endpoint: string;
    device_authorization_endpoint?: string;
    authorization_endpoint?: string;
    grant_types_supported: string[];
    scopes_supported?: string[];
  };
  authDisabled: boolean;
};

const text = z.string().min(1).max(4000);
const httpsUrl = text.refine(value => { try { publicPoppyUrl(value); return true; } catch { return false; } });
const scope = z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/).max(256);
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/).max(20);
const auth = z.object({
  issuer: httpsUrl.optional(), disabled: z.boolean().optional(),
  scopes: z.record(scope, text).optional(),
  scope_hints: z.record(scope, z.object({ changes: text, personal_data: z.boolean() })).optional(),
});
const manifest = z.object({
  protocol_version: version,
  supported_versions: z.record(version, httpsUrl).optional(),
  organization: z.object({ name: text, domain: text, logo_uri: httpsUrl.optional() }),
  auth: auth.optional(),
  apis: z.array(z.object({ type: text, url: httpsUrl, description: text.optional() })).max(100).optional(),
  agent: z.object({ protocols: z.array(z.object({ type: text, endpoint: httpsUrl, access: text.optional() })).min(1).max(100) }).optional(),
  web: z.object({ disabled: z.boolean().optional(), unscoped: z.boolean().optional(), browser_session_endpoint: httpsUrl.optional() }).optional(),
}).refine(value => Boolean(value.apis?.length || value.agent || (value.web && !value.web.disabled)));
const resourceMetadata = z.object({ resource: httpsUrl, authorization_servers: z.array(httpsUrl).max(100).optional(), scopes_supported: z.array(scope).optional() });
const serverMetadata = z.object({
  issuer: httpsUrl, protected_resources: z.array(httpsUrl), token_endpoint: httpsUrl, revocation_endpoint: httpsUrl,
  grant_types_supported: z.array(text).min(1), device_authorization_endpoint: httpsUrl.optional(), authorization_endpoint: httpsUrl.optional(),
  scopes_supported: z.array(scope).optional(),
}).refine(value => value.grant_types_supported.includes("refresh_token") &&
  (!value.grant_types_supported.includes("authorization_code") || Boolean(value.authorization_endpoint)) &&
  (!value.grant_types_supported.includes("urn:ietf:params:oauth:grant-type:device_code") || Boolean(value.device_authorization_endpoint)));

function parse<T>(schema: z.ZodType<T>, body: string, label: string): T {
  try { return schema.parse(JSON.parse(body)); }
  catch { throw new Error(`Poppy returned invalid ${label}.`); }
}
function checkStatus(status: number, label: string) {
  if (status !== 200) throw new Error(`Poppy ${label} returned HTTP ${status}.`);
}
function compatible(value: string) { return value === "0.3" || value === "0.4" || value.split(".")[0] === "1"; }
function newer(a: string, b: string) {
  const aa = a.split(".").map(Number), bb = b.split(".").map(Number);
  return bb[0] - aa[0] || bb[1] - aa[1];
}
function domainMatches(domain: string, url: URL) { return domain.toLowerCase() === url.hostname.toLowerCase(); }
function issuerFrom(document: z.infer<typeof manifest>, servers: string[]) {
  const declared = document.auth?.issuer;
  if (!servers.length) {
    if (declared) throw new Error("Poppy declared an issuer without protected resource metadata.");
    return undefined;
  }
  if (declared && servers.includes(declared)) return declared;
  if (declared || servers.length !== 1) throw new Error("Poppy could not verify the company's chosen issuer.");
  return servers[0];
}
function normalizedResource(value: string) {
  // Only host case is normalized; paths, ports, trailing slashes and encoding remain significant.
  return value.replace(/^(https:\/\/)([^/?:#]+)/, (_match, scheme: string, host: string) => scheme + host.toLowerCase());
}

export async function discoverPoppy(value: string, signal?: AbortSignal, request: typeof requestPoppy = requestPoppy): Promise<PoppyCompany> {
  const input = publicPoppyUrl(value);
  const initialResponse = await request(new URL("/.well-known/poppy.json", input).href, { signal, discoveryRedirects: true });
  checkStatus(initialResponse.status, "discovery");
  const source = publicPoppyUrl(initialResponse.url);
  if (source.pathname !== "/.well-known/poppy.json" || source.search) throw new Error("Poppy discovery ended outside the well-known path.");
  const initial = parse(manifest, initialResponse.text, "manifest");
  if (!domainMatches(initial.organization.domain, source)) throw new Error("Poppy manifest domain does not match its source.");
  const origin = source.origin;
  const available = [initial.protocol_version, ...Object.keys(initial.supported_versions ?? {})];
  const selected = available.filter(compatible).sort(newer)[0];
  if (!selected) throw new Error("Poppy protocol version is unsupported.");
  let document = initial, manifestUrl = source.href;
  if (selected !== initial.protocol_version) {
    const alternate = publicPoppyUrl(initial.supported_versions![selected]);
    if (alternate.origin !== origin) throw new Error("Poppy version document is on another host.");
    const response = await request(alternate.href, { signal });
    checkStatus(response.status, "version discovery");
    if (response.url !== alternate.href) throw new Error("Poppy version discovery redirected.");
    document = parse(manifest, response.text, "version manifest");
    if (document.protocol_version !== selected || document.supported_versions !== undefined || !domainMatches(document.organization.domain, source))
      throw new Error("Poppy version document does not match its advertisement.");
    manifestUrl = alternate.href;
  }
  const resourceUrl = origin + "/.well-known/oauth-protected-resource";
  const response = await request(resourceUrl, { signal });
  let servers: string[] = [], resourceScopes: string[] = [];
  if (response.status !== 404) {
    checkStatus(response.status, "protected resource discovery");
    if (response.url !== resourceUrl) throw new Error("Poppy protected resource discovery redirected.");
    const resource = parse(resourceMetadata, response.text, "protected resource metadata");
    if (resource.resource !== origin) throw new Error("Poppy protected resource does not match its domain.");
    servers = resource.authorization_servers ?? [];
    resourceScopes = resource.scopes_supported ?? [];
  }
  const issuer = issuerFrom(document, servers);
  if (issuerFrom(initial, servers) !== issuer) throw new Error("Poppy versions identify different issuers.");
  let oauth: PoppyCompany["oauth"];
  if (issuer) {
    const issuerUrl = publicPoppyUrl(issuer);
    if (issuerUrl.search) throw new Error("Poppy issuer must not contain a query.");
    const metadataUrl = issuerUrl.origin + "/.well-known/oauth-authorization-server" + (issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, ""));
    const metadata = await request(metadataUrl, { signal });
    checkStatus(metadata.status, "authorization server discovery");
    if (metadata.url !== metadataUrl) throw new Error("Poppy authorization server discovery redirected.");
    const server = parse(serverMetadata, metadata.text, "authorization server metadata");
    if (server.issuer !== issuer || !server.protected_resources.some(entry => normalizedResource(entry) === origin))
      throw new Error("Poppy issuer did not confirm the company domain.");
    oauth = {
      issuer: server.issuer, token_endpoint: server.token_endpoint, revocation_endpoint: server.revocation_endpoint,
      device_authorization_endpoint: server.device_authorization_endpoint, authorization_endpoint: server.authorization_endpoint,
      grant_types_supported: server.grant_types_supported,
      scopes_supported: [...new Set([...resourceScopes, ...(server.scopes_supported ?? [])])],
    };
  }
  const signedIn = document.agent?.protocols.some(protocol => protocol.type === "poppy" && protocol.access === "signed_in");
  if (signedIn && (!issuer || document.auth?.disabled)) throw new Error("Poppy advertises account access without sign-in.");
  return {
    version: selected, name: document.organization.name, domain: source.hostname, origin, identifier: issuer ?? origin, manifestUrl,
    apis: document.apis ?? [], scopes: document.auth?.scopes ?? {},
    scopeHints: Object.fromEntries(Object.entries(document.auth?.scope_hints ?? {}).map(([name, hint]) => [name, {
      ...hint, changes: ["none", "reversible", "irreversible"].includes(hint.changes) ? hint.changes : "irreversible",
    }])),
    oauth, authDisabled: Boolean(document.auth?.disabled || !issuer),
  };
}
