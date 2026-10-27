import type { PhotonConfig } from "./config.js";
import type { AdmissionDecision, PhotonEventEnvelope, PhotonNormalizedEvent } from "./contracts.js";
import { handleKey, normalizeHandle, parseActorKey, type CanonicalHandle } from "./identity.js";

/**
 * Event admission and authorization policy. Pure functions over the verified
 * configuration and durable conversation state — no I/O, fully testable.
 */

export interface ConversationState {
  readonly bindingId?: string;
  readonly scope: "direct" | "group";
  readonly generation: number;
  readonly membership: readonly string[];
  readonly membershipVersion: number;
  readonly initiatingPrincipal?: string;
  readonly retiredAt?: string;
}

export function toConversationState(
  row: ConversationState | undefined,
  fallbackScope?: ConversationScope,
): ConversationState | undefined {
  if (!row && !fallbackScope) return undefined;
  return {
    bindingId: row?.bindingId,
    scope: row?.scope ?? fallbackScope ?? "direct",
    generation: row?.generation ?? 1,
    membership: row?.membership ?? [],
    membershipVersion: row?.membershipVersion ?? 0,
    initiatingPrincipal: row?.initiatingPrincipal,
    retiredAt: row?.retiredAt,
  };
}

/**
 * Computes the next group membership roster for a participant delta event,
 * or `undefined` when the event is not a membership delta or leaves the
 * roster unchanged.
 */
export function applyMembershipDelta(
  membership: readonly string[],
  event: PhotonNormalizedEvent,
): string[] | undefined {
  if (
    event.family !== "group" ||
    (event.type !== "participantAdded" &&
      event.type !== "participantRemoved" &&
      event.type !== "participantLeft")
  )
    return undefined;
  const handle = normalizeHandle(event.participant?.address);
  if (!handle) return undefined;
  const key = handleKey(handle);
  if (event.type === "participantAdded") {
    return membership.includes(key) ? undefined : [...membership, key];
  }
  return membership.includes(key) ? membership.filter((member) => member !== key) : undefined;
}

export function admitSender(config: PhotonConfig, handle: CanonicalHandle | null): boolean {
  if (!handle) return false;
  if (handle.kind === "phone") return config.allowedSenders.includes(handle.value);
  return config.allowedEmailSenders.includes(handle.value);
}

export function admitGroup(config: PhotonConfig, chatGuid: string | undefined): boolean {
  return !!chatGuid && config.allowedGroups.includes(chatGuid);
}

export type ConversationScope = "direct" | "group";

/**
 * The single scope classification every layer shares. A chat is a group
 * when EITHER the durable binding says so OR its guid is admitted via
 * `allowedGroups` — group evidence always wins, direct only when neither
 * applies. The precedence is deliberately asymmetric: a stored "direct"
 * binding can never demote a chat the allowlist now governs as a group,
 * and a retired binding's scope still describes the chat for its next
 * generation. Admission, dispatch gating and the internal route must all
 * resolve scope through this function — never re-spell the precedence.
 */
export function classifyScope(
  config: PhotonConfig,
  conversation: Pick<ConversationState, "scope"> | undefined,
  chatGuid: string | undefined,
): ConversationScope {
  if (conversation?.scope === "group") return "group";
  return admitGroup(config, chatGuid) ? "group" : "direct";
}

function denied(reason: string, updatesMembership = false): AdmissionDecision {
  return { disposition: "denied", reason, dispatchAction: "none", updatesMembership };
}

function stateOnly(reason: string, updatesMembership = false): AdmissionDecision {
  return { disposition: "state_only", reason, dispatchAction: "state_apply", updatesMembership };
}

/**
 * Decides the disposition of one normalized event. Self-origin events never
 * start agent turns; they may still update outbound reconciliation state.
 * An event without a verified actor can update state but cannot authorize
 * a tool call or pending interaction.
 */
export function admitEvent(
  config: PhotonConfig,
  envelope: PhotonEventEnvelope,
  conversation?: ConversationState,
): AdmissionDecision {
  const event = envelope.event;
  const chatGuid = envelope.chatGuid;
  const isGroup = classifyScope(config, conversation, chatGuid) === "group";

  // A bound group conversation whose chat lost admission is denied; the
  // allowlisted-guid-on-direct-conversation conflict is unreachable by
  // construction now that classifyScope is the single classifier.
  if (isGroup && !admitGroup(config, chatGuid)) return denied("group_not_admitted");

  const actor = parseActorKey(envelope.actor);

  switch (event.family) {
    case "message": {
      if (event.type === "received") {
        const message = event.message;
        if (message.isSystemMessage || message.isServiceMessage || message.itemType !== "normal")
          return denied("system_message");
        if (envelope.isFromMe || message.isFromMe || message.isAutoReply)
          return stateOnly("self_origin_echo");
        // A present destinationCallerId must agree with the verified managed
        // line; a foreign caller ID means the event crossed account scope.
        if (message.destinationCallerId !== undefined) {
          const caller = normalizeHandle(message.destinationCallerId);
          if (!caller || caller.kind !== "phone" || caller.value !== config.phoneNumber)
            return denied("destination_caller_mismatch");
        }
        const sender = normalizeHandle(message.sender?.address) ?? actor;
        if (!sender) return denied("sender_unverified");
        if (isGroup) {
          if (conversation?.membership.length && !conversation.membership.includes(handleKey(sender)))
            return denied("actor_not_in_membership");
          return { disposition: "admitted", reason: "group_message", dispatchAction: "send", actor: sender, scope: "group" };
        }
        if (!admitSender(config, sender)) return denied("sender_not_allowed");
        return { disposition: "admitted", reason: "direct_message", dispatchAction: "send", actor: sender, scope: "direct" };
      }
      if (event.type === "edited" || event.type === "unsent" || event.type === "read"
        || event.type === "reactionAdded" || event.type === "reactionRemoved"
        || event.type === "stickerPlaced") {
        if (envelope.isFromMe) return stateOnly("self_origin_mutation");
        if (isGroup) {
          if (actor && conversation?.membership.length && !conversation.membership.includes(handleKey(actor)))
            return stateOnly("non_member_actor_state_only", true);
          return stateOnly(`group_${event.type}`);
        }
        if (actor && !admitSender(config, actor)) return stateOnly("actor_not_allowed");
        return stateOnly(`direct_${event.type}`);
      }
      return denied("unsupported_message_variant");
    }
    case "chat":
      return stateOnly(`chat_${event.type}`);
    case "group": {
      if (event.type === "participantAdded" || event.type === "participantRemoved"
        || event.type === "participantLeft" || event.type === "displayNameChanged"
        || event.type === "iconChanged" || event.type === "iconRemoved")
        return stateOnly(`group_${event.type}`, true);
      return stateOnly("group_changed");
    }
    case "poll":
      if (event.type === "created" || event.type === "optionAdded")
        return stateOnly(`poll_${event.type}`);
      // Votes may resolve an explicit pending contract; the default stays state-only.
      return stateOnly(`poll_${event.type}`);
    case "location":
      return stateOnly("location_update");
    case "catchup":
      return stateOnly("catchup_complete_marker");
    default:
      return denied("unknown_family");
  }
}

/** Whether an admitted group actor may authorize sensitive tool execution. */
export function groupActorAuthorized(
  conversation: ConversationState,
  actor: CanonicalHandle | null,
): boolean {
  if (!actor) return false;
  return conversation.membership.length === 0 || conversation.membership.includes(handleKey(actor));
}

/** Sensitive operations must run in the verified private direct conversation. */
export function requiresPrivateContinuation(scope: "direct" | "group" | undefined): boolean {
  return scope !== "direct";
}
