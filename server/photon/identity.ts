import { createHash } from "node:crypto";

import type { SessionAuthContext } from "eve/context";

import { E164_PATTERN } from "./config.js";

export const PHOTON_AUTHENTICATOR = "photon-imessage";
export const PHOTON_ISSUER = "photon";
export const PHOTON_PRINCIPAL_TYPE = "user";
export const IDENTITY_VERSION = "v1";

/** Canonical handle identities used throughout the channel. */
export type CanonicalHandle =
  | { readonly kind: "phone"; readonly value: string }
  | { readonly kind: "email"; readonly value: string };

/**
 * Normalizes a provider handle to Bell's canonical identity form. Phone
 * handles must be valid E.164. Email handles are lowercased and trimmed;
 * the provider treats them case-insensitively for delivery. Returns `null`
 * for anything else — never fabricate a required identity field.
 */
export function normalizeHandle(raw: string | null | undefined): CanonicalHandle | null {
  const value = raw?.trim();
  if (!value) return null;
  if (E164_PATTERN.test(value)) return { kind: "phone", value };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320)
    return { kind: "email", value: value.toLowerCase() };
  return null;
}

export function handleKey(handle: CanonicalHandle): string {
  return `${handle.kind}:${handle.value}`;
}

export function canonicalJson(value: readonly unknown[]): string {
  return JSON.stringify(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Bell's raw-SDK principal identity: `photon:` + sha256 of the versioned
 * canonical tuple (project, handle kind, canonical handle). The receiving
 * line is deliberately excluded so moving a verified handle between
 * explicitly admitted lines in one project keeps one wallet owner.
 */
export function photonPrincipalId(projectId: string, handle: CanonicalHandle): string {
  return `photon:${sha256Hex(canonicalJson([IDENTITY_VERSION, projectId, handle.kind, handle.value]))}`;
}

/** Builds the Eve session principal for a verified Photon event actor. */
export function photonSessionAuth(
  projectId: string,
  handle: CanonicalHandle,
  attributes: Readonly<Record<string, string | readonly string[]>> = {},
): SessionAuthContext {
  return {
    attributes,
    authenticator: PHOTON_AUTHENTICATOR,
    issuer: PHOTON_ISSUER,
    principalId: photonPrincipalId(projectId, handle),
    principalType: PHOTON_PRINCIPAL_TYPE,
    subject: handleKey(handle),
  };
}

export function isPhotonAuth(auth: Pick<SessionAuthContext, "authenticator" | "issuer"> | null | undefined): boolean {
  return auth?.authenticator === PHOTON_AUTHENTICATOR && auth.issuer === PHOTON_ISSUER;
}

/** Stable source binding identity for one enrolled (project, instance, line). */
export function sourceIdFor(projectId: string, instanceId: string, phoneNumber: string): string {
  return `photon-src:${sha256Hex(canonicalJson([IDENTITY_VERSION, projectId, instanceId, phoneNumber]))}`;
}

/**
 * Canonical conversation identity: versioned tuple of source, provider chat
 * GUID and generation. Chats are never reconstructed from a sender number.
 */
export function conversationKey(sourceId: string, chatGuid: string, generation: number): string {
  return canonicalJson([IDENTITY_VERSION, sourceId, chatGuid, generation]);
}

export function bindingIdFor(sourceId: string, chatGuid: string, generation: number): string {
  return `photon-bind:${sha256Hex(conversationKey(sourceId, chatGuid, generation))}`;
}

/** Channel-local continuation address for `from(address)` operations. */
export function eveAddressFor(bindingId: string): string {
  return `photon:${bindingId}`;
}

/** Deterministic dispatch key within Eve's 256-character idempotency limit. */
export function dispatchKeyFor(
  sourceId: string,
  logEpoch: string,
  sequence: string,
  action: string,
): string {
  const key = `photon:${action}:${sourceId}:${logEpoch}:${sequence}`;
  return key.length <= 256 ? key : `photon:${action}:${sha256Hex(key)}`;
}

/** Deterministic provider idempotency key (`clientMessageId`) for a command. */
export function providerKeyFor(commandId: string, attempt: number): string {
  return `bell:${commandId}:${attempt}`;
}

/**
 * Semantic output key for an outgoing command derived from logical identity:
 * session, turn, step, output kind/part, request and tool-call identities.
 */
export function semanticKeyFor(parts: {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly step?: string | number;
  readonly outputKind: string;
  readonly partId?: string;
  readonly requestId?: string;
  readonly toolCallId?: string;
  readonly commandId?: string;
}): string {
  const raw = canonicalJson([
    "v1",
    parts.sessionId ?? null,
    parts.turnId ?? null,
    parts.step ?? null,
    parts.outputKind,
    parts.partId ?? null,
    parts.requestId ?? null,
    parts.toolCallId ?? null,
    parts.commandId ?? null,
  ]);
  const key = `photon-out:${raw}`;
  return key.length <= 512 ? key : `photon-out:${sha256Hex(raw)}`;
}
