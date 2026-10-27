import { Pool, type PoolClient } from "pg";

import type {
  AdmissionDisposition,
  CommandStatus,
  PhotonCommand,
  PhotonCommandOp,
  PhotonEventEnvelope,
} from "./contracts.js";
import { createCommands } from "./store/commands.js";
import { createConversations } from "./store/conversations.js";
import { createInbox } from "./store/inbox.js";
import { createInteractions } from "./store/interactions.js";
import { createResources } from "./store/resources.js";
import { createSessions } from "./store/sessions.js";
import { createSources } from "./store/sources.js";

/**
 * Typed facade over the Photon channel tables. Persistence is separate from
 * transport: callers pass already-normalized envelopes and commands; the
 * store enforces deduplication, claim fencing and ordering in SQL. The
 * implementation is split by aggregate under ./store/ — this facade keeps
 * the contract and row shapes in one place.
 */
export interface PhotonStore {
  readonly pool: Pool;
  withTransaction<T>(work: (db: PhotonDb) => Promise<T>): Promise<T>;
  close(): Promise<void>;

  /* sources */
  enrollSource(input: SourceEnrollment): Promise<SourceRow>;
  getSource(sourceId: string): Promise<SourceRow | undefined>;
  /** Most recently touched source of a project (health-route probe). */
  getLatestSource(projectId: string): Promise<SourceRow | undefined>;
  setSourceStatus(sourceId: string, status: SourceStatus): Promise<void>;
  updateCaptureCursor(sourceId: string, cursor: string, coverage?: Record<string, unknown>): Promise<void>;
  acquireLease(sourceId: string, ownerToken: string, leaseMs: number): Promise<LeaseResult>;
  renewLease(sourceId: string, ownerToken: string, epoch: number, leaseMs: number): Promise<boolean>;
  releaseLease(sourceId: string, ownerToken: string, epoch: number): Promise<void>;
  updateSourceHealth(sourceId: string, health: Record<string, unknown>): Promise<void>;
  updateCredentialExpiry(sourceId: string, expiresAt: Date): Promise<void>;

  /* inbox */
  captureEvent(input: InboxInsert): Promise<InboxCapture>;
  getInboxRow(ref: InboxRef): Promise<InboxRow | undefined>;
  updateDisposition(ref: InboxRef, disposition: AdmissionDisposition, lastError?: string): Promise<void>;
  markInboxProcessing(ref: InboxRef, state: InboxProcessing, lastError?: string): Promise<void>;
  /**
   * Chat scopes (chat_guid, or null for chat-less state events) holding
   * captured admitted/state_only inbox rows, oldest pending row first.
   */
  dispatchableChatScopes(sourceId: string, limit: number): Promise<(string | null)[]>;
  /**
   * Captured admitted/state_only rows for one scope in provider order.
   * A null chatGuid covers chat-less rows (state_only by construction).
   */
  dispatchableForChat(sourceId: string, chatGuid: string | null, limit: number): Promise<InboxRow[]>;
  maxSequenceNum(sourceId: string, logEpoch: string): Promise<string | undefined>;
  activationBoundary(sourceId: string): Promise<string | undefined>;
  setActivationBoundary(sourceId: string, boundary: string): Promise<void>;
  inboxStats(sourceId: string): Promise<{ pending: number; quarantined: number; oldestPendingAgeSec: number | null }>;

  /* conversations */
  getConversation(sourceId: string, chatGuid: string): Promise<ConversationRow | undefined>;
  getConversationById(bindingId: string): Promise<ConversationRow | undefined>;
  upsertConversation(input: ConversationUpsert): Promise<ConversationRow>;
  bindEveSession(bindingId: string, eveSessionId: string): Promise<void>;
  updateMembership(bindingId: string, membership: readonly string[]): Promise<void>;
  touchConversation(bindingId: string): Promise<void>;
  retireConversation(bindingId: string): Promise<void>;
  /** All non-retired bindings for a source (used by projection and deadline sweep). */
  activeConversations(sourceId: string): Promise<ConversationRow[]>;
  findConversationBySession(eveSessionId: string): Promise<ConversationRow | undefined>;

  /* dispatch intents */
  upsertIntent(input: IntentInsert): Promise<IntentRow>;
  getIntentByKey(dispatchKey: string): Promise<IntentRow | undefined>;
  updateIntent(intentId: string, patch: IntentPatch): Promise<void>;
  pendingIntents(sourceId: string, limit: number): Promise<IntentRow[]>;

  /* commands */
  enqueueCommand(command: PhotonCommand): Promise<{ commandId: string; deduplicated: boolean }>;
  getCommand(commandId: string): Promise<CommandRow | undefined>;
  getCommandBySemanticKey(semanticKey: string): Promise<CommandRow | undefined>;
  claimCommands(workerId: string, limit: number, claimMs: number): Promise<CommandRow[]>;
  completeCommand(commandId: string, status: CommandStatus, patch: CommandPatch): Promise<void>;
  commandStats(sourceId: string): Promise<{ queued: number; inFlight: number; ambiguous: number }>;

  /* resources */
  upsertResource(sourceId: string, kind: ResourceKind, resourceId: string, data: Record<string, unknown>, opts?: { tombstone?: boolean; expectedRevision?: number }): Promise<void>;
  getResource(sourceId: string, kind: ResourceKind, resourceId: string): Promise<ResourceRow | undefined>;

  /* artifacts */
  putArtifact(input: ArtifactInsert): Promise<string>;
  getArtifact(artifactId: string): Promise<ArtifactRow | undefined>;
  /** Newest artifact staged for a provider attachment in one conversation — metadata only. */
  findArtifactByAttachment(sourceId: string, chatGuid: string, attachmentGuid: string): Promise<ArtifactRef | undefined>;

  /* pending interactions */
  createInteraction(input: InteractionInsert): Promise<string>;
  openInteractions(sourceId: string, chatGuid: string): Promise<InteractionRow[]>;
  resolveInteraction(interactionId: string, actor: string, resolution: Record<string, unknown>): Promise<boolean>;
  expireInteractions(now: Date): Promise<number>;

  /* projector offsets */
  getProjectorOffset(sourceId: string, eveSessionId: string): Promise<ProjectorRow | undefined>;
  advanceProjector(input: ProjectorAdvance): Promise<void>;

  /* session deadlines */
  registerDeadline(eveSessionId: string, bindingId: string | undefined, deadlineAt: Date): Promise<void>;
  dueDeadlines(now: Date, limit: number): Promise<DeadlineRow[]>;
  markDeadlineRetired(eveSessionId: string, reason: string): Promise<void>;
  getDeadline(eveSessionId: string): Promise<DeadlineRow | undefined>;
}

export type PhotonDb = Omit<PhotonStore, "pool" | "withTransaction" | "close">;

/* ------------------------------------------------------------------ */
/* Row types                                                           */
/* ------------------------------------------------------------------ */

export type SourceStatus = "pending" | "active" | "suspended" | "retired";

export interface SourceRow {
  sourceId: string;
  projectId: string;
  instanceId: string;
  accountScope: string;
  phoneNumber: string;
  endpoint: string;
  logEpoch: string;
  activationBoundary?: string;
  captureCursor?: string;
  coverage: Record<string, unknown>;
  ownerToken?: string;
  leaseEpoch: number;
  leaseExpiresAt?: Date;
  credentialExpiresAt?: Date;
  health: Record<string, unknown>;
  status: SourceStatus;
}

export interface SourceEnrollment {
  sourceId: string;
  projectId: string;
  instanceId: string;
  accountScope: string;
  phoneNumber: string;
  endpoint: string;
  logEpoch: string;
}

export type LeaseResult =
  | { readonly acquired: true; readonly epoch: number }
  | { readonly acquired: false; readonly owner?: string };

export interface InboxRef {
  sourceId: string;
  logEpoch: string;
  sequence: string;
}

export interface InboxInsert extends InboxRef {
  sequenceNum: string;
  payloadHash: string;
  envelope?: PhotonEventEnvelope;
  tombstone?: boolean;
  eventFamily?: string;
  eventType?: string;
  chatGuid?: string;
  actor?: string;
  targetGuid?: string;
  isFromMe?: boolean;
  occurredAt?: string;
  sourceKind: "live" | "catchup";
  disposition?: AdmissionDisposition;
}

export type InboxProcessing = "captured" | "dispatched" | "settled" | "failed" | "quarantined";

export type InboxCapture =
  | { readonly kind: "inserted"; readonly ref: InboxRef }
  | { readonly kind: "duplicate"; readonly ref: InboxRef }
  | { readonly kind: "integrity_conflict"; readonly ref: InboxRef; readonly existingHash: string };

export interface InboxRow extends InboxRef {
  sequenceNum: string;
  payloadHash: string;
  envelope?: PhotonEventEnvelope;
  tombstone: boolean;
  eventFamily?: string;
  eventType?: string;
  chatGuid?: string;
  actor?: string;
  targetGuid?: string;
  isFromMe?: boolean;
  occurredAt?: string;
  receivedAt: string;
  sourceKind: "live" | "catchup";
  disposition: AdmissionDisposition | "pending";
  processingState: InboxProcessing;
  attempts: number;
  lastError?: string;
}

export interface ConversationUpsert {
  bindingId: string;
  sourceId: string;
  chatGuid: string;
  generation: number;
  scope: "direct" | "group";
  eveAddress: string;
  eveSessionId?: string;
  initiatingPrincipal?: string;
  membership?: readonly string[];
}

export interface ConversationRow {
  bindingId: string;
  sourceId: string;
  chatGuid: string;
  generation: number;
  scope: "direct" | "group";
  eveAddress: string;
  eveSessionId?: string;
  initiatingPrincipal?: string;
  membershipVersion: number;
  membership: string[];
  lastTurnAt?: string;
  retiredAt?: string;
  createdAt: string;
}

export interface IntentInsert extends InboxRef {
  intentId: string;
  action: "send" | "respond" | "state_apply";
  eveSessionId?: string;
  dispatchKey: string;
  inputDigest: string;
}

export interface IntentPatch {
  status?: "pending" | "accepted" | "ambiguous" | "rejected" | "quarantined";
  eveSessionId?: string;
  deliveryId?: string;
  lastError?: string;
}

export interface IntentRow extends IntentInsert {
  status: "pending" | "accepted" | "ambiguous" | "rejected" | "quarantined";
  deliveryId?: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
}

export interface CommandRow {
  commandId: string;
  operation: PhotonCommandOp;
  args: Record<string, unknown>;
  argsDigest: string;
  initiatorPrincipal?: string;
  audience?: "direct" | "group" | "system";
  sourceId: string;
  chatGuid: string;
  target?: Record<string, unknown>;
  providerKey?: string;
  semanticKey: string;
  dependsOn: string[];
  status: CommandStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  claimedBy?: string;
  result?: unknown;
  providerReceipt?: unknown;
  errorCode?: string;
  errorDetail?: string;
  expiresAt?: Date;
  createdAt: Date;
}

export interface CommandPatch {
  result?: unknown;
  providerReceipt?: unknown;
  errorCode?: string;
  errorDetail?: string;
  nextAttemptAt?: Date;
  providerKey?: string;
  /**
   * Unlike the COALESCE'd fields above, claimed_by is always overwritten:
   * settling a command releases the claim so a row is never left attributed
   * to a worker that no longer owns it.
   */
  claimedBy?: string;
}

/**
 * The canonical resource-kind list — deliberately the only one. The table
 * carries no CHECK constraint (a duplicated list already diverged once), so
 * this union is the contract every upsertResource/getResource call site is
 * type-checked against. `miniapp_session_by_message` is the message-guid ->
 * card-session index the tool layer updates through. Raw bytes live in
 * bell_photon_artifacts via putArtifact, never in a resource row.
 */
export type ResourceKind =
  | "message"
  | "attachment"
  | "poll"
  | "miniapp_session"
  | "miniapp_session_by_message"
  | "chat";

export interface ResourceRow {
  sourceId: string;
  kind: ResourceKind;
  resourceId: string;
  data: Record<string, unknown>;
  revision: number;
  tombstone: boolean;
  updatedAt: Date;
}

export interface ArtifactInsert {
  sourceId: string;
  chatGuid: string;
  attachmentGuid?: string;
  fileName?: string;
  mediaType: string;
  data: Uint8Array;
}

/** Artifact metadata without loading the stored bytes. */
export interface ArtifactRef {
  artifactId: string;
  sourceId: string;
  chatGuid: string;
  attachmentGuid?: string;
  fileName?: string;
  mediaType: string;
  byteSize: number;
}

export interface ArtifactRow extends ArtifactInsert {
  artifactId: string;
  byteSize: number;
  createdAt: Date;
}

export interface InteractionInsert {
  sourceId: string;
  bindingId?: string;
  chatGuid: string;
  generation?: number;
  kind: "prompt" | "authorization" | "poll" | "reaction_contract";
  requestRef: string;
  permittedActor?: string;
  target?: Record<string, unknown>;
  responseMapping?: Record<string, unknown>;
  expiresAt?: Date;
}

export interface InteractionRow extends InteractionInsert {
  interactionId: string;
  status: "pending" | "resolved" | "expired" | "cancelled";
  resolvedActor?: string;
  resolvedAt?: Date;
  resolution?: Record<string, unknown>;
  createdAt: Date;
}

export interface ProjectorAdvance {
  sourceId: string;
  eveSessionId: string;
  streamPosition: number;
  materializedKeys: readonly string[];
}

export interface ProjectorRow extends ProjectorAdvance {
  updatedAt: Date;
}

export interface DeadlineRow {
  eveSessionId: string;
  bindingId?: string;
  deadlineAt: Date;
  retiredAt?: Date;
  retirementReason?: string;
}

/* ------------------------------------------------------------------ */
/* Implementation                                                      */
/* ------------------------------------------------------------------ */

export function createPhotonStore(databaseUrl: string, poolSize = 6): PhotonStore {
  const pool = new Pool({ connectionString: databaseUrl, max: poolSize });

  function build(client: PoolClient | Pool): PhotonDb {
    return {
      ...createSources(client),
      ...createInbox(client),
      ...createConversations(client),
      ...createCommands(client),
      ...createResources(client),
      ...createInteractions(client),
      ...createSessions(client),
    };
  }

  const facade: PhotonStore = {
    pool,
    ...build(pool),
    async withTransaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(build(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
  return facade;
}

export class PhotonStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PhotonStoreError";
    this.code = code;
  }
}
