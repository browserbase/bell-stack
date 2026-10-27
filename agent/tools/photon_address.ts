import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import {
  asArray,
  asBoolean,
  asRecord,
  asString,
  assertPrivateAudience,
  awaitCommandResult,
  enqueuePhotonCommand,
  photonScope,
} from "../lib/photon-tools";

const address = z.string().min(3).max(320);

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), address }).strict(),
  z.object({ action: z.literal("isIMessageAvailable"), address }).strict(),
  z.object({ action: z.literal("isFocusSilenced"), address }).strict(),
]);

export default defineTool({
  description:
    "Preflight an address on the account — private conversation only. get returns the normalized address, nullable country, and reported services (iMessage/SMS/RCS/unknown); a missing address comes back as a structured not-found. isIMessageAvailable is a current-availability preflight, not a delivery guarantee — false includes inability to confirm, and a later send can still fail. isFocusSilenced returns the reported live Focus/silence state with its freshness; it is a point-in-time snapshot, not a persistent preference or permission to send Notify Anyway. Each action waits up to ~8s and returns 'acknowledged' with the provider verdict, 'failed' with errorCode, or 'pending' with commandId.",
  inputSchema,
  async execute(input, ctx) {
    assertPrivateAudience(ctx);
    const scope = await photonScope(ctx);
    switch (input.action) {
      case "get": {
        const { commandId } = await enqueuePhotonCommand(scope, "addresses.get", {
          address: input.address,
        });
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        const record = asRecord(receipt.status === "acknowledged" ? receipt.result : undefined);
        return {
          status: receipt.status,
          commandId,
          address:
            record === undefined
              ? undefined
              : {
                  address: asString(record.address),
                  country:
                    typeof record.country === "string" || record.country === null
                      ? record.country
                      : undefined,
                  services: asArray(record.services).filter(
                    (entry): entry is string => typeof entry === "string",
                  ),
                },
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "isIMessageAvailable": {
        const { commandId } = await enqueuePhotonCommand(scope, "addresses.isIMessageAvailable", {
          address: input.address,
        });
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        const raw = receipt.status === "acknowledged" ? receipt.result : undefined;
        const record = asRecord(raw);
        return {
          status: receipt.status,
          commandId,
          available:
            asBoolean(record?.available) ??
            asBoolean(record?.isIMessageAvailable) ??
            asBoolean(raw),
          note: "Availability preflight only — not a delivery guarantee.",
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "isFocusSilenced": {
        const { commandId } = await enqueuePhotonCommand(scope, "addresses.isFocusSilenced", {
          address: input.address,
        });
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        const raw = receipt.status === "acknowledged" ? receipt.result : undefined;
        const record = asRecord(raw);
        return {
          status: receipt.status,
          commandId,
          silenced:
            asBoolean(record?.silenced) ??
            asBoolean(record?.isFocusSilenced) ??
            asBoolean(raw),
          reportedAt: asString(record?.reportedAt) ?? asString(record?.timestamp),
          note: "Live Focus snapshot — not a persistent preference or permission for Notify Anyway.",
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
