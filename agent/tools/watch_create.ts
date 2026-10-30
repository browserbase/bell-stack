import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { monitors } from "../../server/monitors/service";
import { watchIdentity, safeWatch, watchDestination } from "../lib/monitors";
import { queryInput } from "../../server/monitors/config";

export default defineTool({
  description: "Create a daily public-web watch with Parallel lite. Only create when the user asks for ongoing monitoring. Never include secrets or private browser content. Watches continue until stopped; list existing watches before retrying an uncertain creation.",
  inputSchema: z.object({ query: queryInput }),
  execute: (input, ctx) => safeWatch(() => {
    watchIdentity(ctx);
    const service = monitors();
    return service.create(watchIdentity(ctx), watchDestination(ctx), JSON.stringify([ctx.session.id, ctx.callId]), input.query);
  }),
  toModelOutput: output => toolOutput.json(output),
});
