import type { PhotonConfig } from "./config.js";
import type { AdmissionDecision, PhotonEventEnvelope } from "./contracts.js";
import { handleKey, normalizeHandle, type CanonicalHandle } from "./identity.js";

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

export function admitSender(config: PhotonConfig, handle: CanonicalHandle | null): boolean {
  if (!handle) return false;
  if (handle.kind === "phone") return config.allowedSenders.includes(handle.value);
  return config.allowedEmailSenders.includes(handle.value);
}

export function admitGroup(config: PhotonConfig, chatGuid: string | undefined): boolean {
  return !!chatGuid && config.allowedGroups.includes(chatGuid);
}

function actorHandle(envelope: PhotonEventEnvelope): CanonicalHandle | null {
  const actor = envelope.actor;
  if (!actor) return null;
  const separator = actor.indexOf(":");
  if (separator <= 0) return null;
  const kind = actor.slice(0, separator);
  const value = actor.slice(separator + 1);
  if (kind !== "phone" && kind !== "email") return null;
  return normalizeHandle(value);
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
  const isGroup = conversation?.scope === "group" || chatGuid !== undefined && config.allowedGroups.includes(chatGuid);

  if (isGroup && !admitGroup(config, chatGuid)) return denied("group_not_admitted");
  if (!isGroup && chatGuid !== undefined && config.allowedGroups.includes(chatGuid))
    return denied("group_scope_conflict");

  const actor = actorHandle(envelope);

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
