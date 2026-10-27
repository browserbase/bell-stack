import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import {
  customizedMiniAppSchema,
  miniAppCardSessionSchema,
} from "../../server/photon/contracts.js";
import {
  assertCardImageArtifact,
  assertValidCardLayout,
  awaitCommandResult,
  enqueuePhotonCommand,
  photonScope,
} from "../lib/photon-tools";

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("send"),
      card: customizedMiniAppSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      messageGuid: z.string().min(1).max(512),
      card: customizedMiniAppSchema,
    })
    .strict(),
]);

export default defineTool({
  description:
    "Send or update a customized iMessage mini-app card in the current conversation. send takes the native card object: appName, extensionBundleId (no colon), teamId (10 uppercase alphanumerics), an absolute http(s) url delivered to the installed extension, optional appStoreId, optional live:true for the recipient's installed extension UI (absent extension renders the static fallback — send success does not prove live rendering), and layout {caption, subcaption, trailingCaption, trailingSubcaption, imageTitle, imageSubtitle, summary, image}; image is a staged JPEG artifactId from photon_media upload and requires imageTitle. send waits up to ~8s and returns the card session {chatGuid, messageGuid, sessionId, targetMessageGuid}. update replaces a card in place using the messageGuid returned by an earlier send — the durable session is resolved server-side, and the call fails when no mini-app session is persisted for that message.",
  inputSchema,
  async execute(input, ctx) {
    const scope = await photonScope(ctx);
    assertValidCardLayout(input.card.layout);
    await assertCardImageArtifact(scope, input.card.layout);
    switch (input.action) {
      case "send": {
        const { commandId } = await enqueuePhotonCommand(
          scope,
          "messages.sendCustomizedMiniApp",
          { message: input.card },
        );
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        const result = receipt.status === "acknowledged" ? receipt.result : undefined;
        const session =
          result && typeof result === "object" && "miniAppCardSession" in result
            ? (result as Record<string, unknown>).miniAppCardSession
            : undefined;
        return {
          status: receipt.status,
          commandId,
          session,
          messageGuid:
            result && typeof result === "object"
              ? (result as Record<string, unknown>).guid
              : undefined,
        };
      }
      case "update": {
        const resource = await scope.store.getResource(
          scope.conversation.sourceId,
          "miniapp_session",
          input.messageGuid,
        );
        const parsed = resource && !resource.tombstone
          ? miniAppCardSessionSchema.safeParse(resource.data)
          : undefined;
        if (!parsed?.success)
          throw new Error(
            "No mini-app session is persisted for that message. Only cards sent through this channel can be updated.",
          );
        if (parsed.data.chatGuid !== scope.conversation.chatGuid)
          throw new Error("The stored mini-app session belongs to a different conversation.");
        const { commandId } = await enqueuePhotonCommand(
          scope,
          "messages.updateCustomizedMiniApp",
          { session: parsed.data, message: input.card },
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
        };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
