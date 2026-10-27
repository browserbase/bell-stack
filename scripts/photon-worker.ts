#!/usr/bin/env node
/**
 * Photon transport worker entrypoint. Exits 0 quietly when the channel is
 * disabled so supervisors can launch it unconditionally; exits nonzero on
 * startup failure or involuntary termination (lost lease, expired managed
 * credentials) so the supervisor restarts it.
 */
import { PhotonConfigError, loadPhotonConfig, photonEnabled } from "../server/photon/config.js";
import { startPhotonWorker } from "../server/photon/worker.js";

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

async function main(): Promise<void> {
  if (!photonEnabled()) {
    log({ level: "info", msg: "photon_worker_disabled", note: "BELL_PHOTON_ENABLED is not set; exiting." });
    return;
  }
  const config = loadPhotonConfig();
  if (!config) {
    log({ level: "info", msg: "photon_worker_disabled" });
    return;
  }
  const worker = await startPhotonWorker(config, { log });

  let signal: NodeJS.Signals | undefined;
  const onSignal = (received: NodeJS.Signals): void => {
    if (signal) return;
    signal = received;
    log({ level: "info", msg: "photon_worker_signal", signal });
    void worker.stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const outcome = await worker.done;
  if (outcome.fatal) {
    log({ level: "error", msg: "photon_worker_fatal", fatal: outcome.fatal });
    process.exitCode = 1;
  }
}

main().catch((error) => {
  if (error instanceof PhotonConfigError)
    log({ level: "error", msg: "photon_config_error", setting: error.setting, error: error.message });
  else log({ level: "error", msg: "photon_worker_start_failed", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
