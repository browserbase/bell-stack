import { sha256Hex } from "../identity.js";
import type { ArtifactRef, PhotonDb } from "../store.js";
import {
  mapArtifact,
  mapArtifactRef,
  mapResource,
  runQuery,
  type ArtifactDataDbRow,
  type ArtifactDbRow,
  type DbClient,
  type ResourceDbRow,
} from "./rows.js";

/**
 * Revisioned provider resources (messages, polls, mini-app sessions, chats)
 * and the conversation-scoped binary artifact store.
 */
export function createResources(client: DbClient): Pick<
  PhotonDb,
  | "upsertResource"
  | "getResource"
  | "putArtifact"
  | "getArtifact"
  | "findArtifactByAttachment"
> {
  return {
    async upsertResource(sourceId, kind, resourceId, data, opts) {
      await runQuery(client,
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
      const result = await runQuery<ResourceDbRow>(client,
        `SELECT * FROM bell_photon_resources
           WHERE source_id = $1 AND kind = $2 AND resource_id = $3`,
        [sourceId, kind, resourceId]);
      return result[0] ? mapResource(result[0]) : undefined;
    },

    async putArtifact(input) {
      const artifactId = `art:${sha256Hex(JSON.stringify([input.sourceId, input.chatGuid, Date.now(), input.data.byteLength]))}${Math.random().toString(36).slice(2, 10)}`;
      await runQuery(client,
        `INSERT INTO bell_photon_artifacts
           (artifact_id, source_id, chat_guid, attachment_guid, file_name, media_type, byte_size, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [artifactId, input.sourceId, input.chatGuid, input.attachmentGuid ?? null,
          input.fileName ?? null, input.mediaType, input.data.byteLength, Buffer.from(input.data)]);
      return artifactId;
    },

    async getArtifact(artifactId) {
      const result = await runQuery<ArtifactDataDbRow>(client,
        `SELECT artifact_id, source_id, chat_guid, attachment_guid, file_name,
                media_type, byte_size, data, created_at
           FROM bell_photon_artifacts WHERE artifact_id = $1`, [artifactId]);
      return result[0] ? mapArtifact(result[0]) : undefined;
    },

    async findArtifactByAttachment(sourceId, chatGuid, attachmentGuid): Promise<ArtifactRef | undefined> {
      const result = await runQuery<ArtifactDbRow>(client,
        `SELECT artifact_id, source_id, chat_guid, attachment_guid, file_name,
                media_type, byte_size, created_at
           FROM bell_photon_artifacts
           WHERE source_id = $1 AND chat_guid = $2 AND attachment_guid = $3
           ORDER BY created_at DESC LIMIT 1`,
        [sourceId, chatGuid, attachmentGuid]);
      return result[0] ? mapArtifactRef(result[0]) : undefined;
    },
  };
}
