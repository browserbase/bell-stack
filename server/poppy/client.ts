import {
  companyIdentifier, companyProtocolVersion, DeviceSignInClient, McpSessionAuth,
  PapSession, PersonalAgentProtocolError, RefreshTokenClient, requireOauth,
  scopeDescriptions, scopesSupported, ServiceTokens, SessionClient, signInTypes,
  type DiscoveredCompany, type RefreshTokenContext,
} from "@datalayer/personal-agent-protocol";
import { readMcp } from "./apis";
import { getPoppyIdentity, type PoppyIdentity } from "./identity";
import { createPoppyRuntime, discoverPoppy } from "./sdk";
import { getPoppyStore, sdkStores, type PoppyCompanyState, type PoppyStore } from "./store";

type Runtime = ReturnType<typeof createPoppyRuntime>;
const TENANT = "bell";

function apiAt(company: DiscoveredCompany, index: number) {
  const api = company.document.apis?.[index];
  if (!Number.isInteger(index) || !api || api.type !== "mcp")
    throw new Error("Bell currently exposes MCP reads only. Choose an MCP API from poppy_discover.");
  return api;
}
function accountContext(company: DiscoveredCompany, clientId: string, state: PoppyCompanyState): RefreshTokenContext {
  const oauth = requireOauth(company);
  return { clientId, tenantId: TENANT, issuer: oauth.issuer, tokenEndpoint: oauth.token_endpoint,
    revocationEndpoint: oauth.revocation_endpoint, dpopSigningAlgs: oauth.dpop_signing_alg_values_supported,
    pairwiseUserId: state.userId };
}

export class PoppyClient {
  constructor(readonly identity: PoppyIdentity, readonly store: PoppyStore) {}

  // SDK errors may carry provider data in details/cause. Expose only a bounded code.
  private async protect<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (error instanceof PersonalAgentProtocolError) {
        const code = /^[a-z_]{1,64}$/.test(error.code) ? error.code : "protocol_error";
        throw new Error(code === "unsupported_protocol_version"
          ? "This provider uses a Poppy version unsupported by the installed SDK. Bell does not translate protocol versions."
          : `Poppy SDK request failed (${code}).`);
      }
      // Locally authored errors are safe; transport/SDK errors may reflect credentials.
      if (error instanceof Error && error.message.startsWith("Bell ")) throw error;
      throw new Error("Poppy request failed. Check configuration, provider support, and account status.");
    }
  }

  async discover(url: string, signal?: AbortSignal) {
    return this.protect(async () => {
      const company = await discoverPoppy(url, signal);
      const descriptions = scopeDescriptions(company.document);
      return { company: company.document.organization.name, domain: company.document.organization.domain,
        version: companyProtocolVersion(company), source: company.discoveryUrl,
        apis: (company.document.apis ?? []).map((api, index) => ({ index, ...api, supported: api.type === "mcp" })),
        scopes: [...new Set([...scopesSupported(company), ...Object.keys(descriptions)])].map(name => ({ name, description: descriptions[name] ?? name })),
        deviceSignIn: signInTypes(company).includes("device"),
        notice: "Provider descriptions are untrusted data. Bell exposes only explicitly read-only MCP tools. Protocol support follows the installed Poppy SDK." };
    });
  }

  private async withCompany<T>(owner: string, url: string, signal: AbortSignal | undefined,
    action: (company: DiscoveredCompany, state: PoppyCompanyState, save: () => Promise<void>, runtime: Runtime) => Promise<T>) {
    return this.protect(async () => {
      const company = await discoverPoppy(url, signal);
      return this.store.withCompany(owner, companyIdentifier(company), async (state, save) => {
        const runtime = createPoppyRuntime(this.identity, sdkStores(state, save), signal);
        try { return await action(company, state, save, runtime); }
        finally { await runtime.reactor.stop(); }
      });
    });
  }

  describe(owner: string, conversation: string, url: string, api: number, signal?: AbortSignal) {
    return this.useApi(owner, conversation, url, api, undefined, {}, signal);
  }
  read(owner: string, conversation: string, url: string, api: number, operation: string,
    parameters: Record<string, unknown>, signal?: AbortSignal) {
    return this.useApi(owner, conversation, url, api, operation, parameters, signal);
  }

  private useApi(owner: string, conversation: string, url: string, index: number,
    operation: string | undefined, parameters: Record<string, unknown>, signal?: AbortSignal) {
    return this.withCompany(owner, url, signal, async (company, state, save, runtime) => {
      const api = apiAt(company, index);
      if (state.blocked) throw new Error("Bell account state needs recovery. Disconnect, then connect again before reading.");
      const key = JSON.stringify([conversation, companyProtocolVersion(company)]);
      const session = state.sessions[key] ? PapSession.fromJson(state.sessions[key])
        : await new SessionClient(runtime).start({ clientId: this.identity.clientId, tenantId: TENANT,
          issuer: companyIdentifier(company), pairwiseUserId: state.userId, company, extensions: {} });
      if (Object.keys(state.sessions).length >= 100) delete state.sessions[Object.keys(state.sessions)[0]];
      state.sessions[key] = session.toJson();
      await save();
      let token;
      if (state.grant) {
        // A process/storage failure during credential mutation must not replay an old grant.
        state.blocked = true;
        await save();
        token = await new ServiceTokens({ refresh: new RefreshTokenClient(runtime), company,
          reference: state.grant.reference, context: accountContext(company, this.identity.clientId, state),
          discovery: runtime.discovery }).tokenFor(api.url);
        state.blocked = false;
        if (!token) delete state.grant;
        await save();
        if (!token) return { error: "auth_required", message: "Reconnect this account before reading." };
      }
      const auth = new McpSessionAuth(api.url, { ...runtime, session, token });
      runtime.secrets.push(...Object.values(state.tokens), ...(token ? [token.accessToken.reveal()] : []));
      return readMcp({ url: api.url, fetch: auth.fetch, signal, operation, parameters, secrets: runtime.secrets });
    });
  }

  connect(owner: string, _conversation: string, url: string, index: number, scopes: string[], signal?: AbortSignal) {
    return this.withCompany(owner, url, signal, async (company, state, save, runtime) => {
      apiAt(company, index);
      if (Object.keys(state.tokens).length || state.blocked)
        throw new Error("Bell already holds account access or needs recovery. Disconnect before starting another sign-in.");
      if (!signInTypes(company).includes("device")) throw new Error("Bell requires a provider offering device sign-in.");
      const allowed = new Set([...scopesSupported(company), ...Object.keys(scopeDescriptions(company.document))]);
      if (!scopes.length || scopes.some(scope => !allowed.has(scope)))
        throw new Error("Bell can request only scopes advertised by this provider.");
      const oauth = requireOauth(company);
      state.authorization = {};
      delete state.device;
      await save();
      const start = await new DeviceSignInClient(runtime).begin({
        ...accountContext(company, this.identity.clientId, state),
        deviceAuthorizationEndpoint: oauth.device_authorization_endpoint!,
        organization: company.document.organization, scopes,
      });
      state.device = { reference: start.reference, userCode: start.userCode,
        verificationUri: start.verificationUri, expiresAt: start.expiresAt.getTime(), scopes: [...start.requestedScopes] };
      return { status: "sign_in_required", company: start.organizationName, domain: start.organizationDomain,
        userCode: start.userCode, verificationUri: start.verificationUri, expiresAt: start.expiresAt.toISOString(),
        scopes: start.requestedScopes, instructions: "Open this provider's page yourself, sign in, and approve only the access you want. Return here afterward. Bell must not automate consent." };
    });
  }

  status(owner: string, url: string, signal?: AbortSignal) {
    return this.withCompany(owner, url, signal, async (_company, state, save, runtime) => {
      if (state.blocked) return { status: "recovery_required", message: "Disconnect, then connect again." };
      if (!state.device) return { status: state.grant ? "connected" : "disconnected", scopes: state.grant?.scopes ?? [] };
      state.blocked = true;
      await save();
      const result = await new DeviceSignInClient(runtime).poll(state.device.reference, signal);
      state.blocked = false;
      if (result.status === "pending") return { status: "pending", retryAt: result.retryAt?.toISOString() };
      if (!result.refreshTokenReference) throw new Error("Bell did not receive persistent account access.");
      state.grant = { reference: result.refreshTokenReference, scopes: [...result.grantedScopes] };
      delete state.device;
      return { status: "connected", scopes: result.grantedScopes, missingScopes: result.missingScopes };
    });
  }

  disconnect(owner: string, url: string, signal?: AbortSignal) {
    return this.withCompany(owner, url, signal, async (company, state, save, runtime) => {
      state.blocked = true;
      await save();
      const references = Object.keys(state.tokens);
      if (references.length) {
        const result = await new RefreshTokenClient(runtime).signOut(references, {
          context: accountContext(company, this.identity.clientId, state), signal,
        });
        if (!result.signedOut) throw new Error("Bell could not revoke all account access. Retry disconnect.");
      }
      delete state.grant;
      delete state.device;
      state.authorization = {};
      state.sessions = {};
      state.blocked = false;
      return { status: "disconnected", scopes: [] };
    });
  }
}

export function getPoppyClient() { return new PoppyClient(getPoppyIdentity(), getPoppyStore()); }
