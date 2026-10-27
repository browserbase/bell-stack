import { defineTool, toolOutput, type ToolContext } from "eve/tools";
import { z } from "zod";

import type { ConversationRow } from "../../server/photon/store.js";
import {
  artifactInConversation,
  assertGroupAudience,
  modelFileInputSchema,
  photonScope,
  queuePhotonCommand,
  resolveStagedImageArtifact,
  runPhotonCommand,
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
    if (input.action !== "getIcon") assertMutationOwner(ctx, scope.conversation);
    switch (input.action) {
      case "setDisplayName":
        return queuePhotonCommand(scope, "groups.setDisplayName", { name: input.name.trim() });
      case "addParticipants":
        return queuePhotonCommand(scope, "groups.addParticipants", { addresses: input.addresses });
      case "removeParticipants":
        return queuePhotonCommand(scope, "groups.removeParticipants", { addresses: input.addresses });
      case "leave":
        return queuePhotonCommand(scope, "groups.leave", {});
      case "setIcon": {
        const artifactId = await resolveStagedImageArtifact(scope, input, {
          allowedMediaTypes: GROUP_ICON_MEDIA_TYPES,
          fallbackFileName: "group-icon",
          typeError: "Group icons must be PNG, JPEG, GIF, HEIC, or HEIF images.",
          missingError: "The referenced icon artifact is unavailable in this conversation.",
        });
        return queuePhotonCommand(scope, "groups.setIcon", { artifactId });
      }
      case "getIcon": {
        const receipt = await runPhotonCommand(scope, "groups.getIcon", {}, ctx.abortSignal);
        if (receipt.status === "failed" && receipt.errorCode && /not.?found/i.test(receipt.errorCode))
          return { status: "acknowledged", commandId: receipt.commandId, icon: null };
        if (receipt.status !== "acknowledged")
          return { status: receipt.status, commandId: receipt.commandId };
        const result = receipt.result;
        // The executor already staged the icon bytes into this
        // conversation's artifact store — the result is the artifact
        // reference itself, so there is nothing to re-stage.
        if (!result || "icon" in result)
          return { status: "acknowledged", commandId: receipt.commandId, icon: null };
        const artifact = await scope.store.getArtifact(result.artifactId);
        if (!artifactInConversation(scope, artifact))
          throw new Error("The group icon artifact is unavailable in this conversation.");
        return {
          status: "acknowledged",
          commandId: receipt.commandId,
          icon: {
            artifactId: result.artifactId,
            mediaType: result.mimeType,
            byteSize: result.byteSize,
          },
        };
      }
      case "removeIcon":
        return queuePhotonCommand(scope, "groups.removeIcon", {});
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
