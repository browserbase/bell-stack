import { ZodError } from "zod";

import {
  KEYED_OPERATIONS,
  isReadOperation,
  type CommandExecution,
  type PhotonCommand,
  type PhotonCommandDeps,
  type PhotonCommandExecutor,
  type PhotonCommandOp,
} from "./contracts.js";
import { providerKeyFor } from "./identity.js";
import { conversationExecutors } from "./commands/conversations.js";
import { interactionExecutors } from "./commands/interactions.js";
import { locationExecutors, type LocationWatchControl } from "./commands/locations.js";
import { mediaExecutors } from "./commands/media.js";
import { messageExecutors } from "./commands/messages.js";
import type { CommandRow, PhotonDb } from "./store.js";

/**
 * The durable command outbox. Claims with the store's fencing primitives,
 * orders work through explicit dependencies, routes each operation to its
 * executor, and settles exactly one terminal status per attempt. A retryable
 * error re-queues with backoff; an uncertain unkeyed write settles
 * `ambiguous` rather than risking a duplicate visible send.
 */

const DEFAULT_MAX_ATTEMPTS = 8;
const DEPENDENCY_WAIT_MS = 2_000;
const FOREIGN_RELEASE_MS = 5_000;

export interface OutboxDeps {
  readonly store: PhotonDb;
  readonly workerId: string;
  /** Commands belonging to other sources are released unclaimed. */
  readonly sourceId: string;
  readonly commandDeps: PhotonCommandDeps;
  readonly watchControl: LocationWatchControl;
  readonly claimMs: number;
  readonly batchSize: number;
  readonly maxAttempts?: number;
  /** Per-operation executors merged over the built-in registry (tests). */
  readonly executors?: Partial<Record<PhotonCommandOp, PhotonCommandExecutor>>;
  readonly log?: (entry: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

export interface PhotonOutbox {
  /** Claims and executes one batch; returns how many commands ran. */
  runOnce(): Promise<number>;
  readonly executors: Readonly<Partial<Record<PhotonCommandOp, PhotonCommandExecutor>>>;
}

function toCommand(row: CommandRow): PhotonCommand {
  return {
    commandId: row.commandId,
    operation: row.operation,
    args: row.args as PhotonCommand["args"],
    argsDigest: row.argsDigest,
    initiatorPrincipal: row.initiatorPrincipal,
    audience: row.audience,
    sourceId: row.sourceId,
    chatGuid: row.chatGuid,
    target: row.target,
    providerKey: row.providerKey,
    semanticKey: row.semanticKey,
    dependsOn: row.dependsOn,
    expiresAt: row.expiresAt?.toISOString(),
  };
}

function retryBackoff(attempt: number): number {
  const exp = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
  return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

export function createOutbox(deps: OutboxDeps): PhotonOutbox {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const executors: Partial<Record<PhotonCommandOp, PhotonCommandExecutor>> = {
    ...messageExecutors(store),
    ...mediaExecutors(store),
    ...conversationExecutors(store),
    ...interactionExecutors(store),
    ...locationExecutors(deps.watchControl),
    ...deps.executors,
  };

  /** Settles the claimed row with the execution's one terminal outcome. */
  async function settle(row: CommandRow, execution: CommandExecution, providerKey?: string): Promise<void> {
    const patch = { providerKey };
    switch (execution.kind) {
      case "acknowledged":
        await store.completeCommand(row.commandId, "acknowledged", {
          ...patch, result: execution.result, providerReceipt: execution.providerReceipt,
        });
        return;
      case "ambiguous":
        await store.completeCommand(row.commandId, "ambiguous", {
          ...patch, providerReceipt: execution.providerReceipt, errorDetail: execution.reason,
        });
        return;
      case "failed":
        await store.completeCommand(row.commandId, "failed", {
          ...patch, errorCode: execution.errorCode, errorDetail: execution.errorDetail,
        });
        return;
      case "retryable": {
        const read = isReadOperation(row.operation);
        if (row.attemptCount >= maxAttempts) {
          // Reads exhaust into a terminal failure; writes stay ambiguous
          // because provider acceptance was never disproven.
          await store.completeCommand(
            row.commandId,
            read ? "failed" : "ambiguous",
            { ...patch, errorCode: "retry_exhausted", errorDetail: execution.errorDetail },
          );
          return;
        }
        const delay = execution.retryAfterMs ?? retryBackoff(row.attemptCount);
        await store.completeCommand(row.commandId, "queued", {
          ...patch,
          errorCode: execution.errorCode,
          errorDetail: execution.errorDetail,
          nextAttemptAt: new Date(now().getTime() + delay),
        });
        return;
      }
    }
  }

  /**
   * Verifies every dependency settled in a good state before this command
   * may run. Returns a settle outcome, or `undefined` when it may execute.
   */
  async function dependencyGate(row: CommandRow): Promise<CommandExecution | "wait" | undefined> {
    for (const depId of row.dependsOn) {
      const dep = await store.getCommand(depId);
      if (!dep) return { kind: "failed", errorCode: "dependency_missing", errorDetail: `Dependency ${depId} does not exist.` };
      switch (dep.status) {
        case "acknowledged":
          continue;
        case "queued":
        case "in_flight":
          return "wait";
        case "ambiguous":
          return { kind: "ambiguous", reason: `Dependency ${depId} settled ambiguous.` };
        default:
          return { kind: "failed", errorCode: "dependency_failed", errorDetail: `Dependency ${depId} ended ${dep.status}.` };
      }
    }
    return undefined;
  }

  async function runRow(row: CommandRow): Promise<void> {
    if (row.sourceId !== deps.sourceId) {
      // A source we do not own: release the claim so its worker picks it up.
      await store.completeCommand(row.commandId, "queued", {
        nextAttemptAt: new Date(now().getTime() + FOREIGN_RELEASE_MS),
      });
      return;
    }
    // Provider keys are per-command constants: a reclaimed or retried row
    // must reuse the identical clientMessageId so the provider deduplicates
    // a landed attempt instead of double-sending it.
    const providerKey = KEYED_OPERATIONS.has(row.operation)
      ? row.providerKey ?? providerKeyFor(row.commandId, 1)
      : undefined;

    if (row.expiresAt !== undefined && row.expiresAt.getTime() <= now().getTime()) {
      await store.completeCommand(row.commandId, "expired", { providerKey, errorDetail: "Command expired before execution." });
      return;
    }
    const gate = await dependencyGate(row);
    if (gate === "wait") {
      await store.completeCommand(row.commandId, "queued", {
        nextAttemptAt: new Date(now().getTime() + DEPENDENCY_WAIT_MS),
      });
      return;
    }
    if (gate !== undefined) {
      await settle(row, gate, providerKey);
      return;
    }
    const executor = executors[row.operation];
    if (!executor) {
      await settle(row, { kind: "failed", errorCode: "unknown_operation", errorDetail: `No executor for ${row.operation}.` }, providerKey);
      return;
    }
    let execution: CommandExecution;
    try {
      const command = toCommand(row);
      // The executor sees the same provider key the row will settle with, so
      // keyed writes always carry a stable clientMessageId.
      execution = await executor(
        providerKey !== undefined ? { ...command, providerKey } : command,
        deps.commandDeps,
      );
    } catch (error) {
      if (error instanceof ZodError) {
        execution = {
          kind: "failed",
          errorCode: "invalid_args",
          errorDetail: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 1_000),
        };
      } else {
        log({
          level: "error", msg: "photon_executor_threw", op: row.operation,
          error: error instanceof Error ? error.message : String(error),
        });
        execution = { kind: "failed", errorCode: "executor_error", errorDetail: error instanceof Error ? error.message : String(error) };
      }
    }
    await settle(row, execution, providerKey);
  }

  return {
    executors,
    async runOnce() {
      const claimed = await store.claimCommands(deps.workerId, deps.batchSize, deps.claimMs);
      let ran = 0;
      // Sequential inside the batch: dependents observe earlier completions.
      for (const row of claimed) {
        try {
          await runRow(row);
          ran++;
        } catch (error) {
          log({
            level: "error", msg: "photon_outbox_row_failed", commandId: row.commandId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return ran;
    },
  };
}
