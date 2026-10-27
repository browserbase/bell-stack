import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import {
  customizedMiniAppSchema,
  miniAppCardSessionSchema,
} from "../../server/photon/contracts.js";
import {
  assertCardImageArtifact,
  assertValidCardLayout,
  photonScope,
  runPhotonCommand,
  sendMiniAppCard,
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
    switch (input.action) {
      case "send": {
        const receipt = await sendMiniAppCard(scope, input.card, ctx.abortSignal);
        const result = receipt.status === "acknowledged" ? receipt.result : undefined;
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          session: result?.miniAppCardSession,
          messageGuid: result?.message.guid,
        };
      }
      case "update": {
        assertValidCardLayout(input.card.layout);
        await assertCardImageArtifact(scope, input.card.layout);
        // The model holds a card's message guid (or the sessionId from a
        // send's session object) — either resolves to the authoritative
        // session the executor persisted, keyed by sessionId.
        const index = await scope.store.getResource(
          scope.conversation.sourceId,
          "miniapp_session_by_message",
          input.messageGuid,
        );
        const indexedSessionId =
          index && !index.tombstone && typeof index.data.sessionId === "string" && index.data.sessionId.length > 0
            ? index.data.sessionId
            : undefined;
        const resource = await scope.store.getResource(
          scope.conversation.sourceId,
          "miniapp_session",
          indexedSessionId ?? input.messageGuid,
        );
        const parsed =
          resource && !resource.tombstone
            ? miniAppCardSessionSchema.safeParse(resource.data.session)
            : undefined;
        if (!parsed?.success)
          throw new Error(
            "No mini-app session is persisted for that message. Only cards sent through this channel can be updated.",
          );
        if (parsed.data.chatGuid !== scope.conversation.chatGuid)
          throw new Error("The stored mini-app session belongs to a different conversation.");
        const receipt = await runPhotonCommand(
          scope,
          "messages.updateCustomizedMiniApp",
          { session: parsed.data, message: input.card },
          ctx.abortSignal,
        );
        const result = receipt.status === "acknowledged" ? receipt.result : undefined;
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          session: result?.miniAppCardSession,
        };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
