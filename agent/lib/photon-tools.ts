import { randomUUID } from "node:crypto";

import type { ToolContext } from "eve/tools";
import { z } from "zod";

import { loadPhotonConfig, type PhotonConfig } from "../../server/photon/config.js";
import {
  commandArgsSchemas,
  isReadOperation,
  validateCommandArgs,
  type AttachmentInfo,
  type PhotonCommand,
  type PhotonCommandArgs,
  type PhotonCommandOp,
  type PhotonCommandResult,
  type customizedMiniAppSchema,
} from "../../server/photon/contracts.js";
import { sanitizeFileName } from "../../server/photon/filename.js";
import { canonicalTupleJson, semanticKeyFor, sha256Hex } from "../../server/photon/identity.js";
import {
  type ConversationRow,
  type PhotonDb,
  type PhotonStore,
  type ResourceKind,
} from "../../server/photon/store.js";
import { messagingPrincipal, type VerifiedMessagingPrincipal } from "./messaging-auth";
import { getPhotonStore } from "./photon-store";

/**
 * Shared plumbing for the Photon agent tools. Each tool verifies the
 * messaging principal and channel configuration, resolves the durable
 * conversation binding, validates arguments against the frozen command
 * contracts, and appends a typed PhotonCommand to the outbox. The transport
 * worker is the only process that talks to the provider — tools never call
 * the gRPC SDK and never see provider credentials.
 */

/** How long a tool waits for an acknowledged/failed command before reporting pending. */
export const COMMAND_RESULT_TIMEOUT_MS = 8_000;
const RESULT_POLL_INTERVAL_MS = 250;

export interface PhotonToolContext {
  readonly principal: VerifiedMessagingPrincipal;
  readonly config: PhotonConfig;
  readonly store: PhotonStore;
}

/**
 * Verified messaging principal plus enabled channel configuration. Throws a
 * descriptive error when the session is not a Photon messaging session or
 * the channel is disabled so tools degrade cleanly outside the channel.
 */
export function photonContext(ctx: ToolContext): PhotonToolContext {
  const principal = messagingPrincipal(ctx);
  if (!principal) throw new Error("This tool requires a Photon messaging session.");
  const config = loadPhotonConfig();
  if (!config) throw new Error("Photon channel is not enabled.");
  return { principal, config, store: getPhotonStore(config) };
}

/**
 * Resolves the durable conversation bound to this session. The stamped
 * binding id wins; a chat+source attribute pair is the compatibility path
 * and the Eve session mapping is the last fallback. A missing or retired
 * binding is fatal — tools must not guess a destination.
 */
export async function resolveConversation(
  store: PhotonStore,
  principal: VerifiedMessagingPrincipal,
  sessionId?: string,
): Promise<ConversationRow> {
  let conversation = principal.bindingId
    ? await store.getConversationById(principal.bindingId)
    : principal.chatGuid && principal.sourceId
      ? await store.getConversation(principal.sourceId, principal.chatGuid)
      : undefined;
  conversation ??= sessionId ? await store.findConversationBySession(sessionId) : undefined;
  if (!conversation || conversation.retiredAt)
    throw new Error("The conversation bound to this session is unavailable. Ask the user to start a new conversation.");
  if (conversation.scope !== principal.audience)
    throw new Error("The conversation binding does not match this session's audience.");
  return conversation;
}

export interface PhotonScope extends PhotonToolContext {
  readonly conversation: ConversationRow;
  readonly sessionId: string;
  readonly toolCallId: string;
}

/** photonContext plus the bound conversation — the normal tool entrypoint. */
export async function photonScope(ctx: ToolContext): Promise<PhotonScope> {
  const context = photonContext(ctx);
  const conversation = await resolveConversation(context.store, context.principal, ctx.session.id);
  return { ...context, conversation, sessionId: ctx.session.id, toolCallId: ctx.callId };
}

/** The verified principal must belong to the private direct conversation. */
export function assertPrivateAudience(ctx: ToolContext): VerifiedMessagingPrincipal {
  const principal = messagingPrincipal(ctx);
  if (!principal) throw new Error("This tool requires a Photon messaging session.");
  if (principal.audience !== "direct")
    throw new Error("This action requires the private conversation. Continue in a direct message instead.");
  return principal;
}

/** The verified principal must belong to an admitted group conversation. */
export function assertGroupAudience(ctx: ToolContext): VerifiedMessagingPrincipal {
  const principal = messagingPrincipal(ctx);
  if (!principal) throw new Error("This tool requires a Photon messaging session.");
  if (principal.audience !== "group")
    throw new Error("This action requires an admitted group conversation.");
  return principal;
}

/* ------------------------------------------------------------------ */
/* Outbound commands                                                   */
/* ------------------------------------------------------------------ */

/**
 * Command args with `chat` omitted: chat-scoped operations always bind to
 * the resolved conversation server-side, so a model can never steer a
 * command into a different provider chat.
 */
export type BoundCommandArgs<Op extends PhotonCommandOp> = Omit<PhotonCommandArgs<Op>, "chat">;

export interface EnqueuePhotonOptions {
  /** Extra routing/correlation metadata stored with the command row. */
  readonly target?: Record<string, unknown>;
  /** Deterministic dedupe key override; defaults to a per-tool-call key. */
  readonly semanticKey?: string;
  /** Command ids that must settle before the worker executes this one. */
  readonly dependsOn?: readonly string[];
  /** ISO timestamp after which the command expires instead of executing. */
  readonly expiresAt?: string;
}

/**
 * Validates arguments against the frozen operation contract, binds the
 * command to the verified principal and conversation, and appends it to the
 * durable outbox. Accepts either a ToolContext (resolving the scope itself)
 * or a pre-resolved PhotonScope so a tool can reuse its binding.
 */
export async function enqueuePhotonCommand<Op extends PhotonCommandOp>(
  ctx: ToolContext | PhotonScope,
  operation: Op,
  args: BoundCommandArgs<Op>,
  opts: EnqueuePhotonOptions = {},
): Promise<{ commandId: string; deduplicated: boolean }> {
  const scope = "conversation" in ctx ? ctx : await photonScope(ctx);
  const schema = commandArgsSchemas[operation] as z.ZodObject;
  const bound = "chat" in schema.shape ? { ...args, chat: scope.conversation.chatGuid } : args;
  let parsed: PhotonCommandArgs<Op>;
  try {
    parsed = validateCommandArgs(operation, bound);
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Zod issue messages name expectations, not supplied values, so this
      // stays free of message bodies and other sensitive content.
      const detail = error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid ${operation} arguments: ${detail}`);
    }
    throw error;
  }
  const commandId = randomUUID();
  const command: PhotonCommand<Op> = {
    commandId,
    operation,
    args: parsed,
    argsDigest: sha256Hex(canonicalTupleJson([parsed])),
    initiatorPrincipal: scope.principal.principal.id,
    audience: scope.principal.audience,
    sourceId: scope.conversation.sourceId,
    chatGuid: scope.conversation.chatGuid,
    target: opts.target ?? (isReadOperation(operation) ? { requestId: commandId } : undefined),
    semanticKey:
      opts.semanticKey ??
      semanticKeyFor({
        sessionId: scope.sessionId,
        outputKind: operation,
        toolCallId: scope.toolCallId,
        commandId,
      }),
    dependsOn: opts.dependsOn ?? [],
    expiresAt: opts.expiresAt,
  };
  return scope.store.enqueueCommand(command);
}

/**
 * Enqueues a fire-and-forget mutation command and returns the standard
 * agent-facing `{ status: "queued", commandId, deduplicated }` receipt.
 */
export async function queuePhotonCommand<Op extends PhotonCommandOp>(
  ctx: ToolContext | PhotonScope,
  operation: Op,
  args: BoundCommandArgs<Op>,
  opts: EnqueuePhotonOptions = {},
): Promise<{ status: "queued"; commandId: string; deduplicated: boolean }> {
  const { commandId, deduplicated } = await enqueuePhotonCommand(ctx, operation, args, opts);
  return { status: "queued", commandId, deduplicated };
}

/**
 * Enqueues a command and waits up to `COMMAND_RESULT_TIMEOUT_MS` for the
 * worker to settle it.
 */
export async function runPhotonCommand<Op extends PhotonCommandOp>(
  scope: PhotonScope,
  operation: Op,
  args: BoundCommandArgs<Op>,
  signal?: AbortSignal,
  opts: EnqueuePhotonOptions = {},
): Promise<PhotonCommandReceipt<Op>> {
  const { commandId } = await enqueuePhotonCommand(scope, operation, args, opts);
  return awaitCommandResult(scope.store, commandId, operation, undefined, signal);
}

/* ------------------------------------------------------------------ */
/* Command results                                                     */
/* ------------------------------------------------------------------ */

/**
 * A settled (or still-running) durable command. `result` is typed by the
 * operation the caller enqueued — the executor's emitted shape lives in
 * `PhotonCommandResultMap`, so projections never read provider fields off
 * the receipt root.
 */
export type PhotonCommandReceipt<Op extends PhotonCommandOp = PhotonCommandOp> =
  | {
      readonly status: "acknowledged";
      readonly commandId: string;
      readonly result?: PhotonCommandResult<Op>;
      readonly providerReceipt?: unknown;
    }
  | { readonly status: "ambiguous"; readonly commandId: string; readonly reason?: string }
  | { readonly status: "failed"; readonly commandId: string; readonly errorCode?: string }
  | { readonly status: "cancelled" | "expired"; readonly commandId: string }
  | { readonly status: "pending"; readonly commandId: string };

/**
 * Polls the durable command row until it settles or the timeout expires.
 * Reads ride the outbox for durability, and the Eve process shares Postgres
 * with the worker, so the result lands in the same command row. A timeout
 * returns `pending` — the caller can retry or check later without losing
 * the durable command identity. `operation` is the caller-declared op: it
 * types the returned `result` and must match the op that was enqueued —
 * awaiting a command row under the wrong op is a caller bug and throws.
 */
export async function awaitCommandResult<Op extends PhotonCommandOp>(
  store: PhotonDb,
  commandId: string,
  operation: Op,
  timeoutMs = COMMAND_RESULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<PhotonCommandReceipt<Op>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const row = await store.getCommand(commandId);
    if (row && row.operation !== operation)
      throw new Error(`Command ${commandId} is ${row.operation}, not ${operation}.`);
    switch (row?.status) {
      case "acknowledged":
        return {
          status: "acknowledged",
          commandId,
          result: row.result as PhotonCommandResult<Op> | undefined,
          providerReceipt: row.providerReceipt,
        };
      case "ambiguous":
        return { status: "ambiguous", commandId, reason: row.errorDetail ?? row.errorCode };
      case "failed":
        return { status: "failed", commandId, errorCode: row.errorCode };
      case "cancelled":
        return { status: "cancelled", commandId };
      case "expired":
        return { status: "expired", commandId };
      default:
        break;
    }
    if (Date.now() >= deadline) return { status: "pending", commandId };
    await new Promise((resolve) => setTimeout(resolve, RESULT_POLL_INTERVAL_MS));
  }
}

/* ------------------------------------------------------------------ */
/* Artifacts and media                                                 */
/* ------------------------------------------------------------------ */

/** Model-supplied file bytes accepted by media-bearing tools. */
export const modelFileInputSchema = z
  .object({
    dataUrl: z.string().min(16).max(140_000_000).optional(),
    base64: z.string().min(4).max(140_000_000).optional(),
    mediaType: z.string().min(3).max(255).optional(),
    fileName: z.string().min(1).max(255).optional(),
  })
  .strict()
  .refine((value) => (value.dataUrl === undefined) !== (value.base64 === undefined), {
    message: "exactly one of dataUrl or base64 is required",
  });
export type ModelFileInput = z.infer<typeof modelFileInputSchema>;


function decodeBase64Bytes(value: string, limit: number, field: string): Uint8Array {
  const compact = value.replace(/\s+/g, "");
  // base64 expands to 3 bytes per 4 chars — reject on encoded length first.
  if (compact.length > Math.ceil(limit / 3) * 4)
    throw new Error(`${field} exceeds the ${limit}-byte limit once decoded.`);
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact))
    throw new Error(`${field} is not valid base64.`);
  return Buffer.from(compact, "base64");
}

/**
 * Decodes a base64 or base64 `data:` URL payload, bounded by the artifact
 * budget before touching the bytes. The media type is taken from the data
 * URL when the caller did not supply one.
 */
export function decodeMediaInput(
  input: ModelFileInput,
  maxBytes: number,
): { data: Uint8Array; mediaType: string } {
  let data: Uint8Array;
  let mediaType = input.mediaType;
  if (input.dataUrl !== undefined) {
    const match = /^data:([^;,]+)?;base64,(.+)$/s.exec(input.dataUrl);
    if (!match) throw new Error("dataUrl must be a base64 data: URL such as data:image/png;base64,....");
    mediaType = mediaType ?? match[1];
    data = decodeBase64Bytes(match[2], maxBytes, "dataUrl");
  } else if (input.base64 !== undefined) {
    data = decodeBase64Bytes(input.base64, maxBytes, "base64");
  } else {
    throw new Error("File bytes are required as base64 or a base64 data: URL.");
  }
  if (!mediaType) throw new Error("mediaType is required when it is not carried by the data: URL.");
  return { data, mediaType };
}

export interface StagedPhotonFile {
  readonly artifactId: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly fileName?: string;
}

/**
 * Stages bounded bytes into the durable artifact store so a worker command
 * (upload, card image, background, icon) can resolve them later. Returns the
 * artifact identity used in args and dependsOn chains.
 */
export async function uploadModelFile(
  scope: PhotonScope,
  input: { data: Uint8Array; mediaType: string; fileName?: string; attachmentGuid?: string },
): Promise<StagedPhotonFile> {
  if (input.data.byteLength === 0) throw new Error("The supplied file is empty.");
  if (input.data.byteLength > scope.config.worker.maxArtifactBytes)
    throw new Error(`The supplied file exceeds the ${scope.config.worker.maxArtifactBytes}-byte artifact limit.`);
  const fileName = input.fileName ? sanitizeFileName(input.fileName) : undefined;
  const artifactId = await scope.store.putArtifact({
    sourceId: scope.conversation.sourceId,
    chatGuid: scope.conversation.chatGuid,
    attachmentGuid: input.attachmentGuid,
    fileName,
    mediaType: input.mediaType,
    data: input.data,
  });
  return {
    artifactId,
    byteSize: input.data.byteLength,
    mediaType: input.mediaType,
    fileName,
  };
}

/** Metadata of a staged artifact without loading its bytes. */
export interface StagedArtifactRef {
  readonly artifactId: string;
  readonly attachmentGuid?: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly fileName?: string;
}

/**
 * Finds the newest artifact staged for a provider attachment GUID in this
 * conversation — metadata only, through the store facade.
 */
export async function findStagedArtifact(
  scope: PhotonScope,
  attachmentGuid: string,
): Promise<StagedArtifactRef | undefined> {
  return scope.store.findArtifactByAttachment(
    scope.conversation.sourceId,
    scope.conversation.chatGuid,
    attachmentGuid,
  );
}

/** Whether an artifact row belongs to this conversation's source and chat. */
export function artifactInConversation(
  scope: PhotonScope,
  artifact: { sourceId: string; chatGuid: string } | undefined,
): artifact is { sourceId: string; chatGuid: string } {
  return (
    artifact !== undefined &&
    artifact.sourceId === scope.conversation.sourceId &&
    artifact.chatGuid === scope.conversation.chatGuid
  );
}

/** Enqueues one logical provider upload per staged artifact (deduplicated). */
export async function enqueueArtifactUpload(
  scope: PhotonScope,
  input: { artifactId: string; fileName: string; companionArtifactId?: string },
): Promise<{ commandId: string; deduplicated: boolean }> {
  return enqueuePhotonCommand(
    scope,
    "attachments.upload",
    {
      fileName: sanitizeFileName(input.fileName),
      artifactId: input.artifactId,
      companionArtifactId: input.companionArtifactId,
    },
    {
      semanticKey: semanticKeyFor({
        sessionId: scope.sessionId,
        outputKind: "attachments.upload",
        partId: input.artifactId,
      }),
    },
  );
}

/**
 * Extracts the provider attachment GUID from a command result. Only the
 * `attachments.upload` member of the result map carries `attachmentGuid`;
 * status probes on other ops simply resolve `undefined`.
 */
export function uploadedAttachmentGuid(
  result: PhotonCommandResult<PhotonCommandOp> | undefined,
): string | undefined {
  return result && "attachmentGuid" in result ? result.attachmentGuid : undefined;
}

export type ResolvedAttachment =
  | { readonly resolved: true; readonly attachmentGuid: string; readonly dependsOn: readonly string[] }
  | { readonly resolved: false; readonly receipt: PhotonCommandReceipt };

/**
 * Ensures provider-side bytes exist for an outgoing attachment. A supplied
 * attachmentGuid is used as-is; a staged artifact is uploaded once through
 * the deduplicated upload command and awaited so the send can chain on the
 * returned GUID; inline bytes are staged first. An unsettled upload returns
 * `resolved: false` so the tool can report pending without double-sending.
 */
export async function resolveAttachmentGuid(
  scope: PhotonScope,
  input: { attachmentGuid?: string; artifactId?: string; file?: ModelFileInput },
  signal?: AbortSignal,
): Promise<ResolvedAttachment> {
  if (input.attachmentGuid) {
    await assertTargetInConversation(scope, "attachment", input.attachmentGuid, "The attachment");
    return { resolved: true, attachmentGuid: input.attachmentGuid, dependsOn: [] };
  }
  let artifactId = input.artifactId;
  if (!artifactId && input.file) {
    const decoded = decodeMediaInput(input.file, scope.config.worker.maxArtifactBytes);
    const staged = await uploadModelFile(scope, {
      data: decoded.data,
      mediaType: decoded.mediaType,
      fileName: sanitizeFileName(input.file.fileName),
    });
    artifactId = staged.artifactId;
  }
  if (!artifactId)
    throw new Error("An attachmentGuid, artifactId, or inline file is required.");
  const artifact = await scope.store.getArtifact(artifactId);
  if (!artifactInConversation(scope, artifact))
    throw new Error("The referenced media artifact is unavailable in this conversation.");
  if (artifact.attachmentGuid)
    return { resolved: true, attachmentGuid: artifact.attachmentGuid, dependsOn: [] };
  const upload = await enqueueArtifactUpload(scope, {
    artifactId,
    fileName: artifact.fileName ?? "attachment",
  });
  const receipt = await awaitCommandResult(
    scope.store,
    upload.commandId,
    "attachments.upload",
    undefined,
    signal,
  );
  const guid = receipt.status === "acknowledged" ? receipt.result?.attachmentGuid : undefined;
  if (receipt.status === "acknowledged" && guid)
    return { resolved: true, attachmentGuid: guid, dependsOn: [upload.commandId] };
  return { resolved: false, receipt };
}

/**
 * Stages inline file bytes (when supplied) or validates an existing staged
 * artifactId against the conversation scope and an allowed media-type set.
 */
export async function resolveStagedImageArtifact(
  scope: PhotonScope,
  input: { artifactId?: string; file?: ModelFileInput },
  options: {
    readonly allowedMediaTypes: ReadonlySet<string>;
    readonly fallbackFileName: string;
    readonly typeError: string;
    readonly missingError: string;
  },
): Promise<string> {
  let artifactId = input.artifactId;
  if (input.file) {
    const decoded = decodeMediaInput(input.file, scope.config.worker.maxArtifactBytes);
    if (!options.allowedMediaTypes.has(decoded.mediaType.toLowerCase()))
      throw new Error(options.typeError);
    artifactId = (
      await uploadModelFile(scope, {
        data: decoded.data,
        mediaType: decoded.mediaType,
        fileName: sanitizeFileName(input.file.fileName, options.fallbackFileName),
      })
    ).artifactId;
  }
  if (!artifactId) throw new Error("An artifactId or file is required.");
  const artifact = await scope.store.getArtifact(artifactId);
  if (!artifactInConversation(scope, artifact)) throw new Error(options.missingError);
  if (!options.allowedMediaTypes.has(artifact.mediaType.toLowerCase()))
    throw new Error(options.typeError);
  return artifactId;
}

/** Standard tool output when a dependent media upload has not settled yet. */
export function uploadPendingResponse(receipt: PhotonCommandReceipt, label: string) {
  return {
    status: receipt.status,
    commandId: receipt.commandId,
    stage: "upload" as const,
    detail:
      receipt.status === "pending" || receipt.status === "ambiguous"
        ? `The ${label} upload is still in flight. Retry once it is acknowledged.`
        : `The ${label} upload did not complete.`,
  };
}

/**
 * The provider's card layout rules beyond the schema: at least one primary
 * text slot or an image is required (summary alone is insufficient), image
 * and imageTitle must be supplied together, and imageSubtitle requires
 * image.
 */
export function assertValidCardLayout(layout: {
  caption?: string;
  subcaption?: string;
  trailingCaption?: string;
  trailingSubcaption?: string;
  image?: string;
  imageTitle?: string;
  imageSubtitle?: string;
}): void {
  const hasPrimaryText = [
    layout.caption,
    layout.subcaption,
    layout.trailingCaption,
    layout.trailingSubcaption,
  ].some((value) => typeof value === "string" && value.length > 0);
  if (!hasPrimaryText && layout.image === undefined)
    throw new Error(
      "The card layout needs a caption, subcaption, trailingCaption, trailingSubcaption, or image.",
    );
  if (layout.image !== undefined && layout.imageTitle === undefined)
    throw new Error("layout.image and layout.imageTitle must be supplied together.");
  if (layout.image === undefined && layout.imageTitle !== undefined)
    throw new Error("layout.imageTitle requires layout.image.");
  if (layout.imageSubtitle !== undefined && layout.image === undefined)
    throw new Error("layout.imageSubtitle requires layout.image.");
}

/**
 * A card layout image is a staged artifactId, not raw bytes — the worker
 * resolves it into the JPEG payload the card primitive requires. The
 * artifact must belong to this conversation and carry an image/jpeg type.
 */
export async function assertCardImageArtifact(
  scope: PhotonScope,
  layout: { image?: string },
): Promise<void> {
  if (layout.image === undefined) return;
  const artifact = await scope.store.getArtifact(layout.image);
  if (!artifactInConversation(scope, artifact))
    throw new Error("The card image artifact is unavailable in this conversation.");
  if (artifact.mediaType !== "image/jpeg")
    throw new Error("The card image must be a staged JPEG artifact (mediaType image/jpeg).");
}

/** Validates and sends a customized mini-app card, awaiting the card session. */
export async function sendMiniAppCard(
  scope: PhotonScope,
  card: z.infer<typeof customizedMiniAppSchema>,
  signal?: AbortSignal,
): Promise<PhotonCommandReceipt<"messages.sendCustomizedMiniApp">> {
  assertValidCardLayout(card.layout);
  await assertCardImageArtifact(scope, card.layout);
  return runPhotonCommand(scope, "messages.sendCustomizedMiniApp", { message: card }, signal);
}

/* ------------------------------------------------------------------ */
/* Target and payload safety                                           */
/* ------------------------------------------------------------------ */

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Verifies a message/poll/attachment GUID belongs to this conversation
 * before a tool targets it. Group sessions fail closed on unknown or
 * unverifiable resources; the operator DM may still reference resources the
 * worker has not projected yet, since the account is its own boundary.
 */
export async function assertTargetInConversation(
  scope: PhotonScope,
  kind: ResourceKind,
  guid: string,
  label: string,
): Promise<void> {
  const resource = await scope.store.getResource(scope.conversation.sourceId, kind, guid);
  const group = scope.principal.audience === "group";
  if (!resource || resource.tombstone) {
    if (group) throw new Error(`${label} is not tracked in this conversation.`);
    return;
  }
  const data = resource.data;
  const single = nonEmptyString(data.chatGuid) ?? nonEmptyString(data.chat_guid);
  const list = Array.isArray(data.chatGuids)
    ? data.chatGuids.filter((value): value is string => typeof value === "string")
    : [];
  if (single !== undefined || list.length > 0) {
    if (single === scope.conversation.chatGuid || list.includes(scope.conversation.chatGuid)) return;
    throw new Error(`${label} belongs to a different conversation.`);
  }
  if (group) throw new Error(`${label} cannot be verified against this conversation.`);
}

/* ------------------------------------------------------------------ */
/* Compact JSON projections                                            */
/* ------------------------------------------------------------------ */

export function isoTimestamp(value: Date | string | null | undefined): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Bounded, agent-facing projection of provider AttachmentInfo. */
export function projectAttachmentInfo(
  info: AttachmentInfo | undefined,
): Record<string, unknown> | undefined {
  if (!info) return undefined;
  return {
    guid: info.guid,
    fileName: info.fileName,
    mimeType: info.mimeType,
    uti: info.uti,
    totalBytes: info.totalBytes,
    transferState: info.transferState,
    isHidden: info.isHidden,
    isOutgoing: info.isOutgoing,
    isSticker: info.isSticker,
    companionKind: info.companionKind,
    originalGuid: info.originalGuid,
  };
}
