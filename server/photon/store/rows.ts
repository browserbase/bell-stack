import type { PoolClient, Pool, QueryResultRow } from "pg";

import type {
  AdmissionDisposition,
  CommandStatus,
  PhotonCommandOp,
  PhotonEventEnvelope,
} from "../contracts.js";
import type {
  ArtifactRef,
  ArtifactRow,
  CommandRow,
  ConversationRow,
  DeadlineRow,
  InboxProcessing,
  InboxRow,
  IntentRow,
  InteractionRow,
  ProjectorRow,
  ResourceKind,
  ResourceRow,
  SourceRow,
  SourceStatus,
} from "../store.js";

/**
 * Typed persistence rows for the Photon channel tables — one interface per
 * aggregate so the mappers below never see `any`. Column types follow the
 * node-postgres defaults: numeric/bigint read back as text, timestamptz as
 * Date, jsonb as parsed JSON, bytea as Buffer.
 */

export type DbClient = PoolClient | Pool;

export async function runQuery<T extends QueryResultRow>(
  client: DbClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, [...values])).rows;
}

/** True for Postgres unique-violation errors (SQLSTATE 23505). */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "23505";
}

export interface SourceDbRow extends QueryResultRow {
  source_id: string;
  project_id: string;
  instance_id: string;
  account_scope: string;
  phone_number: string;
  endpoint: string;
  log_epoch: string;
  activation_boundary: string | null;
  capture_cursor: string | null;
  coverage: Record<string, unknown> | null;
  owner_token: string | null;
  lease_epoch: string | number;
  lease_expires_at: Date | null;
  credential_expires_at: Date | null;
  health: Record<string, unknown> | null;
  status: SourceStatus;
}

export function mapSource(row: SourceDbRow): SourceRow {
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

export interface InboxDbRow extends QueryResultRow {
  source_id: string;
  log_epoch: string;
  sequence: string;
  sequence_num: string;
  payload_hash: string;
  envelope: PhotonEventEnvelope | null;
  tombstone: boolean;
  event_family: string | null;
  event_type: string | null;
  chat_guid: string | null;
  actor: string | null;
  target_guid: string | null;
  is_from_me: boolean | null;
  occurred_at: Date | string | null;
  received_at: Date | string;
  source_kind: "live" | "catchup";
  disposition: AdmissionDisposition | "pending";
  processing_state: InboxProcessing;
  attempts: number;
  last_error: string | null;
}

export function mapInbox(row: InboxDbRow): InboxRow {
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

export interface ConversationDbRow extends QueryResultRow {
  binding_id: string;
  source_id: string;
  chat_guid: string;
  generation: number;
  scope: "direct" | "group";
  eve_address: string;
  eve_session_id: string | null;
  initiating_principal: string | null;
  membership_version: number;
  membership: string[] | null;
  last_turn_at: Date | string | null;
  retired_at: Date | string | null;
  created_at: Date | string;
}

export function mapConversation(row: ConversationDbRow): ConversationRow {
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

export interface IntentDbRow extends QueryResultRow {
  intent_id: string;
  source_id: string;
  log_epoch: string;
  sequence: string;
  action: "send" | "respond" | "state_apply";
  eve_session_id: string | null;
  dispatch_key: string;
  input_digest: string;
  status: "pending" | "accepted" | "ambiguous" | "rejected" | "quarantined";
  delivery_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date | string;
}

export function mapIntent(row: IntentDbRow): IntentRow {
  return {
    intentId: row.intent_id, sourceId: row.source_id, logEpoch: row.log_epoch,
    sequence: row.sequence, action: row.action, eveSessionId: row.eve_session_id ?? undefined,
    dispatchKey: row.dispatch_key, inputDigest: row.input_digest,
    status: row.status, deliveryId: row.delivery_id ?? undefined,
    attempts: row.attempts, lastError: row.last_error ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export interface CommandDbRow extends QueryResultRow {
  command_id: string;
  operation: PhotonCommandOp;
  args: Record<string, unknown> | null;
  args_digest: string;
  initiator_principal: string | null;
  audience: "direct" | "group" | "system" | null;
  source_id: string;
  chat_guid: string;
  target: Record<string, unknown> | null;
  provider_key: string | null;
  semantic_key: string;
  depends_on: string[] | null;
  status: CommandStatus;
  attempt_count: number;
  next_attempt_at: Date;
  claimed_by: string | null;
  result: unknown;
  provider_receipt: unknown;
  error_code: string | null;
  error_detail: string | null;
  expires_at: Date | null;
  created_at: Date;
}

export function mapCommand(row: CommandDbRow): CommandRow {
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

export interface ResourceDbRow extends QueryResultRow {
  source_id: string;
  kind: ResourceKind;
  resource_id: string;
  data: Record<string, unknown> | null;
  revision: number;
  tombstone: boolean;
  updated_at: Date;
}

export function mapResource(row: ResourceDbRow): ResourceRow {
  return {
    sourceId: row.source_id, kind: row.kind, resourceId: row.resource_id,
    data: row.data ?? {}, revision: row.revision, tombstone: row.tombstone,
    updatedAt: row.updated_at,
  };
}

export interface ArtifactDbRow extends QueryResultRow {
  artifact_id: string;
  source_id: string;
  chat_guid: string;
  attachment_guid: string | null;
  file_name: string | null;
  media_type: string;
  byte_size: number | string;
  created_at: Date;
}

export interface ArtifactDataDbRow extends ArtifactDbRow {
  data: Uint8Array;
}

export function mapArtifactRef(row: ArtifactDbRow): ArtifactRef {
  return {
    artifactId: row.artifact_id,
    sourceId: row.source_id,
    chatGuid: row.chat_guid,
    attachmentGuid: row.attachment_guid ?? undefined,
    fileName: row.file_name ?? undefined,
    mediaType: row.media_type,
    byteSize: Number(row.byte_size),
  };
}

export function mapArtifact(row: ArtifactDataDbRow): ArtifactRow {
  return { ...mapArtifactRef(row), data: row.data, createdAt: row.created_at };
}

export interface InteractionDbRow extends QueryResultRow {
  interaction_id: string;
  source_id: string;
  binding_id: string | null;
  chat_guid: string;
  generation: number;
  kind: "prompt" | "authorization" | "poll" | "reaction_contract";
  request_ref: string;
  permitted_actor: string | null;
  target: Record<string, unknown> | null;
  response_mapping: Record<string, unknown> | null;
  status: "pending" | "resolved" | "expired" | "cancelled";
  resolved_actor: string | null;
  resolved_at: Date | null;
  resolution: Record<string, unknown> | null;
  created_at: Date;
}

export function mapInteraction(row: InteractionDbRow): InteractionRow {
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

export interface ProjectorDbRow extends QueryResultRow {
  source_id: string;
  eve_session_id: string;
  stream_position: number | string;
  materialized_keys: string[] | null;
  updated_at: Date;
}

export function mapProjector(row: ProjectorDbRow): ProjectorRow {
  return {
    sourceId: row.source_id,
    eveSessionId: row.eve_session_id,
    streamPosition: Number(row.stream_position),
    materializedKeys: row.materialized_keys ?? [],
    updatedAt: row.updated_at,
  };
}

export interface DeadlineDbRow extends QueryResultRow {
  eve_session_id: string;
  binding_id: string | null;
  deadline_at: Date;
  retired_at: Date | null;
  retirement_reason: string | null;
}

export function mapDeadline(row: DeadlineDbRow): DeadlineRow {
  return {
    eveSessionId: row.eve_session_id, bindingId: row.binding_id ?? undefined,
    deadlineAt: row.deadline_at, retiredAt: row.retired_at ?? undefined,
    retirementReason: row.retirement_reason ?? undefined,
  };
}
