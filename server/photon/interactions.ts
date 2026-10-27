import type { PhotonEventEnvelope } from "./contracts.js";
import { handleKey, normalizeHandle } from "./identity.js";
import type { ConversationState } from "./policy.js";
import type {
  InteractionInsert,
  InteractionRow,
  PhotonDb,
} from "./store.js";

/**
 * Durable pending-interaction correlation. An inbound event may resolve an
 * open poll contract, reaction contract, or prompt exactly once, and only
 * when the event's verified actor matches the contract's permitted actor.
 * A missing or mismatched actor leaves the event state-only — it can never
 * authorize an action (PRD §13, T-A05/T-M02).
 */

export interface InteractionMatch {
  /** Open interactions this event consumed (one-time resolution). */
  readonly resolved: readonly InteractionRow[];
  /** Whether a prompt/authorization input was resolved by this reply. */
  readonly promptResolved: boolean;
  /** Any durable contract (poll, reaction, prompt) resolved by this event. */
  readonly contractResolved: boolean;
  /** Eve requestRef of the resolved prompt input, when one resolved. */
  readonly promptRequestRef?: string;
}

const NO_MATCH: InteractionMatch = { resolved: [], promptResolved: false, contractResolved: false };

/** The verified acting handle for interaction purposes. */
function eventActor(envelope: PhotonEventEnvelope): string | undefined {
  const event = envelope.event;
  if (event.family === "message" && event.type === "received") {
    const sender = normalizeHandle(event.message.sender?.address);
    if (sender) return handleKey(sender);
  }
  return envelope.actor;
}

function generationMatches(interaction: InteractionRow, conversation?: ConversationState): boolean {
  return conversation === undefined || interaction.generation === conversation.generation;
}

function actorPermitted(interaction: InteractionRow, actor: string | undefined): boolean {
  if (!actor) return false;
  return interaction.permittedActor === undefined || interaction.permittedActor === actor;
}

/**
 * Finds open interactions in the event's chat that this admitted/state_only
 * event resolves, and settles each once. Poll votes match poll contracts by
 * `pollMessageGuid`; reactions match reaction contracts by target message;
 * an admitted text reply resolves an open prompt. Authorization requests
 * are deliberately NOT resolved here — they settle through their own
 * callback path (a chat reply is never an OAuth consent).
 */
export async function matchInboundToInteractions(
  db: PhotonDb,
  sourceId: string,
  envelope: PhotonEventEnvelope,
  conversation?: ConversationState,
): Promise<InteractionMatch> {
  const chatGuid = envelope.chatGuid;
  if (!chatGuid) return NO_MATCH;
  const actor = eventActor(envelope);
  // A missing actor can refresh state but can never resolve a contract.
  if (!actor) return NO_MATCH;
  const open = await db.openInteractions(sourceId, chatGuid);
  const resolved: InteractionRow[] = [];
  let promptResolved = false;
  let promptRequestRef: string | undefined;

  for (const interaction of open) {
    if (!generationMatches(interaction, conversation)) continue;
    if (!actorPermitted(interaction, actor)) continue;
    const resolution = resolutionFor(interaction, envelope, actor);
    if (!resolution) continue;
    const didResolve = await db.resolveInteraction(interaction.interactionId, actor, resolution);
    if (didResolve) {
      resolved.push(interaction);
      if (interaction.kind === "prompt" || interaction.kind === "authorization") {
        promptResolved = true;
        promptRequestRef = interaction.requestRef;
      }
    }
  }
  return { resolved, promptResolved, contractResolved: resolved.length > 0, promptRequestRef };
}

function resolutionFor(
  interaction: InteractionRow,
  envelope: PhotonEventEnvelope,
  actor: string | undefined,
): Record<string, unknown> | undefined {
  const event = envelope.event;
  const target = interaction.target ?? {};
  const mapping = interaction.responseMapping ?? {};

  if (interaction.kind === "poll") {
    if (event.family !== "poll" || event.type !== "voted" && event.type !== "unvoted") return undefined;
    if (target.pollMessageGuid !== event.pollMessageGuid) return undefined;
    if (event.type === "voted") {
      const allowed = mapping.optionIdentifiers;
      if (Array.isArray(allowed) && allowed.length > 0
        && !allowed.includes(event.delta.optionIdentifier)) return undefined;
    }
    return {
      kind: "poll", vote: event.type,
      optionIdentifier: event.delta.optionIdentifier,
      pollMessageGuid: event.pollMessageGuid,
      inboxSequence: envelope.sequence,
    };
  }

  if (interaction.kind === "reaction_contract") {
    if (event.family !== "message" || event.type !== "reactionAdded" && event.type !== "reactionRemoved") return undefined;
    if (target.messageGuid !== event.messageGuid) return undefined;
    if (event.type === "reactionRemoved") return { kind: "reaction_contract", removed: true, inboxSequence: envelope.sequence };
    const allowed = mapping.reactions;
    if (Array.isArray(allowed) && allowed.length > 0
      && !allowed.includes(event.reaction.kind) && !allowed.includes(event.reaction.emoji ?? "")) return undefined;
    return {
      kind: "reaction_contract",
      reaction: event.reaction,
      messageGuid: event.messageGuid,
      targetPartIndex: event.targetPartIndex ?? null,
      inboxSequence: envelope.sequence,
    };
  }

  if (interaction.kind === "prompt") {
    if (event.family !== "message" || event.type !== "received") return undefined;
    return {
      kind: "prompt",
      requestRef: interaction.requestRef,
      messageGuid: event.message.guid,
      inboxSequence: envelope.sequence,
      actor: actor ?? null,
    };
  }

  // authorization interactions never resolve from an inbound event.
  return undefined;
}

/** Registers one durable prompt interaction (idempotent by requestRef). */
export async function registerPromptInteraction(
  db: PhotonDb,
  input: InteractionInsert,
): Promise<string> {
  return db.createInteraction(input);
}

/** Expires open interactions past their deadline; returns the count. */
export async function expireSweep(db: PhotonDb, now: Date): Promise<number> {
  return db.expireInteractions(now);
}
