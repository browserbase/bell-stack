import type { ConnectionPrincipal } from "eve/connections";
import type { SessionAuthContext } from "eve/context";
import type { ToolContext } from "eve/tools";

import {
  PHOTON_ISSUER,
  isVerifiedPhotonAuth,
} from "../../server/photon/principal.js";

/**
 * One shared verified-messaging/private-audience predicate for the private
 * Photon channel. Link, personal 1Password, vault guards and sensitive
 * tools must all evaluate the same contract instead of re-deriving it.
 * The principal contract itself lives in server/photon/principal.ts — the
 * single source every verifier shares.
 */

/** Session auth attribute keys stamped by the channel's dispatch route. */
export const PHOTON_ATTR_AUDIENCE = "photon:audience";
export const PHOTON_ATTR_CHAT = "photon:chat";
export const PHOTON_ATTR_SOURCE = "photon:source";
export const PHOTON_ATTR_BINDING = "photon:binding";

export type MessagingAudience = "direct" | "group";

export interface VerifiedMessagingPrincipal {
  readonly principal: Extract<ConnectionPrincipal, { type: "user" }>;
  readonly audience: MessagingAudience;
  /** Provider chat GUID bound to this session, when stamped. */
  readonly chatGuid?: string;
  /** Enrolled provider source identity, when stamped. */
  readonly sourceId?: string;
  /** Durable conversation binding row identity, when stamped. */
  readonly bindingId?: string;
  /** The verified handle the principal maps to (`phone:+...` / `email:...`). */
  readonly subject?: string;
}

/** Reads a single-valued photon session auth attribute. */
export function photonAttribute(
  auth: Pick<SessionAuthContext, "attributes">,
  key: string,
): string | undefined {
  const value = auth.attributes[key];
  const result = Array.isArray(value) ? value[0] : value;
  return typeof result === "string" && result.length > 0 ? result : undefined;
}

function audienceOf(auth: SessionAuthContext): MessagingAudience | undefined {
  const audience = photonAttribute(auth, PHOTON_ATTR_AUDIENCE);
  return audience === "direct" || audience === "group" ? audience : undefined;
}

/**
 * Returns the verified Photon messaging principal for the current session
 * auth, or `null` for every non-Photon or malformed identity. Issuer and
 * principal shape are both checked; the audience attribute must classify
 * the conversation as direct or group.
 */
export function verifiedMessagingPrincipal(
  auth: SessionAuthContext | null | undefined,
): VerifiedMessagingPrincipal | null {
  if (!isVerifiedPhotonAuth(auth)) return null;
  const audience = audienceOf(auth);
  if (!audience) return null;
  return {
    principal: { type: "user", id: auth.principalId, issuer: PHOTON_ISSUER },
    audience,
    chatGuid: photonAttribute(auth, PHOTON_ATTR_CHAT),
    sourceId: photonAttribute(auth, PHOTON_ATTR_SOURCE),
    bindingId: photonAttribute(auth, PHOTON_ATTR_BINDING),
    subject: auth.subject,
  };
}

/** The verified principal for a tool call, or `null` when not messaging. */
export function messagingPrincipal(ctx: Pick<ToolContext, "session">): VerifiedMessagingPrincipal | null {
  return verifiedMessagingPrincipal(ctx.session.auth?.current);
}

/**
 * The immutable owner allowed to complete a sensitive pending action in the
 * current conversation. Group sessions bind the first initiating principal;
 * a different participant's message never transfers that ownership.
 */
export function assertInitiatingOwner(
  ctx: ToolContext,
  initiatingPrincipal: string | undefined,
): VerifiedMessagingPrincipal {
  const verified = messagingPrincipal(ctx);
  if (!verified) throw new Error("A verified messaging principal is required.");
  if (initiatingPrincipal && verified.principal.id !== initiatingPrincipal)
    throw new Error("Only the user who started this action may complete it.");
  return verified;
}
