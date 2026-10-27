import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import {
  messageListFilterSchema,
  type Message,
  type MessageListPage,
} from "../../server/photon/contracts.js";
import {
  artifactInConversation,
  assertPrivateAudience,
  assertTargetInConversation,
  isoTimestamp,
  photonScope,
  projectAttachmentInfo,
  runPhotonCommand,
} from "../lib/photon-tools";

const TEXT_EXCERPT_LIMIT = 500;

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("get"),
      messageGuid: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      action: z.literal("listInChat"),
      filter: messageListFilterSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("listRecent"),
      filter: messageListFilterSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("getEmbeddedMedia"),
      messageGuid: z.string().min(1).max(512),
    })
    .strict(),
]);

/** Bounded agent-facing projection of a provider Message snapshot. */
function summarizeMessage(message: Message | undefined): Record<string, unknown> | undefined {
  if (!message) return undefined;
  const content = message.content;
  const text = content?.text;
  return {
    guid: message.guid,
    sender: message.sender?.address ?? (message.isFromMe ? "self" : undefined),
    isFromMe: message.isFromMe,
    text:
      text === undefined
        ? undefined
        : text.length > TEXT_EXCERPT_LIMIT
          ? `${text.slice(0, TEXT_EXCERPT_LIMIT)}…`
          : text,
    subject: message.subject,
    attachments: (content?.attachments ?? [])
      .map(projectAttachmentInfo)
      .filter((entry) => entry !== undefined),
    mentions: (content?.mentions ?? []).map((mention) => ({
      address: mention.address,
      start: mention.start,
      length: mention.length,
    })),
    partCount: message.partCount,
    replyTargetGuid: message.replyTargetGuid,
    threadOriginatorGuid: message.threadOriginatorGuid,
    isAudioMessage: message.isAudioMessage,
    isSent: message.isSent,
    isDelivered: message.isDelivered,
    isArchived: message.isArchived,
    itemType: message.itemType,
    dateCreated: isoTimestamp(message.dateCreated),
    dateDelivered: isoTimestamp(message.dateDelivered),
    dateRead: isoTimestamp(message.dateRead),
    appliedReactions: (message.appliedReactions ?? []).map((applied) => ({
      kind: applied.reaction?.kind,
      emoji: applied.reaction && "emoji" in applied.reaction ? applied.reaction.emoji : undefined,
      sender: applied.sender?.address,
    })),
    placedStickers: message.placedStickers?.length || undefined,
    dataDetectorResultsPresent: message.dataDetectorResultsPresent,
  };
}

function summarizePage(page: MessageListPage | undefined): Record<string, unknown> {
  const messages = Array.isArray(page) ? page : (page?.messages ?? []);
  return {
    messages: messages.map(summarizeMessage),
    nextPageToken: Array.isArray(page) ? undefined : page?.nextPageToken,
  };
}

export default defineTool({
  description:
    "Read message history for the current iMessage conversation. get hydrates one message snapshot by GUID (attachments metadata, reply links, delivery/read state); listInChat pages this conversation's history with an optional filter {after,before,isFromMe,isRead,pageSize 1-100,pageToken} — pass the returned nextPageToken back as filter.pageToken to continue. listRecent pages account-wide history and is restricted to the private conversation. getEmbeddedMedia returns Digital Touch/handwritten media bytes for a message as a staged artifact reference rather than inline data. Results are compact summaries (guid, sender, bounded text excerpt, attachment refs, timestamps, reaction state) — never raw provider payloads. Each action waits up to ~8s and returns 'acknowledged' with data, 'failed' with errorCode, or 'pending' with commandId to retry later.",
  inputSchema,
  async execute(input, ctx) {
    if (input.action === "listRecent") assertPrivateAudience(ctx);
    const scope = await photonScope(ctx);
    switch (input.action) {
      case "get": {
        await assertTargetInConversation(scope, "message", input.messageGuid, "The message");
        const receipt = await runPhotonCommand(
          scope,
          "messages.get",
          { messageGuid: input.messageGuid },
          ctx.abortSignal,
        );
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          message:
            receipt.status === "acknowledged" ? summarizeMessage(receipt.result) : undefined,
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "listInChat": {
        const receipt = await runPhotonCommand(
          scope,
          "messages.listInChat",
          { filter: input.filter },
          ctx.abortSignal,
        );
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          ...(receipt.status === "acknowledged" ? summarizePage(receipt.result) : {}),
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "listRecent": {
        const receipt = await runPhotonCommand(
          scope,
          "messages.listRecent",
          { filter: input.filter },
          ctx.abortSignal,
        );
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          ...(receipt.status === "acknowledged" ? summarizePage(receipt.result) : {}),
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "getEmbeddedMedia": {
        await assertTargetInConversation(scope, "message", input.messageGuid, "The message");
        const receipt = await runPhotonCommand(
          scope,
          "messages.getEmbeddedMedia",
          { messageGuid: input.messageGuid },
          ctx.abortSignal,
        );
        if (receipt.status !== "acknowledged")
          return {
            status: receipt.status,
            commandId: receipt.commandId,
            errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
          };
        // The executor already staged the media bytes into this
        // conversation's artifact store — the result is the artifact
        // reference itself, so there is nothing to re-stage.
        const result = receipt.result;
        if (!result) return { status: "acknowledged", commandId: receipt.commandId, media: null };
        const artifact = await scope.store.getArtifact(result.artifactId);
        if (!artifactInConversation(scope, artifact))
          throw new Error("The embedded media artifact is unavailable in this conversation.");
        return {
          status: "acknowledged",
          commandId: receipt.commandId,
          media: {
            artifactId: result.artifactId,
            mediaType: result.mediaType,
            byteSize: result.byteSize,
          },
        };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
