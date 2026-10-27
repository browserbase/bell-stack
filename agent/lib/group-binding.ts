import {
  getContextMetadataStore,
  type ContextMetadataFile,
} from "../../server/browser/context-metadata-store.js";
import { photonEnabled } from "../../server/photon/config.js";
import {
  type ConversationRow,
  type PhotonStore,
} from "../../server/photon/store.js";
import type { ToolContext } from "eve/tools";
import {
  verifiedMessagingPrincipal,
  type MessagingAudience,
} from "./messaging-auth";
import { getPhotonStore } from "./photon-store";
import { taskState } from "./task-state";

/**
 * Who may drive a group browser task. Derived from the verified messaging
 * principal of the current tool call; `audience` is the durable
 * conversation scope and `ownerId` the verified `photon:` principal id.
 * Sessions with no verified principal (web, eve, operator) carry no scope
 * and keep the existing shared behavior.
 */
export interface BrowserScope {
  readonly audience: MessagingAudience;
  readonly ownerId: string;
  readonly bindingId?: string;
}

/** Derives the browser scope for a tool call, or `undefined` for non-messaging sessions. */
export function browserScope(ctx: Pick<ToolContext, "session">): BrowserScope | undefined {
  const verified = verifiedMessagingPrincipal(ctx.session.auth?.current);
  if (!verified) return undefined;
  return {
    audience: verified.audience,
    ownerId: verified.principal.id,
    bindingId: verified.bindingId,
  };
}

export interface GroupBrowserBinding {
  ownerId: string;
  bindingId?: string;
  membershipVersion?: number;
}

/**
 * The durable conversation lookup is only needed (and only configured) when
 * the Photon channel is enabled. Web/eve/operator sessions never query it.
 * The store is the process-wide shared pool (agent/lib/photon-store.ts).
 */
function conversationStore(): PhotonStore | undefined {
  const databaseUrl = process.env.DATABASE_URL;
  if (!photonEnabled() || !databaseUrl) return undefined;
  return getPhotonStore({ databaseUrl });
}

async function findConversation(sessionId: string): Promise<ConversationRow | undefined> {
  const store = conversationStore();
  if (!store) return undefined;
  try {
    return await store.findConversationBySession(sessionId);
  } catch (error) {
    console.error(JSON.stringify({ event: "browser.group.conversation_lookup_failed", error: String(error) }));
    return undefined;
  }
}

/** A pending credential/human step that a membership bump must not silently complete. */
function pendingSensitiveStep(): boolean {
  const record = taskState.get();
  return record.status === "waiting_for_user" || record.status === "solving_captcha";
}

type PersistedGroupTask = NonNullable<ContextMetadataFile["groupBrowserTasks"]>[string];

/** One merged view of the three places group evidence can live. */
interface GroupState {
  /** Whether any group signal binds this session's browser work. */
  readonly isGroup: boolean;
  /** The durable conversation's initiating principal wins over the persisted task owner. */
  readonly ownerId?: string;
  readonly persisted?: PersistedGroupTask;
  readonly conversation?: ConversationRow;
}

/**
 * The single resolution both group policies share: merge the live tool-call
 * scope, the persisted task binding, and — whenever any group signal exists
 * (or `forceLookup`, e.g. before a runtime exists to mask one) — the durable
 * conversation row. `resolveGroupBinding` and `cancellationClosesBrowser`
 * are each a small policy over this state, never parallel re-derivations.
 */
async function resolveGroupState(
  sessionId: string,
  scope: BrowserScope | undefined,
  forceLookup = false,
): Promise<GroupState> {
  const persisted = await getContextMetadataStore().groupBrowserTask(sessionId);
  const conversation =
    forceLookup || persisted !== undefined || scope?.audience === "group"
      ? await findConversation(sessionId)
      : undefined;
  return {
    isGroup:
      scope?.audience === "group" || persisted !== undefined || conversation?.scope === "group",
    ownerId: conversation?.initiatingPrincipal ?? persisted?.ownerId,
    persisted,
    conversation,
  };
}

/**
 * Resolves whether this session's browser work belongs to a group member and
 * enforces the group contract:
 *
 * - Only a verified group principal may drive a group-bound session.
 * - The owner is `conversation.initiatingPrincipal` when the durable
 *   conversation provides it, else the first verified member to start browser
 *   work. A different member can never take over, snapshot or release it.
 * - A conversation membershipVersion bump since the task bound makes pending
 *   sensitive approvals stale: they fail and must be re-asserted.
 *
 * `hasRuntime` tells whether the session already has a live browser runtime —
 * a group session's first unscoped call is still detected before one exists.
 * Returns the binding for group sessions, `undefined` for everything else.
 */
export async function resolveGroupBinding(
  sessionId: string,
  scope: BrowserScope | undefined,
  hasRuntime: (sessionId: string) => boolean,
): Promise<GroupBrowserBinding | undefined> {
  const metadata = getContextMetadataStore();
  // Consult the durable conversation whenever we have a group signal, and once
  // opportunistically per runtime so a group session's first unscoped call is
  // still detected before a shared runtime can be created.
  const { isGroup, persisted, conversation, ownerId: boundOwner } = await resolveGroupState(
    sessionId, scope, !hasRuntime(sessionId),
  );
  if (!isGroup) return undefined;

  if (scope?.audience !== "group")
    throw new Error("This browser task belongs to a group member. Continue it from the verified group conversation.");
  const ownerId = boundOwner ?? scope.ownerId;
  if (scope.ownerId !== ownerId)
    throw new Error("Only the person who started this browser task may use it.");

  if (
    conversation && persisted?.membershipVersion !== undefined
    && conversation.membershipVersion !== persisted.membershipVersion
  ) {
    await metadata.bindGroupBrowserTask(sessionId, {
      ownerId,
      bindingId: conversation.bindingId,
      membershipVersion: conversation.membershipVersion,
    });
    if (pendingSensitiveStep())
      throw new Error("The group membership changed. The person who started this browser task must restart the pending step.");
  } else if (
    !persisted || persisted.ownerId !== ownerId
    || (conversation !== undefined && persisted.membershipVersion !== conversation.membershipVersion)
  ) {
    await metadata.bindGroupBrowserTask(sessionId, {
      ownerId,
      bindingId: conversation?.bindingId ?? persisted?.bindingId ?? scope.bindingId,
      membershipVersion: conversation?.membershipVersion,
    });
  }
  return {
    ownerId,
    bindingId: conversation?.bindingId ?? persisted?.bindingId ?? scope.bindingId,
    membershipVersion: conversation?.membershipVersion ?? persisted?.membershipVersion,
  };
}

/** Whether a caller's cancellation may close a group-bound browser task. */
export async function cancellationClosesBrowser(sessionId: string, scope?: BrowserScope): Promise<boolean> {
  const { isGroup, ownerId } = await resolveGroupState(sessionId, scope);
  if (!isGroup) return true;
  // With no bound owner there is no task to protect yet.
  return !ownerId || (scope?.audience === "group" && scope.ownerId === ownerId);
}
