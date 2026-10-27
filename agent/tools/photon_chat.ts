import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import {
  backgroundPresetSchema,
  effectSchema,
  type Chat,
} from "../../server/photon/contracts.js";
import {
  assertPrivateAudience,
  modelFileInputSchema,
  photonScope,
  queuePhotonCommand,
  resolveStagedImageArtifact,
  runPhotonCommand,
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
function projectChat(chat: Chat | undefined): Record<string, unknown> | undefined {
  if (!chat) return undefined;
  return {
    guid: chat.guid,
    displayName: chat.displayName,
    isGroup: chat.isGroup === true,
    service: chat.service,
    isArchived: chat.isArchived === true,
    isFiltered: chat.isFiltered === true,
    unreadCount: chat.unreadCount,
    participants: (chat.participants ?? []).map((participant) => ({
      address: participant.address,
      service: participant.service,
      country: participant.country,
    })),
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
        const receipt = await runPhotonCommand(scope, "chats.get", {}, ctx.abortSignal);
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          chat: receipt.status === "acknowledged" ? projectChat(receipt.result) : undefined,
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "count": {
        const receipt = await runPhotonCommand(
          scope,
          "chats.count",
          { includeArchived: input.includeArchived },
          ctx.abortSignal,
        );
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          count: receipt.status === "acknowledged" ? receipt.result?.count : undefined,
        };
      }
      case "markRead":
        return queuePhotonCommand(scope, "chats.markRead", {});
      case "setTyping":
        return queuePhotonCommand(
          scope,
          "chats.setTyping",
          { isTyping: input.isTyping },
          { expiresAt: new Date(Date.now() + TYPING_COMMAND_TTL_MS).toISOString() },
        );
      case "shareContactInfo":
        return queuePhotonCommand(scope, "chats.shareContactInfo", {});
      case "hasBackground": {
        const receipt = await runPhotonCommand(scope, "chats.hasBackground", {}, ctx.abortSignal);
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          hasBackground:
            receipt.status === "acknowledged" ? receipt.result?.hasBackground : undefined,
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "setBackground": {
        if (input.preset !== undefined)
          return queuePhotonCommand(scope, "chats.setBackground", { preset: input.preset });
        const artifactId = await resolveStagedImageArtifact(scope, input, {
          allowedMediaTypes: BACKGROUND_MEDIA_TYPES,
          fallbackFileName: "background",
          typeError: "Chat backgrounds must be JPEG, PNG, HEIC, or HEIF images.",
          missingError: "The referenced background artifact is unavailable in this conversation.",
        });
        return queuePhotonCommand(scope, "chats.setBackground", { artifactId });
      }
      case "removeBackground":
        return queuePhotonCommand(scope, "chats.removeBackground", {});
      case "create": {
        const receipt = await runPhotonCommand(
          scope,
          "chats.create",
          {
            addresses: input.addresses,
            message: input.message,
            subject: input.subject,
            effect: input.effect,
          },
          ctx.abortSignal,
        );
        const result = receipt.status === "acknowledged" ? receipt.result : undefined;
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          chat: projectChat(result?.chat),
          initialMessageGuid: result?.initialMessageGuid,
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
