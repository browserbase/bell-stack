import { createHash, timingSafeEqual } from "node:crypto";

import type { ChannelEvents } from "eve/channels";
import type { SessionAuthContext } from "eve/context";

import type { Message, PhotonCommand } from "../../server/photon/contracts.js";
import {
  canonicalTupleJson,
  photonSessionAuth,
  semanticKeyFor,
  sha256Hex,
  type CanonicalHandle,
} from "../../server/photon/identity.js";
import type { PhotonDb } from "../../server/photon/store.js";
import { browserChannelEvents } from "./browser-runtime";
import {
  PHOTON_ATTR_AUDIENCE,
  PHOTON_ATTR_BINDING,
  PHOTON_ATTR_CHAT,
  PHOTON_ATTR_SOURCE,
} from "./messaging-auth";

export { photonAttribute } from "./messaging-auth";

/**
 * Timing-safe check for `authorization: Bearer <internalSecret>` on the
 * private dispatch routes. Both sides are hashed before comparison so a
 * length difference never short-circuits the compare early.
 */
export function verifyInternalAuth(req: Request, secret: string): boolean {
  const header = req.headers.get("authorization")?.trim() ?? "";
  const presented = header.toLowerCase().startsWith("bearer ")
    ? header.slice("bearer ".length).trim()
    : "";
  if (!presented) return false;
  return timingSafeEqual(
    createHash("sha256").update(presented, "utf8").digest(),
    createHash("sha256").update(secret, "utf8").digest(),
  );
}

/**
 * Builds the Eve session principal for one verified inbound event actor.
 * Identity is always derived from the stored envelope, never from request
 * payload claims; the attributes stamp the application-owned audience scope
 * that `verifiedMessagingPrincipal` later requires.
 */
export function photonDispatchAuth(input: {
  readonly projectId: string;
  readonly actor: CanonicalHandle;
  readonly scope: "direct" | "group";
  readonly chatGuid: string;
  readonly sourceId: string;
  readonly bindingId: string;
}): SessionAuthContext {
  return photonSessionAuth(input.projectId, input.actor, {
    [PHOTON_ATTR_AUDIENCE]: input.scope,
    [PHOTON_ATTR_CHAT]: input.chatGuid,
    [PHOTON_ATTR_SOURCE]: input.sourceId,
    [PHOTON_ATTR_BINDING]: input.bindingId,
  });
}

/**
 * Renders the model-facing text for an inbound message. Non-text content
 * becomes explicit file/app placeholders — raw provider JSON never reaches
 * the model, and attachment-only messages still produce usable input.
 */
export function describeInboundMessage(message: Message): string {
  const parts: string[] = [];
  if (message.subject) parts.push(`Subject: ${message.subject}`);
  const text = message.content.text?.trim();
  if (text) parts.push(text);
  for (const attachment of message.content.attachments) {
    const name = attachment.fileName?.trim() || attachment.mimeType || "unnamed file";
    parts.push(`[Attachment: ${name}${message.isAudioMessage ? " (voice note)" : ""}]`);
  }
  if (message.content.miniApp) parts.push("[iMessage app card]");
  if (parts.length === 0) parts.push("[Message with no readable content]");
  return parts.join("\n");
}

/** Channel context strings persisted ahead of the delivered message. */
export function photonContextStrings(scope: "direct" | "group"): readonly string[] {
  if (scope === "group") {
    return [
      "This request arrived through an admitted iMessage group chat on Bell's Photon channel. "
      + "Reply concisely in this chat. Never share personal credentials, private handoff links, "
      + "wallet or vault contents in a group. When a request needs a private credential flow, "
      + "tell the user to continue in their private conversation.",
    ];
  }
  return [
    "This request arrived through Bell's private Photon iMessage channel. "
    + "Reply concisely in this chat. Use the same browser for follow-up requests. "
    + "For a human-only step, send the human_handoff tool's link and wait for a reply.",
  ];
}

/**
 * Channel context handed to photon `events` handlers. `thread.post` is the
 * only user-visible surface: it records a lifecycle notice through the
 * durable outbound command path, so a callback failure cannot silently lose
 * the message — the worker's outbox loop delivers it later.
 */
export interface PhotonChannelContext {
  readonly thread?: {
    readonly post: (text: string) => Promise<void>;
  };
}

/**
 * Enqueues a conversation-bound lifecycle notice (session failure and
 * similar) as a durable `messages.sendText` command. Repeating the same
 * notice text for one session collapses to one command. Best effort: enqueue
 * failures are swallowed because the durable-event projector is the
 * authoritative output repair path.
 */
export async function postSessionNotice(
  db: PhotonDb,
  sessionId: string,
  text: string,
): Promise<void> {
  const conversation = await db.findConversationBySession(sessionId);
  if (!conversation || conversation.retiredAt) return;
  const noticeKey = sha256Hex(canonicalTupleJson(["v1", text])).slice(0, 24);
  const command: PhotonCommand = {
    commandId: `photon-cmd:notice:${sessionId}:${noticeKey}`,
    operation: "messages.sendText",
    args: { chat: conversation.chatGuid, text },
    argsDigest: sha256Hex(canonicalTupleJson(["v1", text])),
    initiatorPrincipal: conversation.initiatingPrincipal,
    audience: conversation.scope,
    sourceId: conversation.sourceId,
    chatGuid: conversation.chatGuid,
    semanticKey: semanticKeyFor({ sessionId, outputKind: "lifecycle_notice", partId: noticeKey }),
    dependsOn: [],
  };
  await db.enqueueCommand(command).catch(() => undefined);
}

export const photonBrowserEvents: ChannelEvents<PhotonChannelContext> = {
  ...browserChannelEvents,
  async "session.failed"(event, channel) {
    try {
      await browserChannelEvents["session.failed"](event);
    } finally {
      await channel.thread?.post(
        "This session could not recover from an error. Start a new conversation to continue.",
      );
    }
  },
};
