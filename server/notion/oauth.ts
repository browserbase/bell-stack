import { randomBytes, randomUUID } from "node:crypto";
import { ConnectionAuthorizationRequiredError, type ConnectionPrincipal } from "eve/connections";
import { z } from "zod";
import { hash } from "../encrypted-record";
import { failed, notionConfig, notionOwner } from "./config";
import { createNotionStore, type NotionPersistence, type NotionState, type Tokens, type LockedState } from "./store";

const issuer = "https://mcp.notion.com";
const metadataSchema = z.object({
  issuer: z.literal(issuer), authorization_endpoint: z.url(), token_endpoint: z.url(), registration_endpoint: z.url(),
  revocation_endpoint: z.url(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1).optional(),
  token_type: z.string().refine(value => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive().max(365 * 24 * 60 * 60),
});
export type NotionResume = { attemptId: string };

function trustedEndpoint(value: string): boolean {
  const url = new URL(value);
  return url.origin === issuer && !url.username && !url.password && !url.hash;
}

function parseCallback(params: Readonly<Record<string, string>>): { state: string; code?: string; error?: string } {
  const { state, code, error, iss } = params;
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || Boolean(code) === Boolean(error)
    || (code && code.length > 4096) || (error && !/^[a-zA-Z0-9_]{1,100}$/.test(error))
    || (iss !== undefined && iss !== issuer)) return failed("invalid_callback");
  return { state, ...(code ? { code } : { error: error! }) };
}

export class NotionOAuth {
  constructor(
    readonly config: ReturnType<typeof notionConfig>, readonly store: NotionPersistence,
    private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now,
  ) {}

  private async request(url: string, init: RequestInit = {}) {
    // Only the verified Notion issuer may receive credentials or registration data.
    if (!trustedEndpoint(url)) return failed("invalid_oauth_endpoint");
    try { return await this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
    catch { return failed("notion_unavailable"); }
  }

  private async metadata() {
    const response = await this.request(`${issuer}/.well-known/oauth-authorization-server`);
    if (!response.ok) return failed("oauth_discovery_failed");
    const parsed = metadataSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success || [parsed.data.authorization_endpoint, parsed.data.token_endpoint,
      parsed.data.registration_endpoint, parsed.data.revocation_endpoint].some(endpoint => !trustedEndpoint(endpoint)))
      return failed("invalid_oauth_metadata");
    return parsed.data;
  }

  private async exchange(state: NotionState, fields: Record<string, string>, previousRefresh?: string): Promise<Tokens> {
    if (!state.client) return failed("client_missing");
    const metadata = await this.metadata();
    const response = await this.request(metadata.token_endpoint, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: state.client.id, ...(state.client.secret ? { client_secret: state.client.secret } : {}), ...fields,
      }),
    });
    if (!response.ok) return failed("token_exchange_failed_reconnect");
    const parsed = tokenSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return failed("invalid_token_response");
    return { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token ?? previousRefresh,
      expiresAt: this.now() + parsed.data.expires_in * 1000 };
  }

  private callbackUrl(value: string) {
    const target = new URL(value);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.hash
      || !/^\/eve\/v1\/connections\/[^/]+\/callback\/[^/]+\/[^/]+$/.test(target.pathname))
      return failed("invalid_callback_url");
    // Eve may use an internal dev port; its capability path goes through Bell's public router.
    return new URL(target.pathname + target.search, this.config.origin);
  }

  async getToken(principal: ConnectionPrincipal) {
    return this.store.withOwner(notionOwner(principal), async db => {
      if (db.value.status === "disconnecting") return failed("disconnect_pending");
      const old = db.value.tokens;
      if (!old || db.value.status === "reconnect") throw new ConnectionAuthorizationRequiredError("notion");
      if (old.expiresAt > this.now() + 60_000) return { token: old.accessToken, expiresAt: old.expiresAt };
      // Persist invalidation before using a rotating refresh token. Crashes require reconnect.
      db.value.status = "reconnect";
      await db.save();
      if (!old.refreshToken) throw new ConnectionAuthorizationRequiredError("notion");
      try {
        const tokens = await this.exchange(db.value, { grant_type: "refresh_token", refresh_token: old.refreshToken }, old.refreshToken);
        db.value.tokens = tokens;
        db.value.status = "active";
        await db.save();
        return { token: tokens.accessToken, expiresAt: tokens.expiresAt };
      } catch { throw new ConnectionAuthorizationRequiredError("notion"); }
    });
  }

  async evict(principal: ConnectionPrincipal) {
    await this.store.withOwner(notionOwner(principal), async db => {
      if (db.value.tokens) db.value.tokens.expiresAt = 0;
      await db.save();
    });
  }

  async start(principal: ConnectionPrincipal, callbackUrl: string) {
    this.callbackUrl(callbackUrl);
    return this.store.withOwner(notionOwner(principal), async db => {
      if (db.value.status === "disconnecting") return failed("disconnect_pending");
      // Revoke before replacement consent; the provider can share a grant across tokens.
      if (db.value.tokens) await this.revoke(db);
      const metadata = await this.metadata();
      if (!db.value.client || db.value.client.redirectUri !== this.config.redirectUri) {
        const response = await this.request(metadata.registration_endpoint, {
          method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ client_name: "Bell", redirect_uris: [this.config.redirectUri],
            grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
        });
        if (!response.ok) return failed("client_registration_failed");
        const client = z.object({ client_id: z.string().min(1), client_secret: z.string().optional() })
          .safeParse(await response.json().catch(() => null));
        if (!client.success) return failed("invalid_client_response");
        db.value.client = { id: client.data.client_id, secret: client.data.client_secret, redirectUri: this.config.redirectUri };
        await db.save();
      }
      let pending = db.value.pending;
      if (!pending || pending.callbackUrl !== callbackUrl || pending.expiresAt <= this.now() || pending.status !== "pending") {
        pending = { id: randomUUID(), state: randomBytes(32).toString("base64url"), verifier: randomBytes(32).toString("base64url"),
          callbackUrl, expiresAt: this.now() + 10 * 60_000, status: "pending" };
        db.value.pending = pending;
        await db.save();
      }
      const url = new URL(metadata.authorization_endpoint);
      url.search = new URLSearchParams({ client_id: db.value.client.id, redirect_uri: this.config.redirectUri,
        response_type: "code", scope: "default", state: pending.state,
        code_challenge: hash(pending.verifier), code_challenge_method: "S256", resource: "https://mcp.notion.com/mcp" }).toString();
      return { challenge: { displayName: "Notion", url: url.href, expiresAt: new Date(pending.expiresAt).toISOString(),
        instructions: "Sign in to your Notion workspace, then return to Bell. Keep this link private." },
        resume: { attemptId: pending.id } };
    });
  }

  async forward(params: Readonly<Record<string, string>>) {
    const callback = parseCallback(params);
    const owner = await this.store.findOwner(hash(callback.state));
    if (!owner) return failed("invalid_state");
    return this.store.withOwner(owner, async db => {
      const pending = db.value.pending;
      const resultHash = hash(JSON.stringify(callback));
      if (!pending || pending.state !== callback.state || pending.expiresAt <= this.now()
        || !(pending.status === "pending" || (pending.status === "forwarded" && pending.resultHash === resultHash)))
        return failed("authorization_expired");
      pending.status = "forwarded";
      pending.resultHash = resultHash;
      await db.save();
      const target = this.callbackUrl(pending.callbackUrl);
      for (const [name, value] of Object.entries(callback)) target.searchParams.set(name, value);
      return target.href;
    });
  }

  async complete(principal: ConnectionPrincipal, callbackUrl: string, resume: NotionResume | undefined, params: Readonly<Record<string, string>>) {
    const callback = parseCallback(params);
    return this.store.withOwner(notionOwner(principal), async db => {
      const pending = db.value.pending;
      if (!pending || pending.id !== resume?.attemptId || pending.callbackUrl !== callbackUrl
        || pending.state !== callback.state || pending.resultHash !== hash(JSON.stringify(callback))) return failed("invalid_state");
      if (pending.status === "completed" && db.value.tokens) {
        const tokens = db.value.tokens;
        return { token: tokens.accessToken, expiresAt: tokens.expiresAt };
      }
      if (pending.status !== "forwarded" || pending.expiresAt <= this.now()) return failed("authorization_expired");
      pending.status = "failed";
      if (callback.error || !callback.code) { await db.save(); return failed("authorization_denied"); }
      pending.status = "exchanging";
      await db.save();
      const tokens = await this.exchange(db.value, { grant_type: "authorization_code", code: callback.code,
        redirect_uri: this.config.redirectUri, code_verifier: pending.verifier, resource: "https://mcp.notion.com/mcp" });
      db.value.tokens = tokens;
      db.value.status = "active";
      pending.status = "completed";
      pending.verifier = "";
      await db.save();
      return { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    });
  }

  async status(principal: ConnectionPrincipal) {
    return this.store.withOwner(notionOwner(principal), async db => ({
      status: db.value.status === "disconnecting" ? "disconnect_pending"
        : db.value.status === "reconnect" ? "reconnect_required" : db.value.tokens ? "connected" : "disconnected",
      refreshable: Boolean(db.value.tokens?.refreshToken),
    }));
  }

  async disconnect(principal: ConnectionPrincipal) {
    await this.store.withOwner(notionOwner(principal), db => this.revoke(db));
    return { status: "disconnected" };
  }

  private async revoke(db: LockedState) {
    db.value.status = "disconnecting";
    delete db.value.pending;
    await db.save();
    if (db.value.tokens) {
      if (!db.value.client) return failed("client_missing");
      const metadata = await this.metadata();
      const tokens = db.value.tokens;
      const response = await this.request(metadata.revocation_endpoint, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: db.value.client.id,
          ...(db.value.client.secret ? { client_secret: db.value.client.secret } : {}),
          token: tokens.refreshToken ?? tokens.accessToken,
          token_type_hint: tokens.refreshToken ? "refresh_token" : "access_token" }),
      });
      if (!response.ok) return failed("revocation_failed_retry_disconnect");
    }
    delete db.value.tokens;
    db.value.status = "disconnected";
    await db.save();
  }
}

let service: NotionOAuth | undefined;
export function getNotionOAuth() {
  const config = notionConfig();
  return service ??= new NotionOAuth(config, createNotionStore(config.databaseUrl, config.key));
}
