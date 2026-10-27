import {
  IMessageError,
  MessageEffect,
  type AdvancedIMessage,
  type MessagePart,
  type SettableMessageReaction,
  type TextEffect,
  type TextFormatInput,
} from "@photon-ai/advanced-imessage/grpc";
import type { z } from "zod";

import {
  KEYED_OPERATIONS,
  commandArgsSchemas,
  isReadOperation,
  type CommandExecution,
  type PhotonCommand,
  type PhotonCommandArgs,
  type PhotonCommandDeps,
  type PhotonCommandExecutor,
  type PhotonCommandOp,
  type PhotonCommandResult,
  type effectSchema,
  type messagePartSchema,
  type settableReactionSchema,
  type textEffectSchema,
  type textFormatSchema,
} from "../contracts.js";
import { providerKeyFor } from "../identity.js";

/**
 * Shared executor plumbing: SDK client unwrap, deterministic provider keys,
 * option mapping, and the retry/ambiguity classifier every operation uses.
 */

export function sdkClient(deps: PhotonCommandDeps): AdvancedIMessage {
  return deps.client.raw as AdvancedIMessage;
}

/**
 * The stable `clientMessageId` for this logical command. Once a key has been
 * persisted on the command row it is reused verbatim — the provider dedups
 * keyed writes by this value, so retries never duplicate a landed send. The
 * outbox injects the persisted key into the command before execution; the
 * first-attempt derivation matches `providerKeyFor(commandId, 1)`.
 */
export function commandProviderKey(command: PhotonCommand): string {
  return command.providerKey ?? providerKeyFor(command.commandId, 1);
}

/* ---------------------------- option mapping ---------------------------- */

const EFFECTS = MessageEffect as unknown as Record<string, MessageEffect>;

export function mapEffect(effect: z.infer<typeof effectSchema> | undefined): MessageEffect | undefined {
  return effect === undefined ? undefined : EFFECTS[effect];
}

export function mapReaction(
  reaction: z.infer<typeof settableReactionSchema>,
): SettableMessageReaction {
  if (typeof reaction === "string") return { kind: reaction };
  return { kind: "emoji", emoji: reaction.customEmoji };
}

export function mapFormatting(
  formatting: readonly (z.infer<typeof textFormatSchema> | z.infer<typeof textEffectSchema>)[] | undefined,
): TextFormatInput[] | undefined {
  if (!formatting) return undefined;
  const out: TextFormatInput[] = [];
  for (const range of formatting) {
    if ("effect" in range) {
      out.push({ type: "effect", start: range.start, length: range.length, effect: range.effect as TextEffect });
      continue;
    }
    if (range.bold) out.push({ type: "bold", start: range.start, length: range.length });
    if (range.italic) out.push({ type: "italic", start: range.start, length: range.length });
    if (range.underline) out.push({ type: "underline", start: range.start, length: range.length });
    if (range.strikethrough) out.push({ type: "strikethrough", start: range.start, length: range.length });
  }
  return out;
}

export function mapParts(parts: readonly z.infer<typeof messagePartSchema>[]): MessagePart[] {
  return parts.map((part) => ({
    text: part.text,
    mentionedAddress: part.mentionedAddress,
    formatting: mapFormatting(part.formatting),
    attachmentGuid: part.attachmentGuid,
    attachmentName: part.attachmentName,
    bubbleIndex: part.bubbleIndex,
  }));
}

/* --------------------------- error classification --------------------------- */

/**
 * Post-failure reconcile hook: reads provider state to learn whether an
 * uncertain write actually landed. `true` applied, `false` proven absent
 * (safe to retry), `undefined` still unknown.
 */
export type ReconcileFn = (
  command: PhotonCommand,
  deps: PhotonCommandDeps,
) => Promise<boolean | undefined>;

interface OpResult<Op extends PhotonCommandOp> {
  readonly result?: PhotonCommandResult<Op>;
  readonly providerReceipt?: unknown;
}

/**
 * A Bell-side validation/policy failure inside an executor — always terminal
 * (`failed`), never retried and never ambiguous.
 */
export class CommandValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CommandValidationError";
    this.code = code;
  }
}

async function reconcileOrAmbiguous<Op extends PhotonCommandOp>(
  code: string,
  detail: string,
  command: PhotonCommand,
  deps: PhotonCommandDeps,
  reconcile: ReconcileFn | undefined,
): Promise<CommandExecution<Op>> {
  if (reconcile) {
    const state = await reconcile(command, deps).catch(() => undefined);
    // The "reconciled" marker rides in providerReceipt so the typed result
    // shape is never polluted by a synthetic value no executor produced.
    if (state === true) return { kind: "acknowledged", providerReceipt: { reconciled: true } };
    if (state === false)
      return { kind: "retryable", errorCode: code, errorDetail: `${detail} (reconcile: not applied)` };
  }
  // No safe read exists: report uncertainty rather than blind-retrying a
  // possibly-applied visible side effect (PRD §8.2).
  return { kind: "ambiguous", reason: detail };
}

async function classify<Op extends PhotonCommandOp>(
  command: PhotonCommand,
  deps: PhotonCommandDeps,
  op: Op,
  error: unknown,
  reconcile: ReconcileFn | undefined,
): Promise<CommandExecution<Op>> {
  const detail = error instanceof Error ? error.message : String(error);
  const keyed = KEYED_OPERATIONS.has(op);
  const read = isReadOperation(op);

  if (error instanceof CommandValidationError)
    return { kind: "failed", errorCode: error.code, errorDetail: detail };
  if (error instanceof IMessageError) {
    // Managed-credential expiry can be healed by the worker's refresh loop.
    if (error.code === "tokenExpired" || error.code === "unauthenticated")
      return { kind: "retryable", errorCode: error.code, errorDetail: detail, retryAfterMs: 5_000 };
    if (error.retryable) {
      // Reads may always retry. Keyed writes retry with the same persisted
      // provider key, so a landed first attempt dedups server-side.
      if (read || keyed)
        return { kind: "retryable", errorCode: error.code, errorDetail: detail, retryAfterMs: error.retryAfter };
      return reconcileOrAmbiguous(error.code, detail, command, deps, reconcile);
    }
    return { kind: "failed", errorCode: error.code, errorDetail: detail };
  }
  if (read || keyed) return { kind: "retryable", errorCode: "transport_error", errorDetail: detail };
  return reconcileOrAmbiguous("transport_error", detail, command, deps, reconcile);
}

/**
 * Builds one executor: parses args, runs the SDK call, persists nothing on
 * failure, and classifies errors into the outbox retry/ambiguity contract.
 */
export function executeOp<Op extends PhotonCommandOp>(
  op: Op,
  run: (
    client: AdvancedIMessage,
    args: PhotonCommandArgs<Op>,
    command: PhotonCommand,
    deps: PhotonCommandDeps,
  ) => Promise<OpResult<Op>>,
  reconcile?: ReconcileFn,
): PhotonCommandExecutor<Op> {
  return async (command, deps) => {
    const args = commandArgsSchemas[op].parse(command.args) as PhotonCommandArgs<Op>;
    try {
      return { kind: "acknowledged", ...(await run(sdkClient(deps), args, command, deps)) };
    } catch (error) {
      return classify(command, deps, op, error, reconcile);
    }
  };
}
