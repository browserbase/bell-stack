import { randomUUID } from "node:crypto";

import { z } from "zod";

import { PHOTON_EVENTS_PATH, type PhotonConfig } from "./config.js";
import type { PhotonCommand, ProjectedOutput, ProjectedOutputKind } from "./contracts.js";
import { semanticKeyFor, sha256Hex } from "./identity.js";
import { stableJson } from "./normalize.js";
import type { ConversationRow, PhotonStore } from "./store.js";

/**
 * Eve -> provider projector. Reads each bound session's durable event stream
 * through the internal route, converts output events into commands, and
 * advances the projector offset atomically with the enqueue so a crash can
 * never double-materialize a visible send.
 */

/** A single text bubble stays readable below this bound; longer sends chunk. */
const MAX_TEXT_CHARS = 4_000;
/** Retained materialized-key window for projector offset bookkeeping. */
const MATERIALIZED_WINDOW = 256;
/** Prompt interactions outlive neither the session nor the 24h deadline. */
const PROMPT_TTL_MS = 24 * 60 * 60 * 1000;

const eventsReadSchema = z.object({
  events: z.array(z.unknown()),
  tailIndex: z.number().int().min(0),
  stranded: z.boolean().optional(),
}).strict();

/** Minimal Eve stream-event shape the projector consumes (defensive parse). */
export interface EveStreamEvent {
  readonly type: string;
  readonly data?: Record<string, unknown>;
  readonly meta?: { readonly id?: string; readonly at?: string };
}

const INPUT_REQUEST_KINDS = new Set(["question", "session-limit", "tool-approval"]);

function isEveEvent(value: unknown): value is EveStreamEvent {
  return typeof value === "object" && value !== null
    && typeof (value as { type?: unknown }).type === "string";
}

export interface ProjectorDeps {
  readonly store: PhotonStore;
  readonly config: PhotonConfig;
  readonly sourceId: string;
  readonly fetcher?: typeof fetch;
  readonly batchSize?: number;
  readonly log?: (entry: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

export interface PhotonProjector {
  /** One scan/materialize round over every bound session. */
  runOnce(): Promise<number>;
}

export interface PromptInsert {
  readonly requestRef: string;
  readonly kind: "prompt" | "authorization";
  readonly permittedActor?: string;
  readonly target: Record<string, unknown>;
  readonly responseMapping: Record<string, unknown>;
}

export interface ProjectionContext {
  readonly sessionId: string;
  readonly conversation: ConversationRow;
  /** Command ids enqueued this batch, for dependsOn chaining. */
  lastCommandId?: string;
  /** Turns that already emitted a typing-on marker. */
  readonly typingOn: Set<string>;
  readonly materialized: string[];
  readonly registerPrompts: PromptInsert[];
}

function commandIdFor(semanticKey: string): string {
  return `cmd:${sha256Hex(semanticKey).slice(0, 48)}`;
}

function makeOutput(
  ctx: ProjectionContext,
  input: {
    kind: ProjectedOutputKind;
    operation?: PhotonCommand["operation"];
    args?: Record<string, unknown>;
    turnId?: string;
    step?: string | number;
    partId?: string;
    requestId?: string;
    payload?: Record<string, unknown>;
  },
): ProjectedOutput {
  const semanticKey = semanticKeyFor({
    sessionId: ctx.sessionId,
    turnId: input.turnId,
    step: input.step,
    outputKind: input.kind,
    partId: input.partId,
    requestId: input.requestId,
  });
  return {
    kind: input.kind,
    semanticKey,
    operation: input.operation,
    args: input.args,
    payload: input.payload ?? {},
  };
}

function textOutput(
  ctx: ProjectionContext,
  text: string,
  turnId: string | undefined,
  step: number | undefined,
): ProjectedOutput[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chat = ctx.conversation.chatGuid;
  if (trimmed.length <= MAX_TEXT_CHARS) {
    return [makeOutput(ctx, {
      kind: "assistant_text", operation: "messages.sendText",
      args: { chat, text: trimmed }, turnId, step,
      payload: { text: trimmed },
    })];
  }
  // Long assistant output chunks into one ordered multipart send.
  const parts: string[] = [];
  for (let at = 0; at < trimmed.length; at += MAX_TEXT_CHARS)
    parts.push(trimmed.slice(at, at + MAX_TEXT_CHARS));
  return [makeOutput(ctx, {
    kind: "assistant_part", operation: "messages.sendMultipart",
    args: { chat, parts: parts.map((text) => ({ text })) }, turnId, step,
    payload: { partCount: parts.length },
  })];
}

/** Typing markers deduplicate per turn: one on, one off at the boundary. */
function typingOutput(
  ctx: ProjectionContext,
  turnId: string,
  isTyping: boolean,
): ProjectedOutput[] {
  if (isTyping) {
    if (ctx.typingOn.has(turnId)) return [];
    ctx.typingOn.add(turnId);
  } else {
    ctx.typingOn.delete(turnId);
  }
  return [makeOutput(ctx, {
    kind: "typing", operation: "chats.setTyping",
    args: { chat: ctx.conversation.chatGuid, isTyping }, turnId,
    // on/off must key distinctly or the second marker dedups away.
    partId: isTyping ? "on" : "off",
    payload: { isTyping },
  })];
}

function groupNeedsPrivateNotice(scope: "direct" | "group"): boolean {
  return scope !== "direct";
}

/**
 * Converts one Eve event into projected outputs. Returns `[]` for events
 * that carry no visible or command-shaped effect.
 */
export function projectEvent(ctx: ProjectionContext, event: EveStreamEvent): ProjectedOutput[] {
  const data = event.data ?? {};
  const turnId = typeof data.turnId === "string" ? data.turnId : undefined;
  const step = typeof data.stepIndex === "number" ? data.stepIndex : undefined;
  const chat = ctx.conversation.chatGuid;
  const scope = ctx.conversation.scope;

  switch (event.type) {
    case "message.completed": {
      const message = typeof data.message === "string" ? data.message : "";
      return textOutput(ctx, message, turnId, step);
    }
    case "turn.started":
      return [
        // The turn consuming the input is the delivery-observed point where
        // the inbound message can be marked read.
        makeOutput(ctx, {
          kind: "read_marker", operation: "chats.markRead",
          args: { chat }, turnId, payload: {},
        }),
        ...typingOutput(ctx, turnId ?? "", true),
      ];
    case "message.appended":
      return typingOutput(ctx, turnId ?? "", true);
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled":
    case "turn.waiting":
    case "session.waiting": {
      const outputs = typingOutput(ctx, turnId ?? "", false);
      if (event.type === "turn.failed") {
        outputs.push(...textOutput(ctx, "[Bell] The last step failed — try again.", turnId, step)
          .map((out) => ({ ...out, kind: "lifecycle_notice" as const })));
      }
      return outputs;
    }
    case "session.failed": {
      const outputs = typingOutput(ctx, turnId ?? "", false);
      outputs.push(...textOutput(ctx, "[Bell] This conversation ended unexpectedly.", turnId, step)
        .map((out) => ({ ...out, kind: "lifecycle_notice" as const })));
      return outputs;
    }
    case "session.completed":
      return typingOutput(ctx, turnId ?? "", false);
    case "input.requested": {
      const requests = Array.isArray(data.requests) ? data.requests : [];
      const outputs: ProjectedOutput[] = [];
      for (const request of requests) {
        if (typeof request !== "object" || request === null) continue;
        const req = request as Record<string, unknown>;
        const kind = typeof req.kind === "string" ? req.kind : "";
        if (!INPUT_REQUEST_KINDS.has(kind)) continue;
        const requestId = typeof req.requestId === "string" ? req.requestId : undefined;
        const prompt = typeof req.prompt === "string" ? req.prompt : "";
        const options = Array.isArray(req.options)
          ? req.options.filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
          : [];
        const lines = options
          .map((o, i) => `${i + 1}. ${typeof o.label === "string" ? o.label : String(o.id ?? i + 1)}`)
          .join("\n");
        const body = lines ? `${prompt}\n\n${lines}\n\nReply with your choice.` : prompt;
        if (kind === "tool-approval" && groupNeedsPrivateNotice(scope)) {
          // A group chat never receives a credential/approval flow: the
          // instruction points at the private continuation instead.
          outputs.push(...textOutput(
            ctx, "[Bell] This request needs approval — please continue in a private message.",
            turnId, step,
          ).map((out) => ({ ...out, kind: "lifecycle_notice" as const })));
          continue;
        }
        outputs.push(...textOutput(ctx, body, turnId, step)
          .map((out) => ({
            ...out,
            kind: kind === "tool-approval" ? "authorization" as const : "input_request" as const,
          })));
        // The durable prompt row lets the next inbound reply resolve this
        // request exactly once (see interactions.ts). Even tool-approval
        // registers as a plain prompt: it is Eve's HITL gate, not an OAuth
        // consent, and only ever delivers in a verified direct scope.
        ctx.registerPrompts.push({
          requestRef: requestId ?? `req:${randomUUID()}`,
          kind: "prompt",
          target: { requestId: requestId ?? null, inputKind: kind },
          responseMapping: {
            optionIds: options.map((o) => String(o.id ?? "")),
            labels: options.map((o) => String(o.label ?? "")),
          },
        });
      }
      return outputs;
    }
    case "authorization.required": {
      const name = typeof data.name === "string" ? data.name : "a service";
      const description = typeof data.description === "string" ? data.description : "";
      const webhookUrl = typeof data.webhookUrl === "string" ? data.webhookUrl : undefined;
      if (scope !== "direct") {
        // Private handoff URLs and credential flows never enter a group.
        return textOutput(
          ctx, "[Bell] This request needs a private sign-in — please message me directly.",
          turnId, step,
        ).map((out) => ({ ...out, kind: "lifecycle_notice" as const }));
      }
      const body = webhookUrl
        ? `[Bell] Sign-in required for ${name}: ${description}\n\n${webhookUrl}`
        : `[Bell] Sign-in required for ${name}: ${description}`;
      return textOutput(ctx, body, turnId, step)
        .map((out) => ({ ...out, kind: "authorization" as const }));
    }
    default:
      return [];
  }
}

export function createProjector(deps: ProjectorDeps): PhotonProjector {
  const { store, config, sourceId } = deps;
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const batchSize = deps.batchSize ?? 32;

  async function readEvents(sessionId: string, startIndex: number) {
    try {
      const response = await fetcher(`${config.internalOrigin}${PHOTON_EVENTS_PATH}`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${config.internalSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId, startIndex }),
      });
      if (!response.ok) return undefined;
      const parsed = eventsReadSchema.safeParse(await response.json().catch(() => null));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async function processConversation(conversation: ConversationRow): Promise<number> {
    const sessionId = conversation.eveSessionId;
    if (!sessionId) return 0;
    const offset = await store.getProjectorOffset(sourceId, sessionId);
    const startIndex = offset?.streamPosition ?? 0;
    const page = await readEvents(sessionId, startIndex);
    if (!page) return 0;
    if (page.stranded) {
      // The session's durable stream is gone; the binding retires so the
      // next inbound starts a fresh generation.
      await store.retireConversation(conversation.bindingId);
      await store.markDeadlineRetired(sessionId, "session_stranded");
      return 0;
    }

    const ctx: ProjectionContext = {
      sessionId,
      conversation,
      typingOn: new Set(),
      materialized: [],
      registerPrompts: [],
    };
    const outputs: ProjectedOutput[] = [];
    for (const raw of page.events) {
      if (!isEveEvent(raw)) {
        log({ level: "warn", msg: "photon_projector_skipped_event", sessionId });
        continue;
      }
      for (const output of projectEvent(ctx, raw)) {
        outputs.push(output);
        ctx.materialized.push(output.semanticKey);
      }
    }
    if (outputs.length === 0 && ctx.materialized.length === 0 && page.tailIndex === startIndex)
      return 0;

    const commandIds: string[] = [];
    await store.withTransaction(async (db) => {
      for (const output of outputs) {
        if (!output.operation || !output.args) continue;
        const argsDigest = sha256Hex(stableJson([output.operation, output.args]));
        // A prior materialization may already own this semantic key: same
        // digest chains onto it; different args would poison the tx, so the
        // output is dropped and logged instead of aborting the batch.
        const existing = await db.getCommandBySemanticKey(output.semanticKey);
        if (existing) {
          if (existing.argsDigest !== argsDigest) {
            log({
              level: "warn", msg: "photon_semantic_key_conflict",
              semanticKey: output.semanticKey, operation: output.operation,
            });
            continue;
          }
          ctx.lastCommandId = existing.commandId;
          continue;
        }
        const command: PhotonCommand = {
          commandId: commandIdFor(output.semanticKey),
          operation: output.operation,
          args: output.args as PhotonCommand["args"],
          argsDigest,
          initiatorPrincipal: conversation.initiatingPrincipal,
          audience: conversation.scope,
          sourceId,
          chatGuid: conversation.chatGuid,
          semanticKey: output.semanticKey,
          dependsOn: ctx.lastCommandId ? [ctx.lastCommandId] : [],
        };
        const enqueued = await db.enqueueCommand(command);
        ctx.lastCommandId = enqueued.commandId;
        commandIds.push(enqueued.commandId);
      }
      for (const prompt of ctx.registerPrompts) {
        await db.createInteraction({
          sourceId,
          bindingId: conversation.bindingId,
          chatGuid: conversation.chatGuid,
          generation: conversation.generation,
          kind: prompt.kind,
          requestRef: prompt.requestRef,
          permittedActor: prompt.permittedActor,
          target: prompt.target,
          responseMapping: prompt.responseMapping,
          expiresAt: new Date(now().getTime() + PROMPT_TTL_MS),
        });
      }
      const materializedKeys = [
        ...(offset?.materializedKeys ?? []),
        ...ctx.materialized,
      ].slice(-MATERIALIZED_WINDOW);
      await db.advanceProjector({
        sourceId,
        eveSessionId: sessionId,
        streamPosition: page.tailIndex,
        materializedKeys,
      });
    });
    return commandIds.length;
  }

  return {
    async runOnce() {
      let enqueued = 0;
      const conversations = (await store.activeConversations(sourceId)).slice(0, batchSize);
      for (const conversation of conversations) {
        try {
          enqueued += await processConversation(conversation);
        } catch (error) {
          log({
            level: "error", msg: "photon_projector_failed",
            bindingId: conversation.bindingId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return enqueued;
    },
  };
}
