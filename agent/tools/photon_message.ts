import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import {
  customizedMiniAppSchema,
  effectSchema,
  messagePartSchema,
  replyTargetSchema,
  textEffectSchema,
  textFormatSchema,
} from "../../server/photon/contracts.js";
import {
  assertCardImageArtifact,
  assertTargetInConversation,
  assertValidCardLayout,
  awaitCommandResult,
  enqueuePhotonCommand,
  modelFileInputSchema,
  photonScope,
  resolveAttachmentGuid,
} from "../lib/photon-tools";

const guid = z.string().min(1).max(512);
const partIndex = z.number().int().min(0).max(255);

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("send"),
      text: z
        .string()
        .min(1)
        .max(64_000)
        .refine((value) => value.trim().length > 0, "text must contain non-whitespace content"),
      subject: z.string().max(1024).optional(),
      effect: effectSchema.optional(),
      enableDataDetection: z.boolean().optional(),
      enableLinkPreview: z.boolean().optional(),
      formatting: z.array(z.union([textFormatSchema, textEffectSchema])).max(64).optional(),
      replyTo: replyTargetSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("sendMultipart"),
      parts: z.array(messagePartSchema).min(1).max(64),
      subject: z.string().max(1024).optional(),
      effect: effectSchema.optional(),
      replyTo: replyTargetSchema.optional(),
      enableDataDetection: z.boolean().optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.parts.every((part) => {
          const hasText = part.text !== undefined || part.mentionedAddress !== undefined;
          const hasAttachment = part.attachmentGuid !== undefined;
          return hasText !== hasAttachment;
        }),
      { message: "each part must be exactly one of a text/mention part or an attachment part" },
    ),
  z
    .object({
      action: z.literal("sendAttachment"),
      attachmentGuid: guid.optional(),
      artifactId: z.string().min(1).max(256).optional(),
      file: modelFileInputSchema.optional(),
      isAudioMessage: z.boolean().optional(),
      effect: effectSchema.optional(),
      replyTo: replyTargetSchema.optional(),
    })
    .strict()
    .refine(
      (value) =>
        [value.attachmentGuid, value.artifactId, value.file].filter((entry) => entry !== undefined)
          .length === 1,
      { message: "exactly one of attachmentGuid, artifactId, or file is required" },
    ),
  z
    .object({
      action: z.literal("edit"),
      messageGuid: guid,
      newText: z.string().min(1).max(64_000),
      backwardCompatText: z.string().max(64_000).optional(),
      partIndex: partIndex.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("unsend"),
      messageGuid: guid,
      partIndex: partIndex.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("sendMiniApp"),
      card: customizedMiniAppSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("notifySilenced"),
      messageGuid: guid,
    })
    .strict(),
]);

export default defineTool({
  description:
    "Send, edit, or retract iMessage content in the current conversation. Actions: send (plain text with optional subject, bubble/screen effect, UTF-16 formatting ranges, link preview, data detection, replyTo threading), sendMultipart (ordered text/mention/attachment bubbles), sendAttachment (a previously uploaded attachmentGuid, a staged artifactId from photon_media upload, or inline base64/dataUrl file bytes; set isAudioMessage for a native voice note), sendMiniApp (a customized iMessage app card — photon_app also sends and updates cards), edit and unsend (own messages within Apple's 15-minute/2-minute windows), notifySilenced (Apple's Notify Anyway — only when the user asked for urgent delivery). Every send is durable: the tool returns {status:'queued', commandId} once the outbox accepts it, 'acknowledged' with the provider result for card sends, or 'pending' while a required upload is still in flight — never claim delivery before the provider acknowledges it.",
  inputSchema,
  async execute(input, ctx) {
    const scope = await photonScope(ctx);
    switch (input.action) {
      case "send": {
        const { commandId, deduplicated } = await enqueuePhotonCommand(scope, "messages.sendText", {
          text: input.text,
          subject: input.subject,
          effect: input.effect,
          enableDataDetection: input.enableDataDetection,
          enableLinkPreview: input.enableLinkPreview,
          formatting: input.formatting,
          replyTo: input.replyTo,
        });
        return { status: "queued", commandId, deduplicated };
      }
      case "sendMultipart": {
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "messages.sendMultipart",
          {
            parts: input.parts,
            subject: input.subject,
            effect: input.effect,
            replyTo: input.replyTo,
            enableDataDetection: input.enableDataDetection,
          },
        );
        return { status: "queued", commandId, deduplicated };
      }
      case "sendAttachment": {
        const resolved = await resolveAttachmentGuid(scope, input, ctx.abortSignal);
        if (!resolved.resolved) {
          const receipt = resolved.receipt;
          return {
            status: receipt.status,
            commandId: receipt.commandId,
            stage: "upload",
            detail:
              receipt.status === "pending" || receipt.status === "ambiguous"
                ? "The media upload is still in flight. Retry this send once it is acknowledged."
                : "The media upload did not complete.",
          };
        }
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "messages.sendAttachment",
          {
            attachmentGuid: resolved.attachmentGuid,
            isAudioMessage: input.isAudioMessage,
            effect: input.effect,
            replyTo: input.replyTo,
          },
          { dependsOn: resolved.dependsOn },
        );
        return { status: "queued", commandId, deduplicated };
      }
      case "edit": {
        await assertTargetInConversation(scope, "message", input.messageGuid, "The target message");
        const { commandId, deduplicated } = await enqueuePhotonCommand(scope, "messages.edit", {
          messageGuid: input.messageGuid,
          newText: input.newText,
          backwardCompatText: input.backwardCompatText,
          partIndex: input.partIndex,
        });
        return { status: "queued", commandId, deduplicated };
      }
      case "unsend": {
        await assertTargetInConversation(scope, "message", input.messageGuid, "The target message");
        const { commandId, deduplicated } = await enqueuePhotonCommand(scope, "messages.unsend", {
          messageGuid: input.messageGuid,
          partIndex: input.partIndex,
        });
        return { status: "queued", commandId, deduplicated };
      }
      case "sendMiniApp": {
        assertValidCardLayout(input.card.layout);
        await assertCardImageArtifact(scope, input.card.layout);
        const { commandId } = await enqueuePhotonCommand(
          scope,
          "messages.sendCustomizedMiniApp",
          { message: input.card },
        );
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        const result = receipt.status === "acknowledged" ? receipt.result : undefined;
        return {
          status: receipt.status,
          commandId,
          session:
            result && typeof result === "object" && "miniAppCardSession" in result
              ? (result as Record<string, unknown>).miniAppCardSession
              : undefined,
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "notifySilenced": {
        await assertTargetInConversation(scope, "message", input.messageGuid, "The target message");
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "messages.notifySilenced",
          { messageGuid: input.messageGuid },
        );
        return { status: "queued", commandId, deduplicated };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
