import {
  AuthorizationStateStores, SessionFetchClient, SessionSigners, Signers, TokenStores,
  buildPapReactor, discoverCompany, type AccessToken, type DiscoveredCompany, type DiscoveryOptions, type PapSession,
} from "@datalayer/personal-agent-protocol";
import { createResolvingFetch, NodeUrlSafetyPolicy } from "@datalayer/personal-agent-protocol/server";
import { contribution, definePlugin, type ReactorPlatformView } from "@datalayer/reactor";
import type { PoppyIdentity } from "./identity";
import { afterPoppyResponse, beforePoppyRequest } from "./limits";
import type { PoppySdkStores } from "./store";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

function beforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function createTransport(signal?: AbortSignal) {
  const policy = new NodeUrlSafetyPolicy();
  const assertSafeUrl = (url: URL) => beforeAbort(policy.assertSafe(url),
    AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
  const pinnedFetch = createResolvingFetch();
  const secrets: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    // Request supplies standard body headers, including URLSearchParams' form content type.
    const request = new Request(input, { ...init, credentials: "omit", redirect: "manual" });
    const deadline = AbortSignal.any([request.signal, ...(signal ? [signal] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    deadline.throwIfAborted();
    for (const name of ["authorization", "poppy-session", "dpop"]) {
      const value = request.headers.get(name);
      if (value) {
        secrets.push(value);
        if (name === "authorization") secrets.push(value.replace(/^\S+\s+/, ""));
      }
    }
    if (init?.body instanceof URLSearchParams) {
      for (const name of ["client_assertion", "device_code", "refresh_token", "token"]) {
        const value = init.body.get(name);
        if (value) secrets.push(value);
      }
    }
    const body = request.body ? await beforeAbort(request.arrayBuffer(), deadline) : undefined;
    if (body && body.byteLength > MAX_REQUEST_BYTES) throw new Error("Poppy request exceeds Bell's size limit.");
    // Every Poppy request (discovery, OAuth, MCP) honors the provider's Retry-After, across tool calls.
    await beforePoppyRequest(request.url);
    const response = await beforeAbort(pinnedFetch(request.url, {
      method: request.method, headers: request.headers, body, signal: deadline, redirect: "manual", credentials: "omit",
    }), deadline);
    await afterPoppyResponse(request.url, response);
    let bytes = 0;
    const stream = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error("Poppy response exceeds Bell's size limit.");
        controller.enqueue(chunk);
      },
    }));
    return new Response(stream ?? null, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { fetch, secrets, assertSafeUrl };
}

export function createPoppyRuntime(identity: PoppyIdentity, stores: PoppySdkStores, signal?: AbortSignal) {
  const { fetch, secrets, assertSafeUrl } = createTransport(signal);
  const reactor = buildPapReactor({ fetch, assertSafeUrl }, [definePlugin({
    name: "bell-poppy-host", version: "1.0.0",
    contributes: [
      contribution(Signers, identity.signer),
      contribution(SessionSigners, identity.sessionSigner),
      contribution(TokenStores, stores.tokens),
      contribution(AuthorizationStateStores, stores.authorization),
    ],
  })]);
  const discovery: DiscoveryOptions = { reactor, fetch, signal, maxResponseBytes: MAX_RESPONSE_BYTES, timeoutMs: REQUEST_TIMEOUT_MS };
  return { reactor, fetch, discovery, secrets };
}

/**
 * MCP fetch for one server URL. The SDK transport signs each request, and after `session_ended`
 * starts one replacement Session (`session.restart()`) and resends; callers persist `session`.
 */
export function createSessionFetch(url: string, runtime: { reactor: ReactorPlatformView; fetch: typeof globalThis.fetch },
  session: PapSession, token?: AccessToken): typeof globalThis.fetch {
  const target = new URL(url);
  target.hash = "";
  if (target.protocol !== "https:") throw new Error("Bell sends Poppy credentials only over HTTPS.");
  if (token !== undefined && token.resource !== url) throw new Error("Bell sends an MCP token only to the server it was issued for.");
  const client = new SessionFetchClient({ reactor: runtime.reactor, fetch: runtime.fetch });
  return async (input, init) => {
    const request = new Request(input, init);
    const requested = new URL(request.url);
    requested.hash = "";
    if (requested.href !== target.href) throw new Error("Bell sends Poppy credentials only to the selected MCP URL.");
    const body = request.body ? await request.text() : undefined;
    return client.request(request.method, requested.href, {
      session, token, headers: Object.fromEntries(request.headers), body, ...(init?.signal ? { signal: init.signal } : {}),
    });
  };
}

export async function discoverPoppy(value: string, signal?: AbortSignal): Promise<DiscoveredCompany> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Poppy discovery requires a public HTTPS website on its standard port.");
  }
  const { fetch, assertSafeUrl } = createTransport(signal);
  const reactor = buildPapReactor({ fetch, assertSafeUrl });
  try {
    return await discoverCompany(url.hostname, {
      reactor, fetch, signal, maxResponseBytes: MAX_RESPONSE_BYTES, timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } finally {
    await reactor.stop();
  }
}
