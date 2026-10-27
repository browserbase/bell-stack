import { createHash } from "node:crypto";

import type { SessionAuthContext } from "eve/context";

/**
 * The one principal-id contract. Verified Photon principals are `photon:` +
 * a hex digest — every consumer of a caller-supplied principal (link
 * ownership, credential vaults, message auth) shares this check so the
 * format can never silently diverge between verifiers.
 *
 * This module is intentionally import-free (no `.js` relative imports): the
 * Next.js bundle reaches it through server/link and server/onepassword, and
 * Turbopack does not remap `.js` extensions to `.ts` sources. Keep it a leaf.
 */

export const PHOTON_AUTHENTICATOR = "photon-imessage";
export const PHOTON_ISSUER = "photon";
export const PHOTON_PRINCIPAL_TYPE = "user";
export const IDENTITY_VERSION = "v1";

export const PHOTON_PRINCIPAL_PATTERN = /^photon:[0-9a-f]{8,128}$/;

export function isVerifiedPhotonPrincipal(
  principal: { readonly type: string; readonly issuer?: string; readonly id?: string },
): principal is { readonly type: "user"; readonly issuer: string; readonly id: string } {
  return (
    principal.type === PHOTON_PRINCIPAL_TYPE
    && principal.issuer === PHOTON_ISSUER
    && typeof principal.id === "string"
    && PHOTON_PRINCIPAL_PATTERN.test(principal.id)
  );
}

export function isPhotonAuth(
  auth: Pick<SessionAuthContext, "authenticator" | "issuer"> | null | undefined,
): boolean {
  return auth?.authenticator === PHOTON_AUTHENTICATOR && auth.issuer === PHOTON_ISSUER;
}

/**
 * The full session-auth check — the `SessionAuthContext`-shaped variant of
 * `isVerifiedPhotonPrincipal` above. Field names differ (principalType /
 * principalId) but the contract is identical, and it adds the authenticator
 * the principal shape alone cannot assert.
 */
export function isVerifiedPhotonAuth(
  auth: SessionAuthContext | null | undefined,
): auth is SessionAuthContext {
  return (
    auth?.principalType === PHOTON_PRINCIPAL_TYPE
    && auth.authenticator === PHOTON_AUTHENTICATOR
    && auth.issuer === PHOTON_ISSUER
    && PHOTON_PRINCIPAL_PATTERN.test(auth.principalId)
  );
}

/**
 * Shallow identity-tuple serializer — array order and scalar values only.
 * For deep canonical serialization of provider payloads see `stableJson`
 * in normalize.ts; the names are deliberately distinct.
 */
export function canonicalTupleJson(value: readonly unknown[]): string {
  return JSON.stringify(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
