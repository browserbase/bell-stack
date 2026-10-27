import type { PhotonDb, SourceRow } from "../store.js";
import { mapSource, runQuery, type DbClient, type SourceDbRow } from "./rows.js";

/**
 * Source enrollment, lease fencing, health and credential-expiry
 * persistence. One row per enrolled (project, instance, line); the lease
 * columns fence the single transport owner.
 */
export function createSources(client: DbClient): Pick<
  PhotonDb,
  | "enrollSource"
  | "getSource"
  | "getLatestSource"
  | "setSourceStatus"
  | "updateCaptureCursor"
  | "acquireLease"
  | "renewLease"
  | "releaseLease"
  | "updateSourceHealth"
  | "updateCredentialExpiry"
  | "activationBoundary"
  | "setActivationBoundary"
> {
  async function getSource(sourceId: string): Promise<SourceRow | undefined> {
    const result = await runQuery<SourceDbRow>(
      client,
      `SELECT * FROM bell_photon_sources WHERE source_id = $1`,
      [sourceId],
    );
    return result[0] ? mapSource(result[0]) : undefined;
  }

  return {
    async enrollSource(input) {
      const result = await runQuery<SourceDbRow>(client,
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

    getSource,

    /** Most recently touched source of a project (health-route probe). */
    async getLatestSource(projectId) {
      const result = await runQuery<SourceDbRow>(client,
        `SELECT * FROM bell_photon_sources
          WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 1`,
        [projectId]);
      return result[0] ? mapSource(result[0]) : undefined;
    },

    async setSourceStatus(sourceId, status) {
      await runQuery(client,
        `UPDATE bell_photon_sources SET status = $2, updated_at = now() WHERE source_id = $1`,
        [sourceId, status]);
    },

    async updateCaptureCursor(sourceId, cursor, coverage) {
      await runQuery(client,
        `UPDATE bell_photon_sources
           SET capture_cursor = $2, coverage = COALESCE($3::jsonb, coverage), updated_at = now()
         WHERE source_id = $1`, [sourceId, cursor, coverage ? JSON.stringify(coverage) : null]);
    },

    async acquireLease(sourceId, ownerToken, leaseMs) {
      const result = await runQuery<{ lease_epoch: string }>(client,
        `UPDATE bell_photon_sources
           SET owner_token = $2, lease_epoch = lease_epoch + 1,
               lease_expires_at = now() + make_interval(secs => $3::float8 / 1000),
               updated_at = now()
         WHERE source_id = $1
           AND (owner_token IS NULL OR owner_token = $2 OR lease_expires_at < now())
         RETURNING lease_epoch`,
        [sourceId, ownerToken, leaseMs]);
      if (result.length === 0) {
        const current = await getSource(sourceId);
        return { acquired: false, owner: current?.ownerToken } as const;
      }
      return { acquired: true, epoch: Number(result[0].lease_epoch) } as const;
    },

    async renewLease(sourceId, ownerToken, epoch, leaseMs) {
      const result = await runQuery(client,
        `UPDATE bell_photon_sources
           SET lease_expires_at = now() + make_interval(secs => $4::float8 / 1000), updated_at = now()
         WHERE source_id = $1 AND owner_token = $2 AND lease_epoch = $3
         RETURNING source_id`,
        [sourceId, ownerToken, epoch, leaseMs]);
      return result.length === 1;
    },

    async releaseLease(sourceId, ownerToken, epoch) {
      await runQuery(client,
        `UPDATE bell_photon_sources
           SET owner_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE source_id = $1 AND owner_token = $2 AND lease_epoch = $3`,
        [sourceId, ownerToken, epoch]);
    },

    async updateSourceHealth(sourceId, health) {
      await runQuery(client,
        `UPDATE bell_photon_sources SET health = $2::jsonb, updated_at = now() WHERE source_id = $1`,
        [sourceId, JSON.stringify(health)]);
    },

    async updateCredentialExpiry(sourceId, expiresAt) {
      await runQuery(client,
        `UPDATE bell_photon_sources SET credential_expires_at = $2, updated_at = now() WHERE source_id = $1`,
        [sourceId, expiresAt]);
    },

    async activationBoundary(sourceId) {
      const result = await runQuery<{ activation_boundary: string | null }>(client,
        `SELECT activation_boundary FROM bell_photon_sources WHERE source_id = $1`, [sourceId]);
      return result[0]?.activation_boundary ?? undefined;
    },

    async setActivationBoundary(sourceId, boundary) {
      await runQuery(client,
        `UPDATE bell_photon_sources
           SET activation_boundary = COALESCE(activation_boundary, $2), updated_at = now()
         WHERE source_id = $1`, [sourceId, boundary]);
    },
  };
}
