import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import { messageListFilterSchema } from "../../server/photon/contracts.js";
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  assertPrivateAudience,
  assertTargetInConversation,
  awaitCommandResult,
  coerceBytes,
  enqueuePhotonCommand,
  photonScope,
  projectAttachmentInfo,
  uploadModelFile,
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

function isoOrRaw(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

/** Bounded agent-facing projection of a provider Message snapshot. */
function summarizeMessage(value: unknown): Record<string, unknown> {
  const message = asRecord(value) ?? {};
  const content = asRecord(message.content) ?? {};
  const sender = asRecord(message.sender);
  const text = asString(content.text);
  return {
    guid: asString(message.guid),
    sender: asString(sender?.address) ?? (asBoolean(message.isFromMe) ? "self" : undefined),
    isFromMe: asBoolean(message.isFromMe),
    text:
      text === undefined
        ? undefined
        : text.length > TEXT_EXCERPT_LIMIT
          ? `${text.slice(0, TEXT_EXCERPT_LIMIT)}…`
          : text,
    subject: asString(message.subject),
    attachments: asArray(content.attachments)
      .map(projectAttachmentInfo)
      .filter((entry) => entry !== undefined),
    mentions: asArray(content.mentions).map((entry) => {
      const mention = asRecord(entry);
      return {
        address: asString(mention?.address),
        start: asNumber(mention?.start),
        length: asNumber(mention?.length),
      };
    }),
    partCount: asNumber(message.partCount),
    replyTargetGuid: asString(message.replyTargetGuid),
    threadOriginatorGuid: asString(message.threadOriginatorGuid),
    isAudioMessage: asBoolean(message.isAudioMessage),
    isSent: asBoolean(message.isSent),
    isDelivered: asBoolean(message.isDelivered),
    isArchived: asBoolean(message.isArchived),
    itemType: asString(message.itemType),
    dateCreated: isoOrRaw(message.dateCreated),
    dateDelivered: isoOrRaw(message.dateDelivered),
    dateRead: isoOrRaw(message.dateRead),
    appliedReactions: asArray(message.appliedReactions).map((entry) => {
      const applied = asRecord(entry);
      const reaction = asRecord(applied?.reaction);
      return {
        kind: asString(reaction?.kind),
        emoji: asString(reaction?.emoji),
        sender: asString(asRecord(applied?.sender)?.address),
      };
    }),
    placedStickers: asArray(message.placedStickers).length || undefined,
    dataDetectorResultsPresent: asBoolean(message.dataDetectorResultsPresent),
  };
}

function summarizePage(result: unknown): Record<string, unknown> {
  const page = asRecord(result);
  const messages = Array.isArray(result) ? result : asArray(page?.messages);
  return {
    messages: messages.map(summarizeMessage),
    nextPageToken: asString(page?.nextPageToken),
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
        const { commandId } = await enqueuePhotonCommand(scope, "messages.get", {
          messageGuid: input.messageGuid,
        });
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        return {
          status: receipt.status,
          commandId,
          message:
            receipt.status === "acknowledged" ? summarizeMessage(receipt.result) : undefined,
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "listInChat": {
        const { commandId } = await enqueuePhotonCommand(scope, "messages.listInChat", {
          filter: input.filter,
        });
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        return {
          status: receipt.status,
          commandId,
          ...(receipt.status === "acknowledged" ? summarizePage(receipt.result) : {}),
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "listRecent": {
        const { commandId } = await enqueuePhotonCommand(scope, "messages.listRecent", {
          filter: input.filter,
        });
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        return {
          status: receipt.status,
          commandId,
          ...(receipt.status === "acknowledged" ? summarizePage(receipt.result) : {}),
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "getEmbeddedMedia": {
        await assertTargetInConversation(scope, "message", input.messageGuid, "The message");
        const { commandId } = await enqueuePhotonCommand(scope, "messages.getEmbeddedMedia", {
          messageGuid: input.messageGuid,
        });
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        if (receipt.status !== "acknowledged")
          return {
            status: receipt.status,
            commandId,
            errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
          };
        const record = asRecord(receipt.result);
        const bytes = coerceBytes(record?.data ?? record);
        if (!bytes || bytes.byteLength === 0)
          return { status: "acknowledged", commandId, media: null };
        const staged = await uploadModelFile(scope, {
          data: bytes,
          mediaType: asString(record?.mimeType) ?? "application/octet-stream",
          fileName: "embedded-media",
        });
        return {
          status: "acknowledged",
          commandId,
          media: {
            artifactId: staged.artifactId,
            mediaType: staged.mediaType,
            byteSize: staged.byteSize,
          },
        };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
