import { z } from "zod";
import type { PoppyCompany } from "./discovery";
import { PoppyRateLimitError, poppyRetryAfterSeconds, requestPoppy } from "./http";
import type { PoppyIdentity } from "./identity";
import type { PoppyCompanyState, PoppyGrant, PoppyStore } from "./store";

const scopeName = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const deviceResponse = z.object({
  device_code: z.string().min(1).max(8192), user_code: z.string().min(1).max(128),
  verification_uri: z.string().url().max(2048),
  expires_in: z.number().int().positive().max(3600),
  interval: z.number().int().positive().max(300).default(5),
});
const tokenResponse = z.object({
  access_token: z.string().min(1).max(32768), refresh_token: z.string().min(1).max(32768).optional(),
  token_type: z.string(), expires_in: z.number().int().positive().max(365 * 86400),
  scope: z.string().max(8192).optional(),
});
const json = (text: string): Record<string, unknown> => {
  try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
};

export function checkVerificationUri(value: string, company: PoppyCompany): string {
  const url = new URL(value);
  const hosts = [company.domain, new URL(company.identifier).hostname].map(host => host.toLowerCase());
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") ||
      !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)))
    throw new Error("The company returned an unrelated sign-in page.");
  return url.href;
}

/** Resolve OAuth's audience from the advertised service, never from a model-supplied URL. */
export async function poppyResource(company: PoppyCompany, service: string, type: string,
  signal?: AbortSignal, request = requestPoppy): Promise<string | undefined> {
  if (!company.oauth) return undefined;
  const url = new URL(service);
  const metadata = new URL(`/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`, url.origin);
  const response = await request(metadata.href, { signal });
  if (response.status === 404 && type !== "mcp") return undefined;
  if (response.status !== 200) throw new Error("The API's OAuth resource metadata is unavailable.");
  const document = json(response.text);
  if (document.resource !== service) {
    if (type === "mcp") throw new Error("The MCP server's OAuth resource does not match its advertised URL.");
    return undefined;
  }
  if (type === "mcp" && (!Array.isArray(document.authorization_servers) || !document.authorization_servers.includes(company.oauth.issuer)))
    throw new Error("The MCP server does not authorize this company's issuer.");
  return type === "mcp" || service !== company.origin ? service : undefined;
}

export class PoppyOAuth {
  constructor(readonly identity: PoppyIdentity, readonly store: PoppyStore,
    private readonly request = requestPoppy, private readonly now = Date.now) {}

  private async post(company: PoppyCompany, endpoint: "device" | "token" | "revoke",
    fields: Record<string, string>, signal?: AbortSignal) {
    const oauth = company.oauth;
    if (!oauth || (endpoint === "device" && company.authDisabled)) throw new Error("This company does not offer Poppy account sign-in.");
    const url = endpoint === "device" ? oauth.device_authorization_endpoint
      : endpoint === "token" ? oauth.token_endpoint : oauth.revocation_endpoint;
    if (!url) throw new Error("This company does not offer device sign-in. Use its website instead.");
    return this.request(url, {
      method: "POST", signal,
      headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-store" },
      body: new URLSearchParams({ ...fields, client_id: this.identity.clientId,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: this.identity.assertion(oauth.issuer) }).toString(),
    });
  }

  private grant(text: string, requested: string[], resource?: string, previous?: PoppyGrant): PoppyGrant {
    const parsed = tokenResponse.safeParse(json(text));
    if (!parsed.success) throw new Error("The company returned an invalid OAuth token response.");
    const data = parsed.data;
    if (data.token_type.toLowerCase() !== "bearer")
      throw new Error("This company requires a token type Bell does not support. DPoP is not supported yet.");
    const scopes = data.scope === undefined ? requested : data.scope.split(" ").filter(Boolean);
    if (!scopes.length || scopes.some(scope => !scopeName.test(scope) || !requested.includes(scope)))
      throw new Error("The company granted unrequested or invalid scopes.");
    const refreshToken = data.refresh_token ?? previous?.refreshToken;
    if (!refreshToken) throw new Error("The company did not return the required refresh token.");
    return { accessToken: data.access_token, refreshToken, expiresAt: this.now() + data.expires_in * 1000,
      scopes: [...new Set(scopes)], resource, status: "active" };
  }

  private challenge(company: PoppyCompany, state: PoppyCompanyState) {
    const device = state.device!;
    return { status: "sign_in_required" as const, company: company.name, domain: company.domain,
      verificationUri: device.verificationUri, userCode: device.userCode,
      scopes: device.scopes.map(scope => ({ name: scope, description: company.scopes[scope] ?? scope,
        hints: company.scopeHints[scope] })), expiresAt: new Date(device.expiresAt).toISOString(),
      instructions: "Open this company's sign-in page yourself, enter the code, and approve only the access you want. Bell must not sign in or approve consent for you. Return here afterward." };
  }

  async connect(owner: string, company: PoppyCompany, requested: string[], resource?: string, signal?: AbortSignal) {
    const scopes = [...new Set(requested)];
    if (!scopes.length || scopes.length > 32 || scopes.some(scope => !scopeName.test(scope)))
      throw new Error("Choose at least one advertised OAuth scope.");
    if (!company.oauth?.grant_types_supported.includes("urn:ietf:params:oauth:grant-type:device_code") || company.authDisabled)
      throw new Error("This company does not offer device sign-in. Bell does not automate its sign-in page.");
    return this.store.withCompany(owner, company.identifier, async (state, save) => {
      if (state.grant?.status === "revoking") throw new Error("Finish disconnecting before connecting again.");
      if (state.device?.status === "pending" && state.device.expiresAt > this.now() && state.device.resource === resource &&
        JSON.stringify(state.device.scopes) === JSON.stringify(scopes)) return this.challenge(company, state);
      const response = await this.post(company, "device", { scope: scopes.join(" "), ...(resource ? { resource } : {}) }, signal);
      if (response.status !== 200) throw new Error(`The company refused device sign-in (HTTP ${response.status}). Check whether it accepts this Bell client.`);
      const parsed = deviceResponse.safeParse(json(response.text));
      if (!parsed.success) throw new Error("The company returned an invalid device authorization.");
      const device = parsed.data;
      state.device = { deviceCode: device.device_code, userCode: device.user_code,
        verificationUri: checkVerificationUri(device.verification_uri, company),
        expiresAt: this.now() + device.expires_in * 1000, interval: device.interval,
        nextPollAt: this.now() + device.interval * 1000, scopes, resource, status: "pending" };
      await save();
      return this.challenge(company, state);
    });
  }

  async status(owner: string, company: PoppyCompany, signal?: AbortSignal) {
    return this.store.withCompany(owner, company.identifier, async (state, save) => {
      const device = state.device;
      if (!device) return { status: state.grant?.status === "active" ? "connected" : "disconnected", scopes: state.grant?.scopes ?? [] };
      if (device.expiresAt <= this.now()) { delete state.device; return { status: "expired" }; }
      if (device.status !== "pending") throw new Error("A previous sign-in poll had an uncertain outcome. Start sign-in again.");
      if (device.nextPollAt > this.now()) return { status: "pending", retryAfterSeconds: Math.ceil((device.nextPollAt - this.now()) / 1000) };
      device.status = "polling";
      await save();
      let response;
      try {
        response = await this.post(company, "token", {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.deviceCode,
          ...(device.resource ? { resource: device.resource } : {}),
        }, signal);
      } catch (error) {
        if (error instanceof PoppyRateLimitError) {
          device.status = "pending";
          device.nextPollAt = this.now() + Math.max(device.interval, error.retryAfterSeconds) * 1000;
          await save();
        }
        throw error;
      }
      const error = json(response.text).error;
      if (error === "authorization_pending" || error === "slow_down" || response.status === 429) {
        if (error === "slow_down" || response.status === 429) device.interval += 5;
        const seconds = Math.max(device.interval, poppyRetryAfterSeconds(response.headers, this.now()) ?? 0);
        device.nextPollAt = this.now() + seconds * 1000;
        device.status = "pending";
        return { status: "pending", retryAfterSeconds: seconds };
      }
      if (error === "access_denied" || error === "expired_token") {
        delete state.device;
        return { status: error === "access_denied" ? "declined" : "expired" };
      }
      if (response.status !== 200) { delete state.device; throw new Error(`The company rejected sign-in (HTTP ${response.status}).`); }
      const grant = this.grant(response.text, device.scopes, device.resource);
      if (state.grant && state.grant.refreshToken !== grant.refreshToken)
        state.retiredRefreshTokens = [...(state.retiredRefreshTokens ?? []), state.grant.refreshToken];
      state.grant = grant;
      state.sessions = {};
      delete state.device;
      await save();
      await this.revokeRetired(company, state, save, signal);
      return { status: "connected", scopes: grant.scopes, expiresAt: new Date(grant.expiresAt).toISOString() };
    });
  }

  private async revokeRetired(company: PoppyCompany, state: PoppyCompanyState, save: () => Promise<void>, signal?: AbortSignal) {
    for (const token of [...(state.retiredRefreshTokens ?? [])]) {
      try {
        const response = await this.post(company, "revoke", { token, token_type_hint: "refresh_token" }, signal);
        if (response.status !== 200) continue;
        state.retiredRefreshTokens = state.retiredRefreshTokens!.filter(value => value !== token);
        await save();
      } catch { signal?.throwIfAborted(); }
    }
  }

  /** Called inside the same owner/company lock as the resource request. */
  async accessToken(company: PoppyCompany, state: PoppyCompanyState, save: () => Promise<void>,
    resource?: string, signal?: AbortSignal, forceRefresh = false): Promise<string | undefined> {
    const grant = state.grant;
    if (!grant) return undefined;
    if (grant.status !== "active") throw new Error("Saved Poppy authorization is blocked. Reconnect, or finish disconnecting.");
    if (!forceRefresh && grant.expiresAt > this.now() + 60_000 && grant.resource === resource) return grant.accessToken;
    grant.status = "uncertain";
    await save();
    let response;
    try {
      response = await this.post(company, "token", {
        grant_type: "refresh_token", refresh_token: grant.refreshToken,
        scope: grant.scopes.join(" "), ...(resource ? { resource } : {}),
      }, signal);
    } catch (error) {
      if (error instanceof PoppyRateLimitError) { grant.status = "active"; await save(); }
      throw error;
    }
    if (response.status === 429) {
      // A definitive rate-limit rejection issued no replacement token; retain the existing grant.
      grant.status = "active";
      await save();
      const seconds = poppyRetryAfterSeconds(response.headers, this.now());
      if (seconds !== undefined) throw new PoppyRateLimitError(seconds);
      throw new Error("OAuth refresh was rate limited. Retry later; existing authorization was preserved.");
    }
    if (response.status !== 200) {
      if (json(response.text).error === "invalid_grant") { delete state.grant; state.sessions = {}; await save(); return undefined; }
      throw new Error(`OAuth refresh failed (HTTP ${response.status}). Reconnect before using account data.`);
    }
    state.grant = this.grant(response.text, grant.scopes, resource, grant);
    await save();
    return state.grant.accessToken;
  }

  async disconnect(owner: string, company: PoppyCompany, signal?: AbortSignal) {
    return this.store.withCompany(owner, company.identifier, async (state, save) => {
      delete state.device;
      state.sessions = {};
      if (state.grant) {
        state.grant.status = "revoking";
        state.retiredRefreshTokens = [...new Set([...(state.retiredRefreshTokens ?? []), state.grant.refreshToken])];
      }
      await save();
      await this.revokeRetired(company, state, save, signal);
      if (state.retiredRefreshTokens?.length) throw new Error("Account access is blocked locally, but remote revocation failed. Retry disconnect.");
      delete state.grant;
      return { status: "disconnected" };
    });
  }
}
