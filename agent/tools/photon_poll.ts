import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import {
  asArray,
  asRecord,
  asString,
  assertTargetInConversation,
  awaitCommandResult,
  enqueuePhotonCommand,
  photonScope,
} from "../lib/photon-tools";

const pollGuid = z.string().min(1).max(512);

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      title: z
        .string()
        .min(1)
        .max(2048)
        .refine((value) => value.trim().length > 0, "title must contain non-whitespace content"),
      choices: z
        .array(
          z
            .string()
            .min(1)
            .max(1024)
            .refine((value) => value.trim().length > 0, "choice must contain non-whitespace content"),
        )
        .min(2)
        .max(100),
    })
    .strict(),
  z.object({ action: z.literal("get"), pollMessageGuid: pollGuid }).strict(),
  z
    .object({
      action: z.literal("vote"),
      pollMessageGuid: pollGuid,
      optionIdentifier: z.string().min(1).max(512),
    })
    .strict(),
  z.object({ action: z.literal("unvote"), pollMessageGuid: pollGuid }).strict(),
  z
    .object({
      action: z.literal("addOption"),
      pollMessageGuid: pollGuid,
      text: z
        .string()
        .min(1)
        .max(1024)
        .refine((value) => value.trim().length > 0, "option text must contain non-whitespace content"),
    })
    .strict(),
]);

/** Compact projection of a provider Poll snapshot for the model. */
function projectPoll(value: unknown): Record<string, unknown> | undefined {
  const poll = asRecord(value);
  if (!poll) return undefined;
  return {
    pollMessageGuid: asString(poll.pollMessageGuid),
    title: asString(poll.title),
    chatGuid: asString(poll.chatGuid),
    options: asArray(poll.options).map((entry) => {
      const option = asRecord(entry);
      return {
        optionIdentifier: asString(option?.optionIdentifier),
        text: asString(option?.text),
        creatorHandle: asString(option?.creatorHandle),
      };
    }),
    votes: asArray(poll.votes).map((entry) => {
      const vote = asRecord(entry);
      const participant = asRecord(vote?.participant);
      return {
        optionIdentifier: asString(vote?.optionIdentifier),
        participant: asString(participant?.address),
      };
    }),
  };
}

export default defineTool({
  description:
    "Create and act on native iMessage polls in the current conversation. create sends a poll with a nonempty title and two or more nonempty choices; it waits up to ~8s and returns the poll state including every stable optionIdentifier — record those ids, never a label or list position. get reads current options and all reported participant votes. vote casts or changes the account's vote on one optionIdentifier at a time (repeat the call for additional votes; identical labels on different options are distinct identifiers). unvote removes the account's own vote. addOption appends a new nonempty option and the provider returns its fresh identifier. Mutations return {status:'queued', commandId}; reads and create return 'acknowledged' with poll state or 'pending' while still in flight.",
  inputSchema,
  async execute(input, ctx) {
    const scope = await photonScope(ctx);
    switch (input.action) {
      case "create": {
        const { commandId } = await enqueuePhotonCommand(scope, "polls.create", {
          title: input.title,
          choices: input.choices,
        });
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        return {
          status: receipt.status,
          commandId,
          poll: receipt.status === "acknowledged" ? projectPoll(receipt.result) : undefined,
        };
      }
      case "get": {
        await assertTargetInConversation(scope, "poll", input.pollMessageGuid, "The poll");
        const { commandId } = await enqueuePhotonCommand(scope, "polls.get", {
          pollMessageGuid: input.pollMessageGuid,
        });
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        return {
          status: receipt.status,
          commandId,
          poll: receipt.status === "acknowledged" ? projectPoll(receipt.result) : undefined,
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "vote": {
        await assertTargetInConversation(scope, "poll", input.pollMessageGuid, "The poll");
        const { commandId, deduplicated } = await enqueuePhotonCommand(scope, "polls.vote", {
          pollMessageGuid: input.pollMessageGuid,
          optionIdentifier: input.optionIdentifier,
        });
        return { status: "queued", commandId, deduplicated };
      }
      case "unvote": {
        await assertTargetInConversation(scope, "poll", input.pollMessageGuid, "The poll");
        const { commandId, deduplicated } = await enqueuePhotonCommand(scope, "polls.unvote", {
          pollMessageGuid: input.pollMessageGuid,
        });
        return { status: "queued", commandId, deduplicated };
      }
      case "addOption": {
        await assertTargetInConversation(scope, "poll", input.pollMessageGuid, "The poll");
        const { commandId, deduplicated } = await enqueuePhotonCommand(scope, "polls.addOption", {
          pollMessageGuid: input.pollMessageGuid,
          text: input.text,
        });
        return { status: "queued", commandId, deduplicated };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
