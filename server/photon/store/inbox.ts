import type {
  InboxRow,
  IntentInsert,
  IntentPatch,
  IntentRow,
  PhotonDb,
} from "../store.js";
import {
  isUniqueViolation,
  mapInbox,
  mapIntent,
  runQuery,
  type DbClient,
  type InboxDbRow,
  type IntentDbRow,
} from "./rows.js";

/**
 * Durable inbox + dispatch intents. The inbox captures normalized provider
 * events exactly once per (source, epoch, sequence); intents hold one
 * durable delivery record per dispatchable row so a crash mid-request
 * resumes without duplicating.
 */
export function createInbox(client: DbClient): Pick<
  PhotonDb,
  | "captureEvent"
  | "getInboxRow"
  | "updateDisposition"
  | "markInboxProcessing"
  | "dispatchableChatScopes"
  | "dispatchableForChat"
  | "maxSequenceNum"
  | "inboxStats"
  | "upsertIntent"
  | "getIntentByKey"
  | "updateIntent"
  | "pendingIntents"
> {
  async function getInboxRow(ref: {
    sourceId: string; logEpoch: string; sequence: string;
  }): Promise<InboxRow | undefined> {
    const result = await runQuery<InboxDbRow>(client,
      `SELECT * FROM bell_photon_inbox
         WHERE source_id = $1 AND log_epoch = $2 AND sequence = $3`,
      [ref.sourceId, ref.logEpoch, ref.sequence]);
    return result[0] ? mapInbox(result[0]) : undefined;
  }

  return {
    async captureEvent(input) {
      const ref = { sourceId: input.sourceId, logEpoch: input.logEpoch, sequence: input.sequence };
      try {
        await runQuery(client,
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
        if (!isUniqueViolation(error)) throw error;
      }
      const existing = await getInboxRow(ref);
      if (existing && existing.payloadHash !== input.payloadHash)
        return { kind: "integrity_conflict", ref, existingHash: existing.payloadHash };
      return { kind: "duplicate", ref };
    },

    getInboxRow,

    async updateDisposition(ref, disposition, lastError) {
      await runQuery(client,
        `UPDATE bell_photon_inbox SET disposition = $4, last_error = COALESCE($5, last_error)
           WHERE source_id = $1 AND log_epoch = $2 AND sequence = $3`,
        [ref.sourceId, ref.logEpoch, ref.sequence, disposition, lastError ?? null]);
    },

    async markInboxProcessing(ref, state, lastError) {
      await runQuery(client,
        `UPDATE bell_photon_inbox
           SET processing_state = $4, attempts = attempts + 1,
               last_error = COALESCE($5, last_error)
           WHERE source_id = $1 AND log_epoch = $2 AND sequence = $3`,
        [ref.sourceId, ref.logEpoch, ref.sequence, state, lastError ?? null]);
    },

    async dispatchableChatScopes(sourceId, limit) {
      const result = await runQuery<{ chat_guid: string | null }>(client,
        `SELECT chat_guid, min(sequence_num) AS first_seq FROM bell_photon_inbox
           WHERE source_id = $1
             AND disposition IN ('admitted', 'state_only') AND processing_state = 'captured'
           GROUP BY chat_guid ORDER BY first_seq ASC NULLS LAST LIMIT $2`,
        [sourceId, limit]);
      return result.map((row) => row.chat_guid);
    },

    async dispatchableForChat(sourceId, chatGuid, limit) {
      const result = chatGuid === null
        ? await runQuery<InboxDbRow>(client,
          `SELECT * FROM bell_photon_inbox
             WHERE source_id = $1 AND chat_guid IS NULL
               AND disposition = 'state_only' AND processing_state = 'captured'
             ORDER BY sequence_num ASC LIMIT $2`,
          [sourceId, limit])
        : await runQuery<InboxDbRow>(client,
          `SELECT * FROM bell_photon_inbox
             WHERE source_id = $1 AND chat_guid = $2
               AND disposition IN ('admitted', 'state_only') AND processing_state = 'captured'
             ORDER BY sequence_num ASC LIMIT $3`,
          [sourceId, chatGuid, limit]);
      return result.map(mapInbox);
    },

    async maxSequenceNum(sourceId, logEpoch) {
      const result = await runQuery<{ max: string | null }>(client,
        `SELECT max(sequence_num)::text AS max FROM bell_photon_inbox
           WHERE source_id = $1 AND log_epoch = $2`,
        [sourceId, logEpoch]);
      return result[0]?.max ?? undefined;
    },

    async inboxStats(sourceId) {
      const result = await runQuery<{ pending: string; quarantined: string; oldest: string | null }>(client,
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

    /* --------------------------- dispatch intents ------------------------ */
    async upsertIntent(input: IntentInsert) {
      const result = await runQuery<IntentDbRow>(client,
        `INSERT INTO bell_photon_dispatch_intents
           (intent_id, source_id, log_epoch, sequence, action, eve_session_id,
            dispatch_key, input_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (dispatch_key) DO UPDATE SET intent_id = bell_photon_dispatch_intents.intent_id
         RETURNING *`,
        [input.intentId, input.sourceId, input.logEpoch, input.sequence, input.action,
          input.eveSessionId ?? null, input.dispatchKey, input.inputDigest]);
      return mapIntent(result[0]);
    },

    async getIntentByKey(dispatchKey) {
      const result = await runQuery<IntentDbRow>(client,
        `SELECT * FROM bell_photon_dispatch_intents WHERE dispatch_key = $1`, [dispatchKey]);
      return result[0] ? mapIntent(result[0]) : undefined;
    },

    async updateIntent(intentId, patch: IntentPatch) {
      await runQuery(client,
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

    async pendingIntents(sourceId, limit): Promise<IntentRow[]> {
      const result = await runQuery<IntentDbRow>(client,
        `SELECT i.* FROM bell_photon_dispatch_intents i
           JOIN bell_photon_inbox b
             ON b.source_id = i.source_id AND b.log_epoch = i.log_epoch AND b.sequence = i.sequence
         WHERE i.source_id = $1 AND i.status = 'pending'
         ORDER BY b.sequence_num ASC LIMIT $2`,
        [sourceId, limit]);
      return result.map(mapIntent);
    },
  };
}
