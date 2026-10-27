import {
  IMessageError,
  type AdvancedIMessage,
  type BackgroundPreset,
  type Chat,
} from "@photon-ai/advanced-imessage/grpc";

import type {
  PhotonCommand,
  PhotonCommandDeps,
  PhotonCommandExecutor,
  PhotonCommandOp,
} from "../contracts.js";
import { CommandValidationError, commandProviderKey, executeOp, mapEffect } from "./shared.js";
import { handleKey, normalizeHandle } from "../identity.js";
import type { PhotonDb } from "../store.js";

/**
 * chats.* and groups.* executors. There is deliberately no archive/unarchive
 * write: the provider exposes those as inbound observations only. Group
 * mutations use native group GUIDs and the line's own permissions.
 */

async function persistChat(store: PhotonDb, sourceId: string, chat: Chat): Promise<void> {
  await store.upsertResource(sourceId, "chat", chat.guid, {
    displayName: chat.displayName,
    groupId: chat.groupId ?? null,
    isArchived: chat.isArchived,
    isGroup: chat.isGroup,
    participants: chat.participants.map((participant) => {
      const handle = normalizeHandle(participant.address);
      return {
        address: participant.address,
        key: handle ? handleKey(handle) : null,
        service: participant.service,
      };
    }),
    service: chat.service,
    snapshotAt: new Date().toISOString(),
  });
}

/** Group-icon uploads are bitmap formats Messages accepts. */
const ICON_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/heic", "image/heif"]);

async function requireArtifact(
  deps: PhotonCommandDeps,
  artifactId: string,
): Promise<{ data: Uint8Array; fileName?: string; mediaType: string }> {
  const artifact = await deps.artifacts.get(artifactId);
  if (!artifact)
    throw new CommandValidationError("artifact_not_found", `Artifact ${artifactId} does not exist.`);
  return artifact;
}

/**
 * Unkeyed mutations reconcile against `chats.get`: a landed change is
 * detected by desired state, an absent one is safe to retry, and a chat that
 * cannot be read stays ambiguous.
 */
function chatReconcile(
  check: (chat: Chat) => boolean,
): (command: PhotonCommand, deps: PhotonCommandDeps) => Promise<boolean | undefined> {
  return async (command, deps) => {
    const client = deps.client.raw as AdvancedIMessage;
    try {
      return check(await client.chats.get(command.chatGuid));
    } catch {
      return undefined;
    }
  };
}

async function hasBackgroundReconcile(
  command: PhotonCommand,
  deps: PhotonCommandDeps,
  expected: boolean,
): Promise<boolean | undefined> {
  const client = deps.client.raw as AdvancedIMessage;
  try {
    return (await client.chats.hasBackground(command.chatGuid)) === expected;
  } catch {
    return undefined;
  }
}

export function conversationExecutors(
  store: PhotonDb,
): Partial<Record<PhotonCommandOp, PhotonCommandExecutor>> {
  return {
    "chats.create": executeOp("chats.create", async (client, args, command) => {
      const created = await client.chats.create([...args.addresses], {
        clientMessageId: commandProviderKey(command),
        effect: mapEffect(args.effect),
        message: args.message,
        subject: args.subject,
      });
      await persistChat(store, command.sourceId, created.chat);
      return {
        result: { chat: created.chat, initialMessageGuid: created.initialMessage?.guid },
        receipt: { chatGuid: created.chat.guid },
      };
    }),

    "chats.get": executeOp("chats.get", async (client, args, command) => {
      const chat = await client.chats.get(args.chat);
      await persistChat(store, command.sourceId, chat);
      return { result: chat };
    }),

    "chats.count": executeOp("chats.count", async (client, args) => {
      const count = await client.chats.count({ includeArchived: args.includeArchived });
      return { result: { count } };
    }),

    // Unkeyed: unreadCount is the provider's own desired-state check, so a
    // landed markRead reconciles to acknowledged instead of duplicating.
    "chats.markRead": executeOp("chats.markRead", async (client, args) => {
      await client.chats.markRead(args.chat);
      return { result: { marked: true } };
    }, chatReconcile((chat) => chat.unreadCount === 0)),

    // Typing state is ephemeral by definition: an uncertain outcome has no
    // durable effect to reconcile, so it settles as applied.
    "chats.setTyping": executeOp("chats.setTyping", async (client, args) => {
      await client.chats.setTyping(args.chat, args.isTyping);
      return { result: { isTyping: args.isTyping } };
    }, () => Promise.resolve(true)),

    // No read verifies the shared contact card; uncertainty stays ambiguous.
    "chats.shareContactInfo": executeOp("chats.shareContactInfo", async (client, args) => {
      await client.chats.shareContactInfo(args.chat);
      return { result: { shared: true } };
    }),

    "chats.hasBackground": executeOp("chats.hasBackground", async (client, args) => {
      const hasBackground = await client.chats.hasBackground(args.chat);
      return { result: { hasBackground } };
    }),

    "chats.setBackground": executeOp("chats.setBackground", async (client, args, _command, deps) => {
      let background: Uint8Array | BackgroundPreset;
      if (args.preset !== undefined) {
        background = args.preset;
      } else if (args.artifactId !== undefined) {
        const artifact = await requireArtifact(deps, args.artifactId);
        if (!artifact.mediaType.toLowerCase().startsWith("image/"))
          throw new CommandValidationError("invalid_background", "Chat background artifact must be an image.");
        background = artifact.data;
      } else {
        throw new CommandValidationError("invalid_args", "Exactly one of preset or artifactId is required.");
      }
      await client.chats.setBackground(args.chat, background);
      return { result: { set: true } };
    }, (command, deps) => hasBackgroundReconcile(command, deps, true)),

    "chats.removeBackground": executeOp("chats.removeBackground", async (client, args) => {
      await client.chats.removeBackground(args.chat);
      return { result: { removed: true } };
    }, (command, deps) => hasBackgroundReconcile(command, deps, false)),

    "groups.setDisplayName": executeOp("groups.setDisplayName", async (client, args, command) => {
      const chat = await client.groups.setDisplayName(args.chat, args.name, {
        clientMessageId: commandProviderKey(command),
      });
      await persistChat(store, command.sourceId, chat);
      return { result: chat };
    }),

    "groups.addParticipants": executeOp("groups.addParticipants", async (client, args, command) => {
      const chat = await client.groups.addParticipants(args.chat, [...args.addresses], {
        clientMessageId: commandProviderKey(command),
      });
      await persistChat(store, command.sourceId, chat);
      return { result: chat };
    }),

    "groups.removeParticipants": executeOp("groups.removeParticipants", async (client, args, command) => {
      const chat = await client.groups.removeParticipants(args.chat, [...args.addresses], {
        clientMessageId: commandProviderKey(command),
      });
      await persistChat(store, command.sourceId, chat);
      return { result: chat };
    }),

    "groups.leave": executeOp("groups.leave", async (client, args, command) => {
      await client.groups.leave(args.chat, { clientMessageId: commandProviderKey(command) });
      // Leaving retires this binding's inbound scope; a later generation is
      // only admitted through a fresh explicit invite.
      const binding = await store.getConversation(command.sourceId, args.chat);
      if (binding) await store.retireConversation(binding.bindingId);
      return { result: { left: true } };
    }),

    "groups.setIcon": executeOp("groups.setIcon", async (client, args, command, deps) => {
      const artifact = await requireArtifact(deps, args.artifactId);
      if (!ICON_MEDIA_TYPES.has(artifact.mediaType.toLowerCase()))
        throw new CommandValidationError(
          "invalid_icon",
          `Group icon must be PNG, JPEG, GIF, HEIC or HEIF; got ${artifact.mediaType}.`,
        );
      await client.groups.setIcon(args.chat, artifact.data, {
        clientMessageId: commandProviderKey(command),
      });
      return { result: { set: true } };
    }),

    "groups.getIcon": executeOp("groups.getIcon", async (client, args, _command, deps) => {
      try {
        const icon = await client.groups.getIcon(args.chat);
        const artifactId = await deps.artifacts.put({
          chatGuid: args.chat,
          fileName: `group-icon-${args.chat.slice(-12)}`,
          mediaType: icon.mimeType,
          data: icon.data,
        });
        return { result: { artifactId, mimeType: icon.mimeType, byteSize: icon.data.byteLength } };
      } catch (error) {
        if (error instanceof IMessageError && error.code === "groupIconNotFound")
          return { result: { icon: null } };
        throw error;
      }
    }),

    "groups.removeIcon": executeOp("groups.removeIcon", async (client, args, command) => {
      await client.groups.removeIcon(args.chat, { clientMessageId: commandProviderKey(command) });
      return { result: { removed: true } };
    }),
  };
}
