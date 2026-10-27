import type { ConnectionPrincipal } from "eve/connections";
import type { SessionAuthContext } from "eve/context";
import type { ToolContext } from "eve/tools";

/**
 * One shared verified-messaging/private-audience predicate for the private
 * Photon channel. Link, personal 1Password, vault guards and sensitive
 * tools must all evaluate the same contract instead of re-deriving it.
 */

export const PHOTON_AUTHENTICATOR = "photon-imessage";
export const PHOTON_ISSUER = "photon";
export const PHOTON_PRINCIPAL_PATTERN = /^photon:[0-9a-f]{8,128}$/;

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

function audienceOf(auth: SessionAuthContext): MessagingAudience | undefined {
  const value = auth.attributes[PHOTON_ATTR_AUDIENCE];
  const audience = Array.isArray(value) ? value[0] : value;
  return audience === "direct" || audience === "group" ? audience : undefined;
}

function attribute(auth: SessionAuthContext, key: string): string | undefined {
  const value = auth.attributes[key];
  const result = Array.isArray(value) ? value[0] : value;
  return typeof result === "string" && result.length > 0 ? result : undefined;
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
  if (auth?.principalType !== "user" || auth.authenticator !== PHOTON_AUTHENTICATOR
    || auth.issuer !== PHOTON_ISSUER || !PHOTON_PRINCIPAL_PATTERN.test(auth.principalId))
    return null;
  const audience = audienceOf(auth);
  if (!audience) return null;
  return {
    principal: { type: "user", id: auth.principalId, issuer: PHOTON_ISSUER },
    audience,
    chatGuid: attribute(auth, PHOTON_ATTR_CHAT),
    sourceId: attribute(auth, PHOTON_ATTR_SOURCE),
    bindingId: attribute(auth, PHOTON_ATTR_BINDING),
    subject: auth.subject,
  };
}

/** The verified principal for a tool call, or `null` when not messaging. */
export function messagingPrincipal(ctx: ToolContext): VerifiedMessagingPrincipal | null {
  return verifiedMessagingPrincipal(ctx.session.auth.current);
}

/** Whether the current session is a verified *private* (direct) Photon DM. */
export function isPrivateMessagingPrincipal(ctx: ToolContext): boolean {
  return messagingPrincipal(ctx)?.audience === "direct";
}

/**
 * Any Photon messaging principal — direct or group. Shared operator vaults,
 * reusable personal contexts and private continuations deny every one of
 * these identities; personal Link/1Password admit only the direct audience.
 */
export function isAnyMessagingPrincipal(ctx: ToolContext): boolean {
  return messagingPrincipal(ctx) !== null;
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
