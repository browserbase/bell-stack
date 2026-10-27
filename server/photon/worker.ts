import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { PhotonConfig } from "./config.js";
import { connectPhoton, discoverLineCredentials, type LineCredentials, type PhotonConnection } from "./client.js";
import type { PhotonCommandDeps } from "./contracts.js";
import { createDispatcher, retireViaInternalRoute } from "./dispatch.js";
import { startTransport, type PhotonTransport } from "./events.js";
import { expireSweep } from "./interactions.js";
import { createOutbox } from "./outbox.js";
import { createProjector } from "./projection.js";
import { createPhotonStore, type PhotonStore } from "./store.js";

/**
 * The single-owner transport worker for one enrolled source. Owns the
 * durable event streams, catch-up reconciliation, dispatch, projection,
 * outbox, deadline and expiry sweeps, health persistence, managed-credential
 * refresh, and the source lease. Contains no model calls, no browser
 * automation, and no second agent runtime.
 */

const MIGRATION_FILE = "004_photon.sql";
const HEALTH_INTERVAL_MS = 10_000;
const SWEEP_INTERVAL_MS = 30_000;
const CREDENTIAL_CHECK_MS = 60_000;
const CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60_000;
const DEADLINE_BATCH = 32;
const LEASE_RENEW_DIVISOR = 3;

export interface PhotonWorkerDeps {
  readonly store?: PhotonStore;
  readonly discoverCredentials?: typeof discoverLineCredentials;
  readonly connect?: typeof connectPhoton;
  readonly fetcher?: typeof fetch;
  /** Migration SQL override; the worker otherwise reads migrations/004_photon.sql. */
  readonly migrationSql?: string;
  readonly log?: (entry: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

export interface PhotonWorker {
  /** Graceful stop: streams close, work drains, lease releases. Idempotent. */
  stop(): Promise<void>;
  /**
   * Resolves when the worker fully stops. `fatal` is set when termination
   * was involuntary (lost lease, expired credentials) — the supervisor
   * should restart the process with a nonzero exit.
   */
  readonly done: Promise<{ readonly fatal?: string }>;
}

function sleep(ms: number): Promise<void> {
  // Unref'd: loop sleeps must never hold the process open past shutdown.
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Locates migrations/004_photon.sql from either the source layout
 * (server/photon/worker.ts), the compiled worker output
 * (.photon-worker/server/photon/worker.js), or the process cwd.
 */
function migrationSql(provided: string | undefined): string {
  if (provided !== undefined) return provided;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "migrations", MIGRATION_FILE),
    join(here, "..", "..", "..", "migrations", MIGRATION_FILE),
    join(process.cwd(), "migrations", MIGRATION_FILE),
  ];
  for (const candidate of candidates)
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  throw new Error(`Photon migration ${MIGRATION_FILE} not found (searched ${candidates.join(", ")}).`);
}

export async function startPhotonWorker(
  config: PhotonConfig,
  deps: PhotonWorkerDeps = {},
): Promise<PhotonWorker> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)));
  const store = deps.store ?? createPhotonStore(config.databaseUrl);
  const discover = deps.discoverCredentials ?? discoverLineCredentials;
  const connect = deps.connect ?? connectPhoton;
  const fetcher = deps.fetcher ?? fetch;

  let stopping = false;
  let fatal: string | undefined;
  let doneResolve!: (value: { fatal?: string }) => void;
  const done = new Promise<{ fatal?: string }>((resolve) => { doneResolve = resolve; });
  const tasks: Promise<void>[] = [];

  /* 1-2. Store + idempotent migration ----------------------------------- */
  await store.pool.query(migrationSql(deps.migrationSql));

  /* 3-4. Managed credentials + client ------------------------------------ */
  const credentials: LineCredentials = await discover(config, fetcher);
  const tokenRef = { current: credentials.token };
  const connection: PhotonConnection = connect(credentials, config, tokenRef);
  const client = connection.client;

  /* 5-6. Source enrollment with a stable persisted log epoch ------------- */
  const source = await store.enrollSource({
    sourceId: connection.sourceId,
    projectId: config.projectId,
    instanceId: credentials.instanceId,
    accountScope: credentials.instanceId,
    phoneNumber: credentials.phoneNumber,
    endpoint: credentials.endpoint,
    // First write wins: enrollSource never rewrites log_epoch, so restarts
    // keep one continuous sequence domain for this enrolled source.
    logEpoch: `${credentials.instanceId}:${randomUUID()}`,
  });
  const sourceId = source.sourceId;
  const logEpoch = source.logEpoch;
  await store.updateCredentialExpiry(sourceId, new Date(credentials.expiresAt));

  /* 7. Single-owner lease ------------------------------------------------- */
  const ownerToken = randomUUID();
  const lease = await store.acquireLease(sourceId, ownerToken, config.worker.leaseMs);
  if (!lease.acquired) {
    await client.close().catch(() => undefined);
    await store.close();
    throw new Error(`Photon source lease is held by another owner (${lease.owner ?? "unknown"}).`);
  }
  const leaseEpoch = lease.epoch;
  await store.setSourceStatus(sourceId, "active");
  log({ level: "info", msg: "photon_worker_started", sourceId, leaseEpoch, instance: credentials.instanceId });

  /* Wiring --------------------------------------------------------------- */
  const transport: PhotonTransport = startTransport({
    client, store, config, sourceId, logEpoch, log, now,
  });
  const commandDeps: PhotonCommandDeps = {
    client: {
      sendText: (chat, text, options) =>
        client.messages.sendText(chat, text, options as Parameters<typeof client.messages.sendText>[2]),
      raw: client,
    },
    artifacts: {
      get: async (artifactId) => {
        const artifact = await store.getArtifact(artifactId);
        return artifact ? { data: artifact.data, fileName: artifact.fileName, mediaType: artifact.mediaType } : undefined;
      },
      put: (input) => store.putArtifact({ sourceId, ...input }),
    },
    config: { projectId: config.projectId },
    now,
  };
  const outbox = createOutbox({
    store, sourceId, workerId: ownerToken, commandDeps,
    watchControl: transport,
    // Claims outlive the slowest provider call by a wide margin; the orphan
    // sweep only repossesses commands whose claim genuinely expired.
    claimMs: Math.max(config.worker.leaseMs, 120_000),
    batchSize: config.worker.commandBatchSize,
    log, now,
  });
  const dispatcher = createDispatcher({
    store, config, sourceId, logEpoch, client, fetcher,
    batchSize: config.worker.dispatchBatchSize, log, now,
  });
  const projector = createProjector({ store, config, sourceId, fetcher, log, now });

  function loop(name: string, intervalMs: number, run: () => Promise<unknown>): void {
    tasks.push((async () => {
      while (!stopping) {
        try {
          await run();
        } catch (error) {
          if (!stopping)
            log({ level: "error", msg: "photon_loop_error", loop: name, error: error instanceof Error ? error.message : String(error) });
        }
        if (!stopping) await sleep(intervalMs);
      }
    })());
  }

  /* 8. Lease renewal: loss suspends the source and stops the worker ------ */
  loop("lease", Math.max(1_000, Math.floor(config.worker.leaseMs / LEASE_RENEW_DIVISOR)), async () => {
    const renewed = await store.renewLease(sourceId, ownerToken, leaseEpoch, config.worker.leaseMs);
    if (!renewed && !stopping) {
      fatal = "lease_lost";
      log({ level: "error", msg: "photon_lease_lost", sourceId, leaseEpoch });
      await store.setSourceStatus(sourceId, "suspended").catch(() => undefined);
      void stop();
    }
  });

  /* Loops ---------------------------------------------------------------- */
  loop("outbox", config.worker.commandPollMs, () => outbox.runOnce());
  // Requeue orphaned in_flight commands: the frozen claim query only moves
  // 'queued' rows, so crash-orphaned claims return via claim_expires_at.
  loop("claim-sweep", SWEEP_INTERVAL_MS, async () => {
    await store.pool.query(
      `UPDATE bell_photon_commands
         SET status = 'queued', claimed_by = NULL, updated_at = now()
       WHERE status = 'in_flight' AND claim_expires_at IS NOT NULL AND claim_expires_at < now()`,
    );
  });
  loop("dispatch", config.worker.dispatchPollMs, () => dispatcher.runOnce());
  loop("projection", config.worker.projectionPollMs, () => projector.runOnce());
  loop("reconciliation", config.worker.reconciliationMs, () => transport.runCatchUp());
  loop("interaction-expiry", SWEEP_INTERVAL_MS, () => expireSweep(store, now()));
  loop("deadlines", SWEEP_INTERVAL_MS, async () => {
    for (const deadline of await store.dueDeadlines(now(), DEADLINE_BATCH)) {
      const result = await retireViaInternalRoute(config, deadline.eveSessionId, "absolute_deadline", fetcher);
      if (result === "retryable") continue;
      await store.markDeadlineRetired(deadline.eveSessionId, "absolute_deadline");
      if (deadline.bindingId) await store.retireConversation(deadline.bindingId);
    }
  });
  loop("health", HEALTH_INTERVAL_MS, async () => {
    const [health, inbox, outboxStats, sourceRow] = await Promise.all([
      Promise.resolve(transport.health()),
      store.inboxStats(sourceId),
      store.commandStats(sourceId),
      store.getSource(sourceId),
    ]);
    await store.updateSourceHealth(sourceId, {
      alive: !stopping,
      leaseEpoch,
      leaseExpiresAt: sourceRow?.leaseExpiresAt?.toISOString(),
      streams: health.streams,
      captureCursor: sourceRow?.captureCursor,
      catchUpHeadSequence: health.catchUpHeadSequence,
      lastCatchUpAt: health.lastCatchUpAt,
      inboxLagSeconds: inbox.oldestPendingAgeSec,
      inboxPending: inbox.pending,
      inboxQuarantined: inbox.quarantined,
      outboxPending: outboxStats.queued + outboxStats.inFlight,
      ambiguous: outboxStats.ambiguous,
      integrityConflicts: health.integrityConflicts,
      normalizationFailures: health.normalizationFailures,
      locationWatches: health.locationWatches,
      updatedAt: now().toISOString(),
    });
  });

  /* Credential refresh ---------------------------------------------------- */
  let credentialExpiresAt = credentials.expiresAt;
  loop("credentials", CREDENTIAL_CHECK_MS, async () => {
    const remaining = credentialExpiresAt - now().getTime();
    if (remaining > CREDENTIAL_REFRESH_MARGIN_MS) return;
    try {
      const refreshed = await discover(config, fetcher);
      tokenRef.current = refreshed.token;
      credentialExpiresAt = refreshed.expiresAt;
      await store.updateCredentialExpiry(sourceId, new Date(refreshed.expiresAt));
      log({ level: "info", msg: "photon_credentials_refreshed", sourceId });
    } catch (error) {
      if (credentialExpiresAt > now().getTime()) {
        log({ level: "warn", msg: "photon_credential_refresh_failed", error: error instanceof Error ? error.message : String(error) });
        return;
      }
      // Credentials already expired and refresh keeps failing: terminate so
      // the supervisor performs a full reconnect instead of a live channel
      // on dead tokens.
      if (!stopping) {
        fatal = "credentials_expired";
        log({ level: "error", msg: "photon_credentials_expired", sourceId });
        void stop();
      }
    }
  });

  /* Stop ------------------------------------------------------------------ */
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    // Stop accepting work; drain bounded by shutdownMs.
    const drain = Promise.allSettled(tasks);
    await Promise.race([drain, sleep(config.worker.shutdownMs)]);
    await transport.stop().catch(() => undefined);
    await store.releaseLease(sourceId, ownerToken, leaseEpoch).catch(() => undefined);
    await store.setSourceStatus(sourceId, "suspended").catch(() => undefined);
    await client.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    log({ level: "info", msg: "photon_worker_stopped", sourceId, fatal });
    doneResolve({ fatal });
  }

  return { stop, done };
}
