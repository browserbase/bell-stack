import type {
  CustomizedMiniAppMessage,
  Message,
  MessageListFilter,
  MiniAppCardSession,
} from "@photon-ai/advanced-imessage/grpc";

import type {
  PhotonCommandOp,
  PhotonCommandExecutor,
} from "../contracts.js";
import type { PhotonDb } from "../store.js";
import { resolveMiniAppSession } from "./interactions.js";
import {
  CommandValidationError,
  commandProviderKey,
  executeOp,
  mapEffect,
  mapFormatting,
  mapParts,
  mapReaction,
  mapReplyTo,
} from "./shared.js";

/**
 * messages.* executors: sends, edits, unsends, reactions, stickers, Notify
 * Anyway, mini-app cards, history reads and embedded media. Every keyed
 * write carries the command's deterministic provider key.
 */

function messageReceipt(message: Message | undefined): Record<string, unknown> | undefined {
  return message ? { messageGuid: message.guid, chatGuids: [...message.chatGuids] } : undefined;
}

async function persistSentMessage(store: PhotonDb, sourceId: string, message: Message): Promise<void> {
  await store.upsertResource(sourceId, "message", message.guid, {
    chatGuids: [...message.chatGuids],
    sentByBell: true,
    subject: message.subject ?? null,
    partCount: message.partCount ?? null,
    sentAt: new Date().toISOString(),
  });
}

function listFilter(filter: {
  after?: string; before?: string; isFromMe?: boolean; isRead?: boolean;
  pageSize?: number; pageToken?: string;
} | undefined): MessageListFilter | undefined {
  if (!filter) return undefined;
  return {
    after: filter.after ? new Date(filter.after) : undefined,
    before: filter.before ? new Date(filter.before) : undefined,
    isFromMe: filter.isFromMe,
    isRead: filter.isRead,
    pageSize: filter.pageSize,
    pageToken: filter.pageToken,
  };
}

function miniAppMessage(input: {
  appName: string; appStoreId?: number; extensionBundleId: string; teamId: string;
  url: string; live?: boolean;
  layout: {
    caption?: string; subcaption?: string; trailingCaption?: string;
    trailingSubcaption?: string; image?: string; imageTitle?: string;
    imageSubtitle?: string; summary?: string;
  };
}, image: Uint8Array | undefined): CustomizedMiniAppMessage {
  const layout = input.layout;
  const hasPrimaryText = !!(layout.caption || layout.subcaption || layout.trailingCaption || layout.trailingSubcaption);
  if (!hasPrimaryText && image === undefined)
    throw new CommandValidationError(
      "invalid_layout",
      "A mini-app card needs at least one primary text slot or an image.",
    );
  return {
    appName: input.appName,
    appStoreId: input.appStoreId,
    extensionBundleId: input.extensionBundleId,
    teamId: input.teamId,
    url: input.url,
    live: input.live,
    layout: {
      caption: layout.caption,
      subcaption: layout.subcaption,
      trailingCaption: layout.trailingCaption,
      trailingSubcaption: layout.trailingSubcaption,
      image,
      imageTitle: layout.imageTitle,
      imageSubtitle: layout.imageSubtitle,
      summary: layout.summary,
    },
  };
}

async function persistMiniAppSession(
  store: PhotonDb,
  sourceId: string,
  session: MiniAppCardSession,
): Promise<void> {
  await store.upsertResource(sourceId, "miniapp_session", session.sessionId, {
    session, updatedAt: new Date().toISOString(),
  });
}

export function messageExecutors(
  store: PhotonDb,
): Partial<Record<PhotonCommandOp, PhotonCommandExecutor>> {
  return {
    "messages.sendText": executeOp("messages.sendText", async (client, args, command) => {
      const message = await client.messages.sendText(args.chat, args.text, {
        clientMessageId: commandProviderKey(command),
        effect: mapEffect(args.effect),
        enableDataDetection: args.enableDataDetection,
        enableLinkPreview: args.enableLinkPreview,
        formatting: mapFormatting(args.formatting),
        replyTo: mapReplyTo(args.replyTo),
        subject: args.subject,
      });
      await persistSentMessage(store, command.sourceId, message);
      return { result: message, receipt: messageReceipt(message) };
    }),

    "messages.sendAttachment": executeOp("messages.sendAttachment", async (client, args, command) => {
      const message = await client.messages.sendAttachment(args.chat, args.attachmentGuid, {
        clientMessageId: commandProviderKey(command),
        effect: mapEffect(args.effect),
        isAudioMessage: args.isAudioMessage,
        replyTo: mapReplyTo(args.replyTo),
      });
      await persistSentMessage(store, command.sourceId, message);
      return { result: message, receipt: messageReceipt(message) };
    }),

    "messages.sendMultipart": executeOp("messages.sendMultipart", async (client, args, command) => {
      const message = await client.messages.sendMultipart(args.chat, mapParts(args.parts), {
        clientMessageId: commandProviderKey(command),
        effect: mapEffect(args.effect),
        replyTo: mapReplyTo(args.replyTo),
        subject: args.subject,
        enableDataDetection: args.enableDataDetection,
      });
      await persistSentMessage(store, command.sourceId, message);
      return { result: message, receipt: messageReceipt(message) };
    }),

    "messages.sendCustomizedMiniApp": executeOp("messages.sendCustomizedMiniApp", async (client, args, command, deps) => {
      // layout.image carries an artifact reference, never raw model bytes.
      let image: Uint8Array | undefined;
      if (args.message.layout.image !== undefined) {
        const artifact = await deps.artifacts.get(args.message.layout.image);
        if (!artifact)
          throw new CommandValidationError("artifact_not_found", `Layout image artifact ${args.message.layout.image} does not exist.`);
        if (artifact.mediaType.toLowerCase() !== "image/jpeg")
          throw new CommandValidationError("invalid_layout", "Mini-app card images must be JPEG.");
        image = artifact.data;
      }
      const result = await client.messages.sendCustomizedMiniApp(
        args.chat,
        miniAppMessage(args.message, image),
        { clientMessageId: commandProviderKey(command) },
      );
      await persistMiniAppSession(store, command.sourceId, result.miniAppCardSession);
      await persistSentMessage(store, command.sourceId, result);
      return {
        result: { message: result, miniAppCardSession: result.miniAppCardSession },
        receipt: { messageGuid: result.guid, sessionId: result.miniAppCardSession.sessionId },
      };
    }),

    "messages.updateCustomizedMiniApp": executeOp("messages.updateCustomizedMiniApp", async (client, args, command, deps) => {
      const session = await resolveMiniAppSession(store, command.sourceId, args.session, command.chatGuid);
      let image: Uint8Array | undefined;
      if (args.message.layout.image !== undefined) {
        const artifact = await deps.artifacts.get(args.message.layout.image);
        if (!artifact)
          throw new CommandValidationError("artifact_not_found", `Layout image artifact ${args.message.layout.image} does not exist.`);
        if (artifact.mediaType.toLowerCase() !== "image/jpeg")
          throw new CommandValidationError("invalid_layout", "Mini-app card images must be JPEG.");
        image = artifact.data;
      }
      const result = await client.messages.updateCustomizedMiniApp(
        session,
        miniAppMessage(args.message, image),
        { clientMessageId: commandProviderKey(command) },
      );
      await persistMiniAppSession(store, command.sourceId, result.miniAppCardSession);
      return {
        result: { message: result, miniAppCardSession: result.miniAppCardSession },
        receipt: { messageGuid: result.guid, sessionId: result.miniAppCardSession.sessionId },
      };
    }),

    "messages.edit": executeOp("messages.edit", async (client, args, command) => {
      const message = await client.messages.edit(args.chat, args.messageGuid, args.newText, {
        clientMessageId: commandProviderKey(command),
        backwardCompatText: args.backwardCompatText,
        partIndex: args.partIndex,
      });
      return { result: message, receipt: messageReceipt(message) };
    }),

    "messages.unsend": executeOp("messages.unsend", async (client, args, command) => {
      await client.messages.unsend(args.chat, args.messageGuid, {
        clientMessageId: commandProviderKey(command),
        partIndex: args.partIndex,
      });
      await store.upsertResource(command.sourceId, "message", args.messageGuid,
        { unsentAt: new Date().toISOString() }, { tombstone: true });
      return { result: { unsent: true } };
    }),

    "messages.setReaction": executeOp("messages.setReaction", async (client, args, command) => {
      const message = await client.messages.setReaction(
        args.chat, args.messageGuid, mapReaction(args.reaction), args.isSet,
        { clientMessageId: commandProviderKey(command), partIndex: args.partIndex },
      );
      return { result: message, receipt: messageReceipt(message) };
    }),

    "messages.placeSticker": executeOp("messages.placeSticker", async (client, args, command) => {
      const message = await client.messages.placeSticker(
        args.chat, args.messageGuid, args.stickerAttachmentGuid, args.placement,
        { clientMessageId: commandProviderKey(command), partIndex: args.partIndex },
      );
      return { result: message, receipt: messageReceipt(message) };
    }),

    "messages.notifySilenced": executeOp("messages.notifySilenced", async (client, args, command) => {
      await client.messages.notifySilenced(args.chat, args.messageGuid, {
        clientMessageId: commandProviderKey(command),
      });
      return { result: { notified: true } };
    }),

    "messages.get": executeOp("messages.get", async (client, args, command) => {
      const message = await client.messages.get(args.messageGuid);
      await store.upsertResource(command.sourceId, "message", message.guid, { snapshot: message });
      return { result: message };
    }),

    "messages.listInChat": executeOp("messages.listInChat", async (client, args) => {
      const page = await client.messages.listInChat(args.chat, listFilter(args.filter));
      return { result: page };
    }),

    "messages.listRecent": executeOp("messages.listRecent", async (client, args) => {
      const page = await client.messages.listRecent(listFilter(args.filter));
      return { result: page };
    }),

    "messages.getEmbeddedMedia": executeOp("messages.getEmbeddedMedia", async (client, args, command, deps) => {
      const media = await client.messages.getEmbeddedMedia(args.chat, args.messageGuid);
      const artifactId = await deps.artifacts.put({
        chatGuid: args.chat,
        fileName: `embedded-${args.messageGuid}`,
        mediaType: media.mimeType,
        data: media.data,
      });
      await store.upsertResource(command.sourceId, "attachment", `embedded:${args.messageGuid}`, {
        artifactId, mediaType: media.mimeType, messageGuid: args.messageGuid,
      });
      return { result: { artifactId, mediaType: media.mimeType, byteSize: media.data.byteLength } };
    }),
  };
}
