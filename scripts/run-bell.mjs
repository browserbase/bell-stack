#!/usr/bin/env node
/**
 * Bell launcher: supervises Next (127.0.0.1:4320 via `pnpm dev`) and, when
 * BELL_PHOTON_ENABLED is set, the compiled Photon transport worker
 * (.photon-worker/scripts/photon-worker.js — build it with
 * `pnpm build:worker`). With the flag unset only Next starts.
 *
 * SIGINT/SIGTERM forward to both children. The launcher exits when either
 * child exits, propagating that child's status so the supervisor sees real
 * failures.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const WORKER_ENTRY = join(".photon-worker", "scripts", "photon-worker.js");

function photonEnabled() {
  const value = (process.env.BELL_PHOTON_ENABLED ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

const children = new Map();
let exiting = false;

function shutdown(signal) {
  if (exiting) return;
  exiting = true;
  for (const child of children.values()) {
    if (!child.killed) child.kill(signal);
  }
}

function onChildExit(name, code, signal) {
  if (exiting) return;
  exiting = true;
  // Bring down the sibling, then exit with this child's real status.
  for (const [otherName, child] of children) {
    if (otherName !== name && !child.killed) child.kill("SIGTERM");
  }
  const exitCode = code ?? (signal ? 1 : 0);
  process.exitCode = code === null && signal ? 1 : exitCode;
}

function startChild(name, command, args) {
  const child = spawn(command, args, {
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  children.set(name, child);
  child.on("exit", (code, signal) => onChildExit(name, code, signal));
  child.on("error", (error) => {
    console.error(`[run-bell] ${name} failed to start: ${error.message}`);
    onChildExit(name, 1, null);
  });
  return child;
}

startChild("next", "pnpm", ["dev"]);

if (photonEnabled()) {
  if (!existsSync(WORKER_ENTRY)) {
    console.error(
      `[run-bell] BELL_PHOTON_ENABLED is set but ${WORKER_ENTRY} is missing.\n` +
      "[run-bell] Build the worker first: pnpm build:worker",
    );
    shutdown("SIGTERM");
    process.exitCode = 1;
  } else {
    startChild("photon-worker", process.execPath, [
      "--env-file-if-exists=.env",
      "--env-file-if-exists=.env.local",
      WORKER_ENTRY,
    ]);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
