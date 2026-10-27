import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import {
  assertPrivateAudience,
  photonScope,
  runPhotonCommand,
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
        const receipt = await runPhotonCommand(
          scope,
          "addresses.get",
          { address: input.address },
          ctx.abortSignal,
        );
        const result = receipt.status === "acknowledged" ? receipt.result : undefined;
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          found: result?.found,
          address:
            result === undefined
              ? undefined
              : result.found
                ? {
                    address: result.info.address,
                    country: result.info.country,
                    services: [...result.info.services],
                  }
                : { address: result.address, country: null, services: [] },
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "isIMessageAvailable": {
        const receipt = await runPhotonCommand(
          scope,
          "addresses.isIMessageAvailable",
          { address: input.address },
          ctx.abortSignal,
        );
        const result = receipt.status === "acknowledged" ? receipt.result : undefined;
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          available: result?.available,
          note: "Availability preflight only — not a delivery guarantee.",
          errorCode: receipt.status === "failed" ? receipt.errorCode : undefined,
        };
      }
      case "isFocusSilenced": {
        const receipt = await runPhotonCommand(
          scope,
          "addresses.isFocusSilenced",
          { address: input.address },
          ctx.abortSignal,
        );
        const result = receipt.status === "acknowledged" ? receipt.result : undefined;
        return {
          status: receipt.status,
          commandId: receipt.commandId,
          silenced: result?.silenced,
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
