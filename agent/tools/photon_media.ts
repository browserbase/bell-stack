import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import {
  assertTargetInConversation,
  awaitCommandResult,
  decodeMediaInput,
  enqueueArtifactUpload,
  enqueuePhotonCommand,
  findStagedArtifact,
  modelFileInputSchema,
  photonScope,
  projectAttachmentInfo,
  sanitizeFileName,
  uploadModelFile,
  uploadedAttachmentGuid,
} from "../lib/photon-tools";

const companionInputSchema = z
  .object({
    dataUrl: z.string().min(16).max(140_000_000).optional(),
    base64: z.string().min(4).max(140_000_000).optional(),
    mediaType: z.string().min(3).max(255).optional(),
  })
  .strict()
  .refine((value) => (value.dataUrl === undefined) !== (value.base64 === undefined), {
    message: "exactly one of dataUrl or base64 is required",
  });

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("upload"),
      file: modelFileInputSchema,
      companion: companionInputSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("download"),
      attachmentGuid: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      action: z.literal("status"),
      commandId: z.string().min(8).max(128),
    })
    .strict(),
]);

export default defineTool({
  description:
    "Stage and inspect iMessage media. upload stores base64/dataUrl bytes as a durable artifact (add a companion video for a Live Photo pair), queues the provider upload, waits up to ~8s, and returns the artifactId plus the provider attachmentGuid once acknowledged — pass either to photon_message sendAttachment or photon_reaction placeSticker. download takes an inbound attachmentGuid, reports its provider metadata (filename, MIME type, size, transferState: pending/transferring/failed/finished/unknown) and any staged artifact reference for the bytes. Byte content stays in the artifact store; the tool never returns file payloads inline. status re-checks a previously returned commandId (e.g. a pending upload) and returns its outcome including the attachmentGuid once acknowledged. If an upload or read is still running the result is {status:'pending', commandId} — retry or check later rather than resending.",
  inputSchema,
  async execute(input, ctx) {
    const scope = await photonScope(ctx);
    switch (input.action) {
      case "upload": {
        const decoded = decodeMediaInput(input.file, scope.config.worker.maxArtifactBytes);
        const staged = await uploadModelFile(scope, {
          data: decoded.data,
          mediaType: decoded.mediaType,
          fileName: sanitizeFileName(input.file.fileName),
        });
        let companionArtifactId: string | undefined;
        if (input.companion) {
          const companion = decodeMediaInput(
            { ...input.companion, mediaType: input.companion.mediaType ?? "video/quicktime" },
            scope.config.worker.maxArtifactBytes,
          );
          companionArtifactId = (
            await uploadModelFile(scope, {
              data: companion.data,
              mediaType: companion.mediaType,
              fileName: "live-photo-companion.mov",
            })
          ).artifactId;
        }
        const upload = await enqueueArtifactUpload(scope, {
          artifactId: staged.artifactId,
          fileName: staged.fileName ?? "attachment",
          companionArtifactId,
        });
        const receipt = await awaitCommandResult(
          scope.store,
          upload.commandId,
          undefined,
          ctx.abortSignal,
        );
        const attachmentGuid =
          receipt.status === "acknowledged" ? uploadedAttachmentGuid(receipt.result) : undefined;
        return {
          status: receipt.status,
          commandId: upload.commandId,
          artifactId: staged.artifactId,
          companionArtifactId,
          attachmentGuid,
          byteSize: staged.byteSize,
          mediaType: staged.mediaType,
          fileName: staged.fileName,
        };
      }
      case "download": {
        await assertTargetInConversation(scope, "attachment", input.attachmentGuid, "The attachment");
        const staged = await findStagedArtifact(scope, input.attachmentGuid);
        const { commandId } = await enqueuePhotonCommand(scope, "attachments.get", {
          attachmentGuid: input.attachmentGuid,
        });
        const receipt = await awaitCommandResult(
          scope.store,
          commandId,
          undefined,
          ctx.abortSignal,
        );
        return {
          status: receipt.status,
          commandId,
          attachment:
            receipt.status === "acknowledged"
              ? (projectAttachmentInfo(receipt.result) ?? null)
              : undefined,
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
          artifact: staged
            ? {
                artifactId: staged.artifactId,
                byteSize: staged.byteSize,
                mediaType: staged.mediaType,
                fileName: staged.fileName,
              }
            : undefined,
          stagedBytes: staged !== undefined,
        };
      }
      case "status": {
        const row = await scope.store.getCommand(input.commandId);
        if (
          !row ||
          row.sourceId !== scope.conversation.sourceId ||
          row.chatGuid !== scope.conversation.chatGuid
        )
          throw new Error("That command is not available in this conversation.");
        const receipt = await awaitCommandResult(
          scope.store,
          input.commandId,
          1_000,
          ctx.abortSignal,
        );
        const attachmentGuid =
          receipt.status === "acknowledged" ? uploadedAttachmentGuid(receipt.result) : undefined;
        return {
          status: receipt.status,
          commandId: input.commandId,
          attachmentGuid,
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
