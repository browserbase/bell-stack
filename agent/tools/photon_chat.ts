import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import { backgroundPresetSchema, effectSchema } from "../../server/photon/contracts.js";
import {
  artifactInConversation,
  asArray,
  asNumber,
  asRecord,
  asString,
  assertPrivateAudience,
  awaitCommandResult,
  decodeMediaInput,
  enqueuePhotonCommand,
  modelFileInputSchema,
  photonScope,
  sanitizeFileName,
  uploadModelFile,
} from "../lib/photon-tools";

const BACKGROUND_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);
const TYPING_COMMAND_TTL_MS = 90_000;

const address = z.string().min(3).max(320);

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get") }).strict(),
  z
    .object({
      action: z.literal("count"),
      includeArchived: z.boolean().optional(),
    })
    .strict(),
  z.object({ action: z.literal("markRead") }).strict(),
  z
    .object({
      action: z.literal("setTyping"),
      isTyping: z.boolean(),
    })
    .strict(),
  z.object({ action: z.literal("shareContactInfo") }).strict(),
  z.object({ action: z.literal("hasBackground") }).strict(),
  z
    .object({
      action: z.literal("setBackground"),
      preset: backgroundPresetSchema.optional(),
      artifactId: z.string().min(1).max(256).optional(),
      file: modelFileInputSchema.optional(),
    })
    .strict()
    .refine(
      (value) =>
        [value.preset, value.artifactId, value.file].filter((entry) => entry !== undefined)
          .length === 1,
      { message: "exactly one of preset, artifactId, or file is required" },
    ),
  z.object({ action: z.literal("removeBackground") }).strict(),
  z
    .object({
      action: z.literal("create"),
      addresses: z.array(address).min(1).max(100),
      message: z.string().max(64_000).optional(),
      subject: z.string().max(1024).optional(),
      effect: effectSchema.optional(),
    })
    .strict(),
]);

/** Compact projection of a provider Chat snapshot for the model. */
function projectChat(value: unknown): Record<string, unknown> | undefined {
  const chat = asRecord(value);
  if (!chat) return undefined;
  return {
    guid: asString(chat.guid),
    displayName: asString(chat.displayName),
    isGroup: chat.isGroup === true,
    service: asString(chat.service),
    isArchived: chat.isArchived === true,
    isFiltered: chat.isFiltered === true,
    unreadCount: asNumber(chat.unreadCount),
    participants: asArray(chat.participants).map((entry) => {
      const participant = asRecord(entry);
      return {
        address: asString(participant?.address),
        service: asString(participant?.service),
        country: asString(participant?.country),
      };
    }),
  };
}

export default defineTool({
  description:
    "Inspect and manage the current iMessage conversation. get returns chat identity, participants, service and unread state; count totals chats on the account (optionally including archived). markRead marks every unread message in this chat read — it is chat-wide, not per-message. setTyping shows or clears the typing indicator; typing commands expire quickly and are never replayed. shareContactInfo sends the account's own native contact card. hasBackground reports whether a custom background is set; setBackground applies one of the 24 named presets or a JPEG/PNG/HEIC image (staged artifactId or inline file bytes); removeBackground clears it — a successful set means submitted, not that every device rendered it. create opens a new DM (one address) or group (two or more) with an optional opening message and is restricted to the private conversation. Mutations return {status:'queued', commandId}; reads and create wait up to ~8s and return 'acknowledged' data or 'pending'.",
  inputSchema,
  async execute(input, ctx) {
    if (input.action === "create") assertPrivateAudience(ctx);
    const scope = await photonScope(ctx);
    switch (input.action) {
      case "get": {
        const { commandId } = await enqueuePhotonCommand(scope, "chats.get", {});
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        return {
          status: receipt.status,
          commandId,
          chat: receipt.status === "acknowledged" ? projectChat(receipt.result) : undefined,
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "count": {
        const { commandId } = await enqueuePhotonCommand(scope, "chats.count", {
          includeArchived: input.includeArchived,
        });
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        const raw = receipt.status === "acknowledged" ? receipt.result : undefined;
        return {
          status: receipt.status,
          commandId,
          count: typeof raw === "number" ? raw : asNumber(asRecord(raw)?.count),
        };
      }
      case "markRead": {
        const { commandId, deduplicated } = await enqueuePhotonCommand(scope, "chats.markRead", {});
        return { status: "queued", commandId, deduplicated };
      }
      case "setTyping": {
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "chats.setTyping",
          { isTyping: input.isTyping },
          { expiresAt: new Date(Date.now() + TYPING_COMMAND_TTL_MS).toISOString() },
        );
        return { status: "queued", commandId, deduplicated };
      }
      case "shareContactInfo": {
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "chats.shareContactInfo",
          {},
        );
        return { status: "queued", commandId, deduplicated };
      }
      case "hasBackground": {
        const { commandId } = await enqueuePhotonCommand(scope, "chats.hasBackground", {});
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        const raw = receipt.status === "acknowledged" ? receipt.result : undefined;
        const record = asRecord(raw);
        return {
          status: receipt.status,
          commandId,
          hasBackground:
            typeof raw === "boolean"
              ? raw
              : typeof record?.hasBackground === "boolean"
                ? record.hasBackground
                : undefined,
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "setBackground": {
        if (input.preset !== undefined) {
          const { commandId, deduplicated } = await enqueuePhotonCommand(
            scope,
            "chats.setBackground",
            { preset: input.preset },
          );
          return { status: "queued", commandId, deduplicated };
        }
        let artifactId = input.artifactId;
        if (input.file) {
          const decoded = decodeMediaInput(input.file, scope.config.worker.maxArtifactBytes);
          if (!BACKGROUND_MEDIA_TYPES.has(decoded.mediaType))
            throw new Error("Chat backgrounds must be JPEG, PNG, HEIC, or HEIF images.");
          artifactId = (
            await uploadModelFile(scope, {
              data: decoded.data,
              mediaType: decoded.mediaType,
              fileName: sanitizeFileName(input.file.fileName, "background"),
            })
          ).artifactId;
        }
        if (!artifactId) throw new Error("A preset, artifactId, or file is required.");
        const artifact = await scope.store.getArtifact(artifactId);
        if (!artifactInConversation(scope, artifact))
          throw new Error("The referenced background artifact is unavailable in this conversation.");
        if (!BACKGROUND_MEDIA_TYPES.has(artifact.mediaType))
          throw new Error("Chat backgrounds must be JPEG, PNG, HEIC, or HEIF images.");
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "chats.setBackground",
          { artifactId },
        );
        return { status: "queued", commandId, deduplicated };
      }
      case "removeBackground": {
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "chats.removeBackground",
          {},
        );
        return { status: "queued", commandId, deduplicated };
      }
      case "create": {
        const { commandId } = await enqueuePhotonCommand(scope, "chats.create", {
          addresses: input.addresses,
          message: input.message,
          subject: input.subject,
          effect: input.effect,
        });
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        const result = asRecord(receipt.status === "acknowledged" ? receipt.result : undefined);
        return {
          status: receipt.status,
          commandId,
          chat: projectChat(result?.chat),
          initialMessageGuid: asString(asRecord(result?.initialMessage)?.guid),
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
