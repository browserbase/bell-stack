import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { priceWatches } from "../../server/shopping/watches";
import { monitors } from "../../server/monitors/service";
import { watchIdentity, watchDestination, safeWatch } from "../lib/monitors";

export default defineTool({
  description: "List watches with their IDs and status. Use kind=price for price alerts in this chat. Generic watches include recent updates and pending failures, with open watches first. Use the returned next_cursor to read more results.",
  inputSchema: z.object({
    kind: z.enum(["generic", "price"]).default("generic"),
    status: z.enum(["all", "open", "closed"]).default("all"),
    cursor: z.string().max(512).optional().describe("The next_cursor from a previous watch_list call, to read the next page of older watches."),
  }),
  execute: ({ kind, status, cursor }, ctx) => safeWatch(async () => kind === "price"
    ? priceWatches().list(watchIdentity(ctx), watchDestination(ctx), status, cursor ? z.uuid().parse(cursor) : undefined)
    : monitors().list(watchIdentity(ctx), { status, cursor })),
  toModelOutput: output => toolOutput.json(output),
});
