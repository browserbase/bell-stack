import type { PhotonDb } from "../store.js";
import { mapConversation, runQuery, type ConversationDbRow, type DbClient } from "./rows.js";

/**
 * Conversation bindings — one durable binding row per (source, chat,
 * generation) carrying the Eve session, scope, initiating principal and
 * group membership snapshot.
 */
export function createConversations(client: DbClient): Pick<
  PhotonDb,
  | "getConversation"
  | "getConversationById"
  | "upsertConversation"
  | "bindEveSession"
  | "updateMembership"
  | "touchConversation"
  | "retireConversation"
  | "activeConversations"
  | "findConversationBySession"
> {
  return {
    async getConversation(sourceId, chatGuid) {
      const result = await runQuery<ConversationDbRow>(client,
        `SELECT * FROM bell_photon_conversations
           WHERE source_id = $1 AND chat_guid = $2
           ORDER BY generation DESC LIMIT 1`, [sourceId, chatGuid]);
      return result[0] ? mapConversation(result[0]) : undefined;
    },

    async getConversationById(bindingId) {
      const result = await runQuery<ConversationDbRow>(client,
        `SELECT * FROM bell_photon_conversations WHERE binding_id = $1`, [bindingId]);
      return result[0] ? mapConversation(result[0]) : undefined;
    },

    async upsertConversation(input) {
      const result = await runQuery<ConversationDbRow>(client,
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
      await runQuery(client,
        `UPDATE bell_photon_conversations
           SET eve_session_id = $2, updated_at = now() WHERE binding_id = $1`,
        [bindingId, eveSessionId]);
    },

    async updateMembership(bindingId, membership) {
      await runQuery(client,
        `UPDATE bell_photon_conversations
           SET membership = $2::jsonb, membership_version = membership_version + 1,
               updated_at = now()
         WHERE binding_id = $1`,
        [bindingId, JSON.stringify(membership)]);
    },

    async touchConversation(bindingId) {
      await runQuery(client,
        `UPDATE bell_photon_conversations SET last_turn_at = now(), updated_at = now()
           WHERE binding_id = $1`, [bindingId]);
    },

    async retireConversation(bindingId) {
      await runQuery(client,
        `UPDATE bell_photon_conversations SET retired_at = now(), updated_at = now()
           WHERE binding_id = $1 AND retired_at IS NULL`, [bindingId]);
    },

    async activeConversations(sourceId) {
      const result = await runQuery<ConversationDbRow>(client,
        `SELECT * FROM bell_photon_conversations
           WHERE source_id = $1 AND retired_at IS NULL
           ORDER BY created_at ASC`, [sourceId]);
      return result.map(mapConversation);
    },

    async findConversationBySession(eveSessionId) {
      const result = await runQuery<ConversationDbRow>(client,
        `SELECT * FROM bell_photon_conversations WHERE eve_session_id = $1`, [eveSessionId]);
      return result[0] ? mapConversation(result[0]) : undefined;
    },
  };
}
