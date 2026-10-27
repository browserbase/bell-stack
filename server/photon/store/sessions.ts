import type { PhotonDb } from "../store.js";
import {
  mapDeadline,
  mapProjector,
  runQuery,
  type DbClient,
  type DeadlineDbRow,
  type ProjectorDbRow,
} from "./rows.js";

/**
 * Eve-side session bookkeeping: per-(source, session) projector offsets and
 * the deadline table that retires stale sessions.
 */
export function createSessions(client: DbClient): Pick<
  PhotonDb,
  | "getProjectorOffset"
  | "advanceProjector"
  | "registerDeadline"
  | "dueDeadlines"
  | "markDeadlineRetired"
  | "getDeadline"
> {
  return {
    async getProjectorOffset(sourceId, eveSessionId) {
      const result = await runQuery<ProjectorDbRow>(client,
        `SELECT * FROM bell_photon_projector_offsets
           WHERE source_id = $1 AND eve_session_id = $2`, [sourceId, eveSessionId]);
      return result[0] ? mapProjector(result[0]) : undefined;
    },

    async advanceProjector(input) {
      await runQuery(client,
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

    async registerDeadline(eveSessionId, bindingId, deadlineAt) {
      await runQuery(client,
        `INSERT INTO bell_photon_session_deadlines (eve_session_id, binding_id, deadline_at)
         VALUES ($1,$2,$3)
         ON CONFLICT (eve_session_id) DO NOTHING`,
        [eveSessionId, bindingId ?? null, deadlineAt]);
    },

    async dueDeadlines(now, limit) {
      const result = await runQuery<DeadlineDbRow>(client,
        `SELECT * FROM bell_photon_session_deadlines
           WHERE retired_at IS NULL AND deadline_at <= $1
           ORDER BY deadline_at ASC LIMIT $2`, [now, limit]);
      return result.map(mapDeadline);
    },

    async markDeadlineRetired(eveSessionId, reason) {
      await runQuery(client,
        `UPDATE bell_photon_session_deadlines
           SET retired_at = now(), retirement_reason = $2
         WHERE eve_session_id = $1 AND retired_at IS NULL`,
        [eveSessionId, reason]);
    },

    async getDeadline(eveSessionId) {
      const result = await runQuery<DeadlineDbRow>(client,
        `SELECT * FROM bell_photon_session_deadlines WHERE eve_session_id = $1`, [eveSessionId]);
      return result[0] ? mapDeadline(result[0]) : undefined;
    },
  };
}
