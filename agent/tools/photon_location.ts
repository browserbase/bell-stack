import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  assertPrivateAudience,
  awaitCommandResult,
  enqueuePhotonCommand,
  photonScope,
} from "../lib/photon-tools";

const address = z.string().min(3).max(320);

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request"), address }).strict(),
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("get"), address }).strict(),
  z
    .object({
      action: z.literal("watch"),
      watchAction: z.enum(["start", "stop"]),
      address: address.optional(),
    })
    .strict(),
]);

/** Compact projection of a SharedFriendLocation snapshot. */
function projectLocation(value: unknown): Record<string, unknown> | undefined {
  const location = asRecord(value);
  if (!location) return undefined;
  const timestamp = location.locationTimestamp;
  const expires = location.expiresAt;
  return {
    address: asString(location.address),
    name: asString(location.name),
    latitude: asNumber(location.latitude),
    longitude: asNumber(location.longitude),
    accuracy: asNumber(location.accuracy),
    locationType: asString(location.locationType),
    isLocatingInProgress: asBoolean(location.isLocatingInProgress),
    locationTimestamp:
      timestamp instanceof Date ? timestamp.toISOString() : asString(timestamp),
    expiresAt: expires instanceof Date ? expires.toISOString() : asString(expires),
    longAddress: asString(location.longAddress),
    shortAddress: asString(location.shortAddress),
  };
}

export default defineTool({
  description:
    "Find My location operations — private conversation only. request sends the visible native sharing-request card for an existing participant's address; success is a submitted request, never acceptance of sharing. list returns the friend-location snapshots currently visible to the account (empty is valid); get reads the latest snapshot for one address (not sharing returns not-found). watch with watchAction start/stop registers or removes a bounded live-watch at the Bell subscription layer — the registry is capped, watches never replay missed updates, and stopping a watch does not affect the person's Apple location sharing. Snapshots carry freshness fields (locationTimestamp, expiresAt); treat a gap after reconnect as missing data. request and reads wait up to ~8s and return 'acknowledged' results or 'pending'; watch returns {status:'queued', commandId}.",
  inputSchema,
  async execute(input, ctx) {
    assertPrivateAudience(ctx);
    const scope = await photonScope(ctx);
    switch (input.action) {
      case "request": {
        const { commandId } = await enqueuePhotonCommand(scope, "locations.request", {
          address: input.address,
        });
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        const record = asRecord(receipt.status === "acknowledged" ? receipt.result : undefined);
        return {
          status: receipt.status,
          commandId,
          request:
            record === undefined
              ? undefined
              : {
                  status: asString(record.status),
                  reason: asString(record.reason),
                  messageGuid: asString(record.messageGuid),
                  address: asString(record.address),
                },
          note: "A successful request is not acceptance of location sharing.",
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "list": {
        const { commandId } = await enqueuePhotonCommand(scope, "locations.list", {});
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        const raw = receipt.status === "acknowledged" ? receipt.result : undefined;
        const locations = Array.isArray(raw) ? raw : asArray(asRecord(raw)?.locations);
        return {
          status: receipt.status,
          commandId,
          locations: locations.map(projectLocation).filter((entry) => entry !== undefined),
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "get": {
        const { commandId } = await enqueuePhotonCommand(scope, "locations.get", {
          address: input.address,
        });
        const receipt = await awaitCommandResult(scope.store, commandId, undefined, ctx.abortSignal);
        return {
          status: receipt.status,
          commandId,
          location: receipt.status === "acknowledged" ? projectLocation(receipt.result) : undefined,
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "watch": {
        const { commandId, deduplicated } = await enqueuePhotonCommand(scope, "locations.watch", {
          action: input.watchAction,
          address: input.address,
        });
        return { status: "queued", commandId, deduplicated };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
