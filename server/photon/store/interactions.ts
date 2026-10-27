import { sha256Hex } from "../identity.js";
import type { PhotonDb } from "../store.js";
import {
  mapInteraction,
  runQuery,
  type DbClient,
  type InteractionDbRow,
} from "./rows.js";

/**
 * Pending interactions — Eve input requests / authorization prompts an
 * inbound provider event may resolve. Interaction ids are deterministic so
 * a replayed upsert is a no-op.
 */
export function createInteractions(client: DbClient): Pick<
  PhotonDb,
  | "createInteraction"
  | "openInteractions"
  | "resolveInteraction"
  | "expireInteractions"
> {
  return {
    async createInteraction(input) {
      const interactionId = `int:${sha256Hex(JSON.stringify([input.sourceId, input.chatGuid, input.requestRef, input.kind]))}`;
      await runQuery(client,
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
      const result = await runQuery<InteractionDbRow>(client,
        `SELECT * FROM bell_photon_pending_interactions
           WHERE source_id = $1 AND chat_guid = $2 AND status = 'pending'
           ORDER BY created_at ASC`, [sourceId, chatGuid]);
      return result.map(mapInteraction);
    },

    async resolveInteraction(interactionId, actor, resolution) {
      const result = await runQuery(client,
        `UPDATE bell_photon_pending_interactions
           SET status = 'resolved', resolved_actor = $2, resolved_at = now(), resolution = $3::jsonb
         WHERE interaction_id = $1 AND status = 'pending'
         RETURNING interaction_id`,
        [interactionId, actor, JSON.stringify(resolution)]);
      return result.length === 1;
    },

    async expireInteractions(now) {
      const result = await runQuery(client,
        `UPDATE bell_photon_pending_interactions
           SET status = 'expired'
         WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $1
         RETURNING interaction_id`, [now]);
      return result.length;
    },
  };
}
