import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import {
  settableReactionSchema,
  stickerPlacementSchema,
} from "../../server/photon/contracts.js";
import {
  assertTargetInConversation,
  enqueuePhotonCommand,
  modelFileInputSchema,
  photonScope,
  resolveAttachmentGuid,
} from "../lib/photon-tools";

const guid = z.string().min(1).max(512);

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set"),
      messageGuid: guid,
      reaction: settableReactionSchema,
      partIndex: z.number().int().min(0).max(255).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("remove"),
      messageGuid: guid,
      reaction: settableReactionSchema,
      partIndex: z.number().int().min(0).max(255).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("placeSticker"),
      messageGuid: guid,
      stickerAttachmentGuid: guid.optional(),
      artifactId: z.string().min(1).max(256).optional(),
      file: modelFileInputSchema.optional(),
      placement: stickerPlacementSchema,
      partIndex: z.number().int().min(0).max(255).optional(),
    })
    .strict()
    .refine(
      (value) =>
        [value.stickerAttachmentGuid, value.artifactId, value.file].filter(
          (entry) => entry !== undefined,
        ).length === 1,
      { message: "exactly one of stickerAttachmentGuid, artifactId, or file is required" },
    ),
]);

export default defineTool({
  description:
    "Add or remove a tapback, or place a sticker, on a message in the current conversation. set/remove take a native reaction (love, like, dislike, laugh, emphasize, question) or {customEmoji:'…'}; partIndex targets one bubble of a multipart message. placeSticker puts an uploaded sticker image onto a specific bubble: supply stickerAttachmentGuid (a provider GUID from photon_media upload), a staged artifactId, or inline file bytes, plus placement {x,y} in Apple's normalized bubble coordinates (0.5,0.5 is centered — not screen pixels) with optional scale, rotation, and width. There is no sticker-removal API. Returns {status:'queued', commandId} once the durable command is accepted, or 'pending' while a sticker upload is still in flight.",
  inputSchema,
  async execute(input, ctx) {
    const scope = await photonScope(ctx);
    switch (input.action) {
      case "set":
      case "remove": {
        await assertTargetInConversation(scope, "message", input.messageGuid, "The target message");
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "messages.setReaction",
          {
            messageGuid: input.messageGuid,
            reaction: input.reaction,
            isSet: input.action === "set",
            partIndex: input.partIndex,
          },
        );
        return { status: "queued", commandId, deduplicated };
      }
      case "placeSticker": {
        await assertTargetInConversation(scope, "message", input.messageGuid, "The target message");
        const resolved = await resolveAttachmentGuid(
          scope,
          {
            attachmentGuid: input.stickerAttachmentGuid,
            artifactId: input.artifactId,
            file: input.file,
          },
          ctx.abortSignal,
        );
        if (!resolved.resolved) {
          const receipt = resolved.receipt;
          return {
            status: receipt.status,
            commandId: receipt.commandId,
            stage: "upload",
            detail:
              receipt.status === "pending" || receipt.status === "ambiguous"
                ? "The sticker upload is still in flight. Retry once it is acknowledged."
                : "The sticker upload did not complete.",
          };
        }
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "messages.placeSticker",
          {
            messageGuid: input.messageGuid,
            stickerAttachmentGuid: resolved.attachmentGuid,
            placement: input.placement,
            partIndex: input.partIndex,
          },
          { dependsOn: resolved.dependsOn },
        );
        return { status: "queued", commandId, deduplicated };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
