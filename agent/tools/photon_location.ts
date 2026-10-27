import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import type { SharedFriendLocation } from "../../server/photon/contracts.js";
import {
  assertPrivateAudience,
  isoTimestamp,
  photonScope,
  queuePhotonCommand,
  runPhotonCommand,
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
function projectLocation(
  location: SharedFriendLocation | undefined,
): Record<string, unknown> | undefined {
  if (!location) return undefined;
  return {
    address: location.address,
    name: location.name,
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.accuracy,
    locationType: location.locationType,
    isLocatingInProgress: location.isLocatingInProgress,
    locationTimestamp: isoTimestamp(location.locationTimestamp),
    expiresAt: isoTimestamp(location.expiresAt),
    longAddress: location.longAddress,
    shortAddress: location.shortAddress,
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
        const receipt = await runPhotonCommand(
          scope,
          "locations.request",
          { address: input.address },
          ctx.abortSignal,
        );
        const result = receipt.status === "acknowledged" ? receipt.result : undefined;
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          request:
            result === undefined
              ? undefined
              : {
                  status: result.status,
                  reason: result.reason,
                  messageGuid: result.messageGuid,
                  address: result.address,
                },
          note: "A successful request is not acceptance of location sharing.",
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "list": {
        const receipt = await runPhotonCommand(scope, "locations.list", {}, ctx.abortSignal);
        const locations =
          receipt.status === "acknowledged" ? [...(receipt.result?.locations ?? [])] : [];
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          locations: locations.map(projectLocation).filter((entry) => entry !== undefined),
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "get": {
        const receipt = await runPhotonCommand(
          scope,
          "locations.get",
          { address: input.address },
          ctx.abortSignal,
        );
        const result = receipt.status === "acknowledged" ? receipt.result : undefined;
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          found: result?.found,
          location: result?.found === true ? projectLocation(result.location) : undefined,
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "watch":
        return queuePhotonCommand(scope, "locations.watch", {
          action: input.watchAction,
          address: input.address,
        });
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
