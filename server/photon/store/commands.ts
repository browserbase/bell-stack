import { PhotonStoreError, type CommandRow, type PhotonDb } from "../store.js";
import {
  isUniqueViolation,
  mapCommand,
  runQuery,
  type CommandDbRow,
  type DbClient,
} from "./rows.js";

/**
 * Command ledger — durable agent→worker requests keyed by semantic key for
 * idempotent enqueue, with claim fencing for the transport worker.
 */
export function createCommands(client: DbClient): Pick<
  PhotonDb,
  | "enqueueCommand"
  | "getCommand"
  | "getCommandBySemanticKey"
  | "claimCommands"
  | "completeCommand"
  | "commandStats"
> {
  async function getCommandBySemanticKey(semanticKey: string): Promise<CommandRow | undefined> {
    const result = await runQuery<CommandDbRow>(client,
      `SELECT * FROM bell_photon_commands WHERE semantic_key = $1`, [semanticKey]);
    return result[0] ? mapCommand(result[0]) : undefined;
  }

  return {
    async enqueueCommand(command) {
      try {
        await runQuery(client,
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
        if (isUniqueViolation(error)) {
          const existing = await getCommandBySemanticKey(command.semanticKey);
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
      const result = await runQuery<CommandDbRow>(client,
        `SELECT * FROM bell_photon_commands WHERE command_id = $1`, [commandId]);
      return result[0] ? mapCommand(result[0]) : undefined;
    },

    getCommandBySemanticKey,

    async claimCommands(workerId, limit, claimMs) {
      const result = await runQuery<CommandDbRow>(client,
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
      await runQuery(client,
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
        // claimed_by is deliberately not COALESCE'd: every settle releases
        // the claim (see CommandPatch).
        [commandId, status,
          patch.result === undefined ? null : JSON.stringify(patch.result),
          patch.providerReceipt === undefined ? null : JSON.stringify(patch.providerReceipt),
          patch.errorCode ?? null, patch.errorDetail ?? null,
          patch.nextAttemptAt ?? null, patch.providerKey ?? null,
          patch.claimedBy ?? null]);
    },

    async commandStats(sourceId) {
      const result = await runQuery<{ queued: string; in_flight: string; ambiguous: string }>(client,
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
  };
}
