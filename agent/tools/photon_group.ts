import { defineTool, toolOutput, type ToolContext } from "eve/tools";
import { z } from "zod";

import type { ConversationRow } from "../../server/photon/store.js";
import {
  artifactInConversation,
  asRecord,
  asString,
  assertGroupAudience,
  awaitCommandResult,
  coerceBytes,
  decodeMediaInput,
  enqueuePhotonCommand,
  modelFileInputSchema,
  photonScope,
  sanitizeFileName,
  uploadModelFile,
} from "../lib/photon-tools";
import { assertInitiatingOwner } from "../lib/messaging-auth";

const GROUP_ICON_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/heic",
  "image/heif",
]);

const address = z.string().min(3).max(320);

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("setDisplayName"),
      name: z
        .string()
        .min(1)
        .max(1024)
        .refine((value) => value.trim().length > 0, "name must contain non-whitespace content"),
    })
    .strict(),
  z
    .object({
      action: z.literal("addParticipants"),
      addresses: z.array(address).min(1).max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("removeParticipants"),
      addresses: z.array(address).min(1).max(100),
    })
    .strict(),
  z.object({ action: z.literal("leave") }).strict(),
  z
    .object({
      action: z.literal("setIcon"),
      artifactId: z.string().min(1).max(256).optional(),
      file: modelFileInputSchema.optional(),
    })
    .strict()
    .refine((value) => (value.artifactId === undefined) !== (value.file === undefined), {
      message: "exactly one of artifactId or file is required",
    }),
  z.object({ action: z.literal("getIcon") }).strict(),
  z.object({ action: z.literal("removeIcon") }).strict(),
]);

/**
 * Group mutations are restricted to the participant who initiated this
 * bound task; any admitted member may read the icon.
 */
function assertMutationOwner(ctx: ToolContext, conversation: ConversationRow): void {
  assertInitiatingOwner(ctx, conversation.initiatingPrincipal);
}

export default defineTool({
  description:
    "Manage the admitted group conversation this session is bound to. setDisplayName renames the group (nonempty), addParticipants and removeParticipants change membership (full phone/email addresses, subject to Apple/account permission), leave removes the account — another participant must re-invite it afterwards. setIcon applies a PNG/JPEG/GIF/HEIC image (staged artifactId or inline file bytes), getIcon returns the current icon as a staged artifact reference, removeIcon clears it. Mutations are restricted to the initiating owner of this conversation; getIcon is available to the admitted audience. Targets are always the bound group — cross-chat group GUIDs are rejected. Mutations return {status:'queued', commandId}; getIcon waits up to ~8s and returns 'acknowledged' with {icon:{artifactId,mediaType,byteSize}} or icon:null when the group has no custom icon, or 'pending'.",
  inputSchema,
  async execute(input, ctx) {
    assertGroupAudience(ctx);
    const scope = await photonScope(ctx);
    switch (input.action) {
      case "setDisplayName": {
        assertMutationOwner(ctx, scope.conversation);
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "groups.setDisplayName",
          { name: input.name.trim() },
        );
        return { status: "queued", commandId, deduplicated };
      }
      case "addParticipants": {
        assertMutationOwner(ctx, scope.conversation);
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "groups.addParticipants",
          { addresses: input.addresses },
        );
        return { status: "queued", commandId, deduplicated };
      }
      case "removeParticipants": {
        assertMutationOwner(ctx, scope.conversation);
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "groups.removeParticipants",
          { addresses: input.addresses },
        );
        return { status: "queued", commandId, deduplicated };
      }
      case "leave": {
        assertMutationOwner(ctx, scope.conversation);
        const { commandId, deduplicated } = await enqueuePhotonCommand(scope, "groups.leave", {});
        return { status: "queued", commandId, deduplicated };
      }
      case "setIcon": {
        assertMutationOwner(ctx, scope.conversation);
        let artifactId = input.artifactId;
        if (input.file) {
          const decoded = decodeMediaInput(input.file, scope.config.worker.maxArtifactBytes);
          if (!GROUP_ICON_MEDIA_TYPES.has(decoded.mediaType))
            throw new Error("Group icons must be PNG, JPEG, GIF, HEIC, or HEIF images.");
          artifactId = (
            await uploadModelFile(scope, {
              data: decoded.data,
              mediaType: decoded.mediaType,
              fileName: sanitizeFileName(input.file.fileName, "group-icon"),
            })
          ).artifactId;
        }
        if (!artifactId) throw new Error("An artifactId or file is required.");
        const artifact = await scope.store.getArtifact(artifactId);
        if (!artifactInConversation(scope, artifact))
          throw new Error("The referenced icon artifact is unavailable in this conversation.");
        if (!GROUP_ICON_MEDIA_TYPES.has(artifact.mediaType))
          throw new Error("Group icons must be PNG, JPEG, GIF, HEIC, or HEIF images.");
        const { commandId, deduplicated } = await enqueuePhotonCommand(scope, "groups.setIcon", {
          artifactId,
        });
        return { status: "queued", commandId, deduplicated };
      }
      case "getIcon": {
        const { commandId } = await enqueuePhotonCommand(scope, "groups.getIcon", {});
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        if (receipt.status === "failed" && receipt.errorCode && /not.?found/i.test(receipt.errorCode))
          return { status: "acknowledged", commandId, icon: null };
        if (receipt.status !== "acknowledged") return { status: receipt.status, commandId };
        const record = asRecord(receipt.result);
        const bytes = coerceBytes(record?.data);
        if (!bytes)
          return { status: "acknowledged", commandId, icon: null };
        const staged = await uploadModelFile(scope, {
          data: bytes,
          mediaType: asString(record?.mimeType) ?? "image/png",
          fileName: "group-icon",
        });
        return {
          status: "acknowledged",
          commandId,
          icon: {
            artifactId: staged.artifactId,
            mediaType: staged.mediaType,
            byteSize: staged.byteSize,
          },
        };
      }
      case "removeIcon": {
        assertMutationOwner(ctx, scope.conversation);
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "groups.removeIcon",
          {},
        );
        return { status: "queued", commandId, deduplicated };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
