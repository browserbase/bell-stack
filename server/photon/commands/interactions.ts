import type { MiniAppCardSession, Poll } from "@photon-ai/advanced-imessage/grpc";

import type { PhotonCommandExecutor, PhotonCommandOp } from "../contracts.js";
import type { PhotonDb } from "../store.js";
import { CommandValidationError, commandProviderKey, executeOp } from "./shared.js";

/**
 * Interaction executors: native polls and customized mini-app card sessions.
 * Poll snapshots are persisted verbatim — a genuinely titleless poll keeps an
 * empty title and duplicate option labels keep their distinct option
 * identifiers, matching the provider's own model.
 */

function persistPoll(store: PhotonDb, sourceId: string, poll: Poll): Promise<void> {
  return store.upsertResource(sourceId, "poll", poll.pollMessageGuid, { poll });
}

/**
 * Resolves the authoritative card session for a mini-app update. The stored
 * session wins over caller-supplied fields because it is the snapshot Bell
 * persisted at send time; either way the session's chat must match the
 * command's authorized chat scope.
 */
export async function resolveMiniAppSession(
  store: PhotonDb,
  sourceId: string,
  provided: MiniAppCardSession,
  chatGuid: string,
): Promise<MiniAppCardSession> {
  if (provided.chatGuid !== chatGuid)
    throw new CommandValidationError(
      "session_scope",
      "Mini-app session belongs to a different chat than this command's scope.",
    );
  const stored = await store.getResource(sourceId, "miniapp_session", provided.sessionId);
  const session = (stored?.data as { session?: MiniAppCardSession } | undefined)?.session;
  if (!session) return provided;
  if (session.chatGuid !== chatGuid)
    throw new CommandValidationError(
      "session_scope",
      "Stored mini-app session belongs to a different chat than this command's scope.",
    );
  return session;
}

export function interactionExecutors(
  store: PhotonDb,
): Partial<Record<PhotonCommandOp, PhotonCommandExecutor>> {
  return {
    "polls.create": executeOp("polls.create", async (client, args, command) => {
      const poll = await client.polls.create(args.chat, args.title, [...args.choices], {
        clientMessageId: commandProviderKey(command),
      });
      await persistPoll(store, command.sourceId, poll);
      return { result: poll, receipt: { pollMessageGuid: poll.pollMessageGuid } };
    }),

    "polls.get": executeOp("polls.get", async (client, args, command) => {
      const poll = await client.polls.get(args.pollMessageGuid);
      await persistPoll(store, command.sourceId, poll);
      return { result: poll };
    }),

    "polls.vote": executeOp("polls.vote", async (client, args, command) => {
      const poll = await client.polls.vote(args.pollMessageGuid, args.optionIdentifier, {
        clientMessageId: commandProviderKey(command),
      });
      await persistPoll(store, command.sourceId, poll);
      return { result: poll };
    }),

    "polls.unvote": executeOp("polls.unvote", async (client, args, command) => {
      const poll = await client.polls.unvote(args.pollMessageGuid, {
        clientMessageId: commandProviderKey(command),
      });
      await persistPoll(store, command.sourceId, poll);
      return { result: poll };
    }),

    "polls.addOption": executeOp("polls.addOption", async (client, args, command) => {
      const poll = await client.polls.addOption(args.pollMessageGuid, args.text, {
        clientMessageId: commandProviderKey(command),
      });
      await persistPoll(store, command.sourceId, poll);
      return { result: poll };
    }),
  };
}
