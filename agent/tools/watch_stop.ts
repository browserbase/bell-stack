import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { priceWatches } from "../../server/shopping/watches";
import { monitors } from "../../server/monitors/service";
import { watchIdentity, safeWatch, signedPriceMessage } from "../lib/monitors";

export default defineTool({
  description: "Permanently stop one of this sender's watches. Local alerts stop immediately; cancel_pending means upstream cancellation is still pending and billing may continue.",
  inputSchema: z.object({ id: z.union([z.uuid(), z.string().regex(/^price:[0-9a-f-]{36}$/).refine(value => z.uuid().safeParse(value.slice(6)).success)]) }),
  execute: ({ id }, ctx) => safeWatch(() => id.startsWith("price:")
    ? priceWatches().stop(signedPriceMessage(ctx), id.slice(6)) : monitors().stop(watchIdentity(ctx), id)),
  toModelOutput: output => toolOutput.json(output),
});
