import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import type {
  AdmissionDisposition,
  CommandStatus,
  PhotonCommand,
  PhotonCommandOp,
  PhotonEventEnvelope,
} from "./contracts.js";
import { sha256Hex } from "./identity.js";

/**
 * Typed facade over the Photon channel tables. Persistence is separate from
 * transport: callers pass already-normalized envelopes and commands; the
 * store enforces deduplication, claim fencing and ordering in SQL.
 */

export interface PhotonStore {
  readonly pool: Pool;
  withTransaction<T>(work: (db: PhotonDb) => Promise<T>): Promise<T>;
  close(): Promise<void>;

  /* sources */
  enrollSource(input: SourceEnrollment): Promise<SourceRow>;
  getSource(sourceId: string): Promise<SourceRow | undefined>;
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
  /** Next dispatchable rows in provider order for one conversation. */
  pendingForChat(sourceId: string, chatGuid: string, limit: number): Promise<InboxRow[]>;
  /** Dispatchable rows across chats (each chat is ordered independently). */
  pendingDispatch(sourceId: string, limit: number): Promise<InboxRow[]>;
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
  claimedBy?: string | null;
}

export type ResourceKind = "message" | "attachment" | "poll" | "miniapp_session" | "artifact" | "chat";

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

function rows<T extends QueryResultRow>(result: QueryResult<T>): T[] {
  return result.rows;
}

export function createPhotonStore(databaseUrl: string, poolSize = 6): PhotonStore {
  const pool = new Pool({ connectionString: databaseUrl, max: poolSize });

  async function query<T extends QueryResultRow>(
    client: PoolClient | Pool,
    text: string,
    values: readonly unknown[] = [],
  ): Promise<T[]> {
    return rows(await client.query<T>(text, [...values]));
  }

  function build(client: PoolClient | Pool): PhotonDb {
    return {
      /* ------------------------------ sources ------------------------------ */
      async enrollSource(input) {
        const result = await query<SourceRow & { source_id: string }>(client,
          `INSERT INTO bell_photon_sources
             (source_id, project_id, instance_id, account_scope, phone_number, endpoint, log_epoch)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (source_id) DO UPDATE SET
             phone_number = EXCLUDED.phone_number, endpoint = EXCLUDED.endpoint,
             updated_at = now()
           RETURNING *`,
          [input.sourceId, input.projectId, input.instanceId, input.accountScope,
            input.phoneNumber, input.endpoint, input.logEpoch]);
        return mapSource(result[0]);
      },

      async getSource(sourceId) {
        const result = await query(client,
          `SELECT * FROM bell_photon_sources WHERE source_id = $1`, [sourceId]);
        return result[0] ? mapSource(result[0]) : undefined;
      },

      async setSourceStatus(sourceId, status) {
        await query(client,
          `UPDATE bell_photon_sources SET status = $2, updated_at = now() WHERE source_id = $1`,
          [sourceId, status]);
      },

      async updateCaptureCursor(sourceId, cursor, coverage) {
        await query(client,
          `UPDATE bell_photon_sources
             SET capture_cursor = $2, coverage = COALESCE($3::jsonb, coverage), updated_at = now()
           WHERE source_id = $1`, [sourceId, cursor, coverage ? JSON.stringify(coverage) : null]);
      },

      async acquireLease(sourceId, ownerToken, leaseMs) {
        const result = await query<{ lease_epoch: string }>(client,
          `UPDATE bell_photon_sources
             SET owner_token = $2, lease_epoch = lease_epoch + 1,
                 lease_expires_at = now() + make_interval(secs => $3::float8 / 1000),
                 updated_at = now()
           WHERE source_id = $1
             AND (owner_token IS NULL OR owner_token = $2 OR lease_expires_at < now())
           RETURNING lease_epoch`,
          [sourceId, ownerToken, leaseMs]);
        if (result.length === 0) {
          const current = await this.getSource(sourceId);
          return { acquired: false, owner: current?.ownerToken } as const;
        }
        return { acquired: true, epoch: Number(result[0].lease_epoch) } as const;
      },

      async renewLease(sourceId, ownerToken, epoch, leaseMs) {
        const result = await query(client,
          `UPDATE bell_photon_sources
             SET lease_expires_at = now() + make_interval(secs => $4::float8 / 1000), updated_at = now()
           WHERE source_id = $1 AND owner_token = $2 AND lease_epoch = $3
           RETURNING source_id`,
          [sourceId, ownerToken, epoch, leaseMs]);
        return result.length === 1;
      },

      async releaseLease(sourceId, ownerToken, epoch) {
        await query(client,
          `UPDATE bell_photon_sources
             SET owner_token = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE source_id = $1 AND owner_token = $2 AND lease_epoch = $3`,
          [sourceId, ownerToken, epoch]);
      },

      async updateSourceHealth(sourceId, health) {
        await query(client,
          `UPDATE bell_photon_sources SET health = $2::jsonb, updated_at = now() WHERE source_id = $1`,
          [sourceId, JSON.stringify(health)]);
      },

      async updateCredentialExpiry(sourceId, expiresAt) {
        await query(client,
          `UPDATE bell_photon_sources SET credential_expires_at = $2, updated_at = now() WHERE source_id = $1`,
          [sourceId, expiresAt]);
      },

      /* ------------------------------- inbox ------------------------------- */
      async captureEvent(input) {
        const ref = { sourceId: input.sourceId, logEpoch: input.logEpoch, sequence: input.sequence };
        try {
          await query(client,
            `INSERT INTO bell_photon_inbox
               (source_id, log_epoch, sequence, sequence_num, payload_hash, envelope, tombstone,
                event_family, event_type, chat_guid, actor, target_guid, is_from_me,
                occurred_at, source_kind, disposition)
             VALUES ($1,$2,$3,$4::numeric,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [input.sourceId, input.logEpoch, input.sequence, input.sequenceNum,
              input.payloadHash, input.envelope ? JSON.stringify(input.envelope) : null,
              input.tombstone ?? false, input.eventFamily ?? null, input.eventType ?? null,
              input.chatGuid ?? null, input.actor ?? null, input.targetGuid ?? null,
              input.isFromMe ?? null, input.occurredAt ?? null, input.sourceKind,
              input.disposition ?? "pending"]);
          return { kind: "inserted", ref };
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "23505") throw error;
        }
        const existing = await this.getInboxRow(ref);
        if (existing && existing.payloadHash !== input.payloadHash)
          return { kind: "integrity_conflict", ref, existingHash: existing.payloadHash };
        return { kind: "duplicate", ref };
      },

      async getInboxRow(ref) {
        const result = await query(client,
          `SELECT * FROM bell_photon_inbox
             WHERE source_id = $1 AND log_epoch = $2 AND sequence = $3`,
          [ref.sourceId, ref.logEpoch, ref.sequence]);
        return result[0] ? mapInbox(result[0]) : undefined;
      },

      async updateDisposition(ref, disposition, lastError) {
        await query(client,
          `UPDATE bell_photon_inbox SET disposition = $4, last_error = COALESCE($5, last_error)
             WHERE source_id = $1 AND log_epoch = $2 AND sequence = $3`,
          [ref.sourceId, ref.logEpoch, ref.sequence, disposition, lastError ?? null]);
      },

      async markInboxProcessing(ref, state, lastError) {
        await query(client,
          `UPDATE bell_photon_inbox
             SET processing_state = $4, attempts = attempts + 1,
                 last_error = COALESCE($5, last_error)
             WHERE source_id = $1 AND log_epoch = $2 AND sequence = $3`,
          [ref.sourceId, ref.logEpoch, ref.sequence, state, lastError ?? null]);
      },

      async pendingForChat(sourceId, chatGuid, limit) {
        const result = await query(client,
          `SELECT * FROM bell_photon_inbox
             WHERE source_id = $1 AND chat_guid = $2 AND disposition = 'admitted'
               AND processing_state = 'captured'
             ORDER BY sequence_num ASC LIMIT $3`,
          [sourceId, chatGuid, limit]);
        return result.map(mapInbox);
      },

      async pendingDispatch(sourceId, limit) {
        const result = await query(client,
          `SELECT DISTINCT ON (chat_guid) * FROM bell_photon_inbox
             WHERE source_id = $1 AND disposition = 'admitted' AND processing_state = 'captured'
             ORDER BY chat_guid, sequence_num ASC LIMIT $2`,
          [sourceId, limit]);
        return result.map(mapInbox);
      },

      async dispatchableChatScopes(sourceId, limit) {
        const result = await query<{ chat_guid: string | null }>(client,
          `SELECT chat_guid, min(sequence_num) AS first_seq FROM bell_photon_inbox
             WHERE source_id = $1
               AND disposition IN ('admitted', 'state_only') AND processing_state = 'captured'
             GROUP BY chat_guid ORDER BY first_seq ASC NULLS LAST LIMIT $2`,
          [sourceId, limit]);
        return result.map((row) => row.chat_guid);
      },

      async dispatchableForChat(sourceId, chatGuid, limit) {
        const result = chatGuid === null
          ? await query(client,
            `SELECT * FROM bell_photon_inbox
               WHERE source_id = $1 AND chat_guid IS NULL
                 AND disposition = 'state_only' AND processing_state = 'captured'
               ORDER BY sequence_num ASC LIMIT $2`,
            [sourceId, limit])
          : await query(client,
            `SELECT * FROM bell_photon_inbox
               WHERE source_id = $1 AND chat_guid = $2
                 AND disposition IN ('admitted', 'state_only') AND processing_state = 'captured'
               ORDER BY sequence_num ASC LIMIT $3`,
            [sourceId, chatGuid, limit]);
        return result.map(mapInbox);
      },

      async maxSequenceNum(sourceId, logEpoch) {
        const result = await query<{ max: string | null }>(client,
          `SELECT max(sequence_num)::text AS max FROM bell_photon_inbox
             WHERE source_id = $1 AND log_epoch = $2`,
          [sourceId, logEpoch]);
        return result[0]?.max ?? undefined;
      },

      async activationBoundary(sourceId) {
        const result = await query<{ activation_boundary: string | null }>(client,
          `SELECT activation_boundary FROM bell_photon_sources WHERE source_id = $1`, [sourceId]);
        return result[0]?.activation_boundary ?? undefined;
      },

      async setActivationBoundary(sourceId, boundary) {
        await query(client,
          `UPDATE bell_photon_sources
             SET activation_boundary = COALESCE(activation_boundary, $2), updated_at = now()
           WHERE source_id = $1`, [sourceId, boundary]);
      },

      async inboxStats(sourceId) {
        const result = await query<{ pending: string; quarantined: string; oldest: string | null }>(client,
          `SELECT
             count(*) FILTER (WHERE disposition = 'admitted' AND processing_state = 'captured') AS pending,
             count(*) FILTER (WHERE processing_state = 'quarantined') AS quarantined,
             EXTRACT(EPOCH FROM (now() - min(received_at) FILTER (WHERE disposition = 'admitted' AND processing_state = 'captured'))) AS oldest
           FROM bell_photon_inbox WHERE source_id = $1`, [sourceId]);
        const row = result[0];
        return {
          pending: Number(row?.pending ?? 0),
          quarantined: Number(row?.quarantined ?? 0),
          oldestPendingAgeSec: row?.oldest === null || row?.oldest === undefined ? null : Number(row.oldest),
        };
      },

      /* --------------------------- conversations --------------------------- */
      async getConversation(sourceId, chatGuid) {
        const result = await query(client,
          `SELECT * FROM bell_photon_conversations
             WHERE source_id = $1 AND chat_guid = $2
             ORDER BY generation DESC LIMIT 1`, [sourceId, chatGuid]);
        return result[0] ? mapConversation(result[0]) : undefined;
      },

      async getConversationById(bindingId) {
        const result = await query(client,
          `SELECT * FROM bell_photon_conversations WHERE binding_id = $1`, [bindingId]);
        return result[0] ? mapConversation(result[0]) : undefined;
      },

      async upsertConversation(input) {
        const result = await query(client,
          `INSERT INTO bell_photon_conversations
             (binding_id, source_id, chat_guid, generation, scope, eve_address,
              eve_session_id, initiating_principal, membership)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT (binding_id) DO UPDATE SET
             membership = COALESCE(EXCLUDED.membership, bell_photon_conversations.membership),
             updated_at = now()
           RETURNING *`,
          [input.bindingId, input.sourceId, input.chatGuid, input.generation, input.scope,
            input.eveAddress, input.eveSessionId ?? null, input.initiatingPrincipal ?? null,
            input.membership ? JSON.stringify(input.membership) : null]);
        return mapConversation(result[0]);
      },

      async bindEveSession(bindingId, eveSessionId) {
        await query(client,
          `UPDATE bell_photon_conversations
             SET eve_session_id = $2, updated_at = now() WHERE binding_id = $1`,
          [bindingId, eveSessionId]);
      },

      async updateMembership(bindingId, membership) {
        await query(client,
          `UPDATE bell_photon_conversations
             SET membership = $2::jsonb, membership_version = membership_version + 1,
                 updated_at = now()
           WHERE binding_id = $1`,
          [bindingId, JSON.stringify(membership)]);
      },

      async touchConversation(bindingId) {
        await query(client,
          `UPDATE bell_photon_conversations SET last_turn_at = now(), updated_at = now()
             WHERE binding_id = $1`, [bindingId]);
      },

      async retireConversation(bindingId) {
        await query(client,
          `UPDATE bell_photon_conversations SET retired_at = now(), updated_at = now()
             WHERE binding_id = $1 AND retired_at IS NULL`, [bindingId]);
      },

      async activeConversations(sourceId) {
        const result = await query(client,
          `SELECT * FROM bell_photon_conversations
             WHERE source_id = $1 AND retired_at IS NULL
             ORDER BY created_at ASC`, [sourceId]);
        return result.map(mapConversation);
      },

      async findConversationBySession(eveSessionId) {
        const result = await query(client,
          `SELECT * FROM bell_photon_conversations WHERE eve_session_id = $1`, [eveSessionId]);
        return result[0] ? mapConversation(result[0]) : undefined;
      },

      /* --------------------------- dispatch intents ------------------------ */
      async upsertIntent(input) {
        const result = await query(client,
          `INSERT INTO bell_photon_dispatch_intents
             (intent_id, source_id, log_epoch, sequence, action, eve_session_id,
              dispatch_key, input_digest)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (dispatch_key) DO UPDATE SET intent_id = bell_photon_dispatch_intents.intent_id
           RETURNING *, (xmax = 0) AS inserted`,
          [input.intentId, input.sourceId, input.logEpoch, input.sequence, input.action,
            input.eveSessionId ?? null, input.dispatchKey, input.inputDigest]);
        return mapIntent(result[0]);
      },

      async getIntentByKey(dispatchKey) {
        const result = await query(client,
          `SELECT * FROM bell_photon_dispatch_intents WHERE dispatch_key = $1`, [dispatchKey]);
        return result[0] ? mapIntent(result[0]) : undefined;
      },

      async updateIntent(intentId, patch) {
        await query(client,
          `UPDATE bell_photon_dispatch_intents SET
             status = COALESCE($2, status),
             eve_session_id = COALESCE($3, eve_session_id),
             delivery_id = COALESCE($4, delivery_id),
             attempts = attempts + 1,
             last_error = COALESCE($5, last_error),
             updated_at = now()
           WHERE intent_id = $1`,
          [intentId, patch.status ?? null, patch.eveSessionId ?? null,
            patch.deliveryId ?? null, patch.lastError ?? null]);
      },

      async pendingIntents(sourceId, limit) {
        const result = await query(client,
          `SELECT i.* FROM bell_photon_dispatch_intents i
             JOIN bell_photon_inbox b
               ON b.source_id = i.source_id AND b.log_epoch = i.log_epoch AND b.sequence = i.sequence
           WHERE i.source_id = $1 AND i.status = 'pending'
           ORDER BY b.sequence_num ASC LIMIT $2`,
          [sourceId, limit]);
        return result.map(mapIntent);
      },

      /* ------------------------------ commands ----------------------------- */
      async enqueueCommand(command) {
        try {
          await query(client,
            `INSERT INTO bell_photon_commands
               (command_id, operation, args, args_digest, initiator_principal, audience,
                source_id, chat_guid, target, provider_key, semantic_key, depends_on, expires_at)
             VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
            [command.commandId, command.operation, JSON.stringify(command.args),
              command.argsDigest, command.initiatorPrincipal ?? null, command.audience ?? null,
              command.sourceId, command.chatGuid,
              command.target ? JSON.stringify(command.target) : null,
              command.providerKey ?? null, command.semanticKey, [...command.dependsOn],
              command.expiresAt ?? null]);
          return { commandId: command.commandId, deduplicated: false };
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "23505") {
            const existing = await this.getCommandBySemanticKey(command.semanticKey);
            if (existing) {
              if (existing.argsDigest !== command.argsDigest)
                throw new PhotonStoreError(
                  "semantic_key_conflict",
                  `semantic_key ${command.semanticKey} already exists with different arguments.`,
                );
              return { commandId: existing.commandId, deduplicated: true };
            }
          }
          throw error;
        }
      },

      async getCommand(commandId) {
        const result = await query(client,
          `SELECT * FROM bell_photon_commands WHERE command_id = $1`, [commandId]);
        return result[0] ? mapCommand(result[0]) : undefined;
      },

      async getCommandBySemanticKey(semanticKey) {
        const result = await query(client,
          `SELECT * FROM bell_photon_commands WHERE semantic_key = $1`, [semanticKey]);
        return result[0] ? mapCommand(result[0]) : undefined;
      },

      async claimCommands(workerId, limit, claimMs) {
        const result = await query(client,
          `WITH claimed AS (
             SELECT command_id FROM bell_photon_commands
             WHERE status = 'queued' AND next_attempt_at <= now()
             ORDER BY created_at ASC
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
           UPDATE bell_photon_commands c
             SET status = 'in_flight', claimed_by = $1,
                 claim_expires_at = now() + make_interval(secs => $3::float8 / 1000),
                 attempt_count = attempt_count + 1, updated_at = now()
           FROM claimed WHERE c.command_id = claimed.command_id
           RETURNING c.*`,
          [workerId, limit, claimMs]);
        return result.map(mapCommand);
      },

      async completeCommand(commandId, status, patch) {
        await query(client,
          `UPDATE bell_photon_commands SET
             status = $2,
             result = COALESCE($3::jsonb, result),
             provider_receipt = COALESCE($4::jsonb, provider_receipt),
             error_code = COALESCE($5, error_code),
             error_detail = COALESCE($6, error_detail),
             next_attempt_at = COALESCE($7, next_attempt_at),
             provider_key = COALESCE($8, provider_key),
             claimed_by = $9,
             updated_at = now()
           WHERE command_id = $1`,
          [commandId, status,
            patch.result === undefined ? null : JSON.stringify(patch.result),
            patch.providerReceipt === undefined ? null : JSON.stringify(patch.providerReceipt),
            patch.errorCode ?? null, patch.errorDetail ?? null,
            patch.nextAttemptAt ?? null, patch.providerKey ?? null,
            patch.claimedBy === undefined ? null : patch.claimedBy]);
      },

      async commandStats(sourceId) {
        const result = await query<{ queued: string; in_flight: string; ambiguous: string }>(client,
          `SELECT
             count(*) FILTER (WHERE status = 'queued') AS queued,
             count(*) FILTER (WHERE status = 'in_flight') AS in_flight,
             count(*) FILTER (WHERE status = 'ambiguous') AS ambiguous
           FROM bell_photon_commands WHERE source_id = $1`, [sourceId]);
        const row = result[0];
        return {
          queued: Number(row?.queued ?? 0),
          inFlight: Number(row?.in_flight ?? 0),
          ambiguous: Number(row?.ambiguous ?? 0),
        };
      },

      /* ------------------------------ resources ---------------------------- */
      async upsertResource(sourceId, kind, resourceId, data, opts) {
        await query(client,
          `INSERT INTO bell_photon_resources (source_id, kind, resource_id, data, tombstone)
           VALUES ($1,$2,$3,$4::jsonb,$5)
           ON CONFLICT (source_id, kind, resource_id) DO UPDATE SET
             data = EXCLUDED.data, tombstone = EXCLUDED.tombstone,
             revision = bell_photon_resources.revision + 1, updated_at = now()
           WHERE $6::integer IS NULL OR bell_photon_resources.revision = $6`,
          [sourceId, kind, resourceId, JSON.stringify(data), opts?.tombstone ?? false,
            opts?.expectedRevision ?? null]);
      },

      async getResource(sourceId, kind, resourceId) {
        const result = await query(client,
          `SELECT * FROM bell_photon_resources
             WHERE source_id = $1 AND kind = $2 AND resource_id = $3`,
          [sourceId, kind, resourceId]);
        return result[0] ? mapResource(result[0]) : undefined;
      },

      /* ------------------------------ artifacts ---------------------------- */
      async putArtifact(input) {
        const artifactId = `art:${sha256Hex(JSON.stringify([input.sourceId, input.chatGuid, Date.now(), input.data.byteLength]))}${Math.random().toString(36).slice(2, 10)}`;
        await query(client,
          `INSERT INTO bell_photon_artifacts
             (artifact_id, source_id, chat_guid, attachment_guid, file_name, media_type, byte_size, data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [artifactId, input.sourceId, input.chatGuid, input.attachmentGuid ?? null,
            input.fileName ?? null, input.mediaType, input.data.byteLength, Buffer.from(input.data)]);
        return artifactId;
      },

      async getArtifact(artifactId) {
        const result = await query(client,
          `SELECT artifact_id, source_id, chat_guid, attachment_guid, file_name,
                  media_type, byte_size, data, created_at
             FROM bell_photon_artifacts WHERE artifact_id = $1`, [artifactId]);
        const row = result[0];
        if (!row) return undefined;
        return {
          artifactId: row.artifact_id as string,
          sourceId: row.source_id as string,
          chatGuid: row.chat_guid as string,
          attachmentGuid: (row.attachment_guid as string | null) ?? undefined,
          fileName: (row.file_name as string | null) ?? undefined,
          mediaType: row.media_type as string,
          byteSize: Number(row.byte_size),
          data: row.data as Uint8Array,
          createdAt: row.created_at as Date,
        };
      },

      /* -------------------------- pending interactions --------------------- */
      async createInteraction(input) {
        const interactionId = `int:${sha256Hex(JSON.stringify([input.sourceId, input.chatGuid, input.requestRef, input.kind]))}`;
        await query(client,
          `INSERT INTO bell_photon_pending_interactions
             (interaction_id, source_id, binding_id, chat_guid, generation, kind, request_ref,
              permitted_actor, target, response_mapping, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
           ON CONFLICT (interaction_id) DO NOTHING`,
          [interactionId, input.sourceId, input.bindingId ?? null, input.chatGuid,
            input.generation ?? 1, input.kind, input.requestRef, input.permittedActor ?? null,
            JSON.stringify(input.target ?? {}), JSON.stringify(input.responseMapping ?? {}),
            input.expiresAt ?? null]);
        return interactionId;
      },

      async openInteractions(sourceId, chatGuid) {
        const result = await query(client,
          `SELECT * FROM bell_photon_pending_interactions
             WHERE source_id = $1 AND chat_guid = $2 AND status = 'pending'
             ORDER BY created_at ASC`, [sourceId, chatGuid]);
        return result.map(mapInteraction);
      },

      async resolveInteraction(interactionId, actor, resolution) {
        const result = await query(client,
          `UPDATE bell_photon_pending_interactions
             SET status = 'resolved', resolved_actor = $2, resolved_at = now(), resolution = $3::jsonb
           WHERE interaction_id = $1 AND status = 'pending'
           RETURNING interaction_id`,
          [interactionId, actor, JSON.stringify(resolution)]);
        return result.length === 1;
      },

      async expireInteractions(now) {
        const result = await query(client,
          `UPDATE bell_photon_pending_interactions
             SET status = 'expired'
           WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $1
           RETURNING interaction_id`, [now]);
        return result.length;
      },

      /* --------------------------- projector offsets ------------------------ */
      async getProjectorOffset(sourceId, eveSessionId) {
        const result = await query(client,
          `SELECT * FROM bell_photon_projector_offsets
             WHERE source_id = $1 AND eve_session_id = $2`, [sourceId, eveSessionId]);
        const row = result[0];
        return row ? {
          sourceId: row.source_id as string,
          eveSessionId: row.eve_session_id as string,
          streamPosition: Number(row.stream_position),
          materializedKeys: (row.materialized_keys as string[]) ?? [],
          updatedAt: row.updated_at as Date,
        } : undefined;
      },

      async advanceProjector(input) {
        await query(client,
          `INSERT INTO bell_photon_projector_offsets
             (source_id, eve_session_id, stream_position, materialized_keys)
           VALUES ($1,$2,$3,$4::jsonb)
           ON CONFLICT (source_id, eve_session_id) DO UPDATE SET
             stream_position = GREATEST(bell_photon_projector_offsets.stream_position, EXCLUDED.stream_position),
             materialized_keys = EXCLUDED.materialized_keys,
             updated_at = now()`,
          [input.sourceId, input.eveSessionId, input.streamPosition,
            JSON.stringify(input.materializedKeys)]);
      },

      /* --------------------------- session deadlines ------------------------ */
      async registerDeadline(eveSessionId, bindingId, deadlineAt) {
        await query(client,
          `INSERT INTO bell_photon_session_deadlines (eve_session_id, binding_id, deadline_at)
           VALUES ($1,$2,$3)
           ON CONFLICT (eve_session_id) DO NOTHING`,
          [eveSessionId, bindingId ?? null, deadlineAt]);
      },

      async dueDeadlines(now, limit) {
        const result = await query(client,
          `SELECT * FROM bell_photon_session_deadlines
             WHERE retired_at IS NULL AND deadline_at <= $1
             ORDER BY deadline_at ASC LIMIT $2`, [now, limit]);
        return result.map(mapDeadline);
      },

      async markDeadlineRetired(eveSessionId, reason) {
        await query(client,
          `UPDATE bell_photon_session_deadlines
             SET retired_at = now(), retirement_reason = $2
           WHERE eve_session_id = $1 AND retired_at IS NULL`,
          [eveSessionId, reason]);
      },

      async getDeadline(eveSessionId) {
        const result = await query(client,
          `SELECT * FROM bell_photon_session_deadlines WHERE eve_session_id = $1`, [eveSessionId]);
        return result[0] ? mapDeadline(result[0]) : undefined;
      },
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

/* ------------------------------------------------------------------ */
/* Row mappers                                                         */
/* ------------------------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapSource(row: any): SourceRow {
  return {
    sourceId: row.source_id, projectId: row.project_id, instanceId: row.instance_id,
    accountScope: row.account_scope, phoneNumber: row.phone_number, endpoint: row.endpoint,
    logEpoch: row.log_epoch,
    activationBoundary: row.activation_boundary ?? undefined,
    captureCursor: row.capture_cursor ?? undefined,
    coverage: row.coverage ?? {}, ownerToken: row.owner_token ?? undefined,
    leaseEpoch: Number(row.lease_epoch),
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    credentialExpiresAt: row.credential_expires_at ?? undefined,
    health: row.health ?? {}, status: row.status,
  };
}

function mapInbox(row: any): InboxRow {
  return {
    sourceId: row.source_id, logEpoch: row.log_epoch, sequence: row.sequence,
    sequenceNum: String(row.sequence_num), payloadHash: row.payload_hash,
    envelope: row.envelope ?? undefined, tombstone: row.tombstone,
    eventFamily: row.event_family ?? undefined, eventType: row.event_type ?? undefined,
    chatGuid: row.chat_guid ?? undefined, actor: row.actor ?? undefined,
    targetGuid: row.target_guid ?? undefined, isFromMe: row.is_from_me ?? undefined,
    occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : undefined,
    receivedAt: new Date(row.received_at).toISOString(),
    sourceKind: row.source_kind, disposition: row.disposition,
    processingState: row.processing_state, attempts: row.attempts,
    lastError: row.last_error ?? undefined,
  };
}

function mapConversation(row: any): ConversationRow {
  return {
    bindingId: row.binding_id, sourceId: row.source_id, chatGuid: row.chat_guid,
    generation: row.generation, scope: row.scope, eveAddress: row.eve_address,
    eveSessionId: row.eve_session_id ?? undefined,
    initiatingPrincipal: row.initiating_principal ?? undefined,
    membershipVersion: row.membership_version,
    membership: row.membership ?? [],
    lastTurnAt: row.last_turn_at ? new Date(row.last_turn_at).toISOString() : undefined,
    retiredAt: row.retired_at ? new Date(row.retired_at).toISOString() : undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapIntent(row: any): IntentRow {
  return {
    intentId: row.intent_id, sourceId: row.source_id, logEpoch: row.log_epoch,
    sequence: row.sequence, action: row.action, eveSessionId: row.eve_session_id ?? undefined,
    dispatchKey: row.dispatch_key, inputDigest: row.input_digest,
    status: row.status, deliveryId: row.delivery_id ?? undefined,
    attempts: row.attempts, lastError: row.last_error ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapCommand(row: any): CommandRow {
  return {
    commandId: row.command_id, operation: row.operation, args: row.args ?? {},
    argsDigest: row.args_digest, initiatorPrincipal: row.initiator_principal ?? undefined,
    audience: row.audience ?? undefined, sourceId: row.source_id, chatGuid: row.chat_guid,
    target: row.target ?? undefined, providerKey: row.provider_key ?? undefined,
    semanticKey: row.semantic_key, dependsOn: row.depends_on ?? [],
    status: row.status, attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at, claimedBy: row.claimed_by ?? undefined,
    result: row.result ?? undefined, providerReceipt: row.provider_receipt ?? undefined,
    errorCode: row.error_code ?? undefined, errorDetail: row.error_detail ?? undefined,
    expiresAt: row.expires_at ?? undefined, createdAt: row.created_at,
  };
}

function mapResource(row: any): ResourceRow {
  return {
    sourceId: row.source_id, kind: row.kind, resourceId: row.resource_id,
    data: row.data ?? {}, revision: row.revision, tombstone: row.tombstone,
    updatedAt: row.updated_at,
  };
}

function mapInteraction(row: any): InteractionRow {
  return {
    interactionId: row.interaction_id, sourceId: row.source_id,
    bindingId: row.binding_id ?? undefined, chatGuid: row.chat_guid,
    generation: row.generation, kind: row.kind, requestRef: row.request_ref,
    permittedActor: row.permitted_actor ?? undefined,
    target: row.target ?? {}, responseMapping: row.response_mapping ?? {},
    status: row.status, resolvedActor: row.resolved_actor ?? undefined,
    resolvedAt: row.resolved_at ?? undefined, resolution: row.resolution ?? undefined,
    createdAt: row.created_at,
  };
}

function mapDeadline(row: any): DeadlineRow {
  return {
    eveSessionId: row.eve_session_id, bindingId: row.binding_id ?? undefined,
    deadlineAt: row.deadline_at, retiredAt: row.retired_at ?? undefined,
    retirementReason: row.retirement_reason ?? undefined,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
