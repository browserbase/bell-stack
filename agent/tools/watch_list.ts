import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { monitors } from "../../server/monitors/service";
import { watchIdentity, safeWatch } from "../lib/monitors";

export default defineTool({
  description: "List this sender's watches, recent updates, and pending failures. Use this to reconcile uncertain creation before making another watch.",
  inputSchema: z.object({}),
  execute: (_input, ctx) => safeWatch(() => {
    watchIdentity(ctx);
    const service = monitors();
    return service.list(watchIdentity(ctx));
  }),
  toModelOutput: output => toolOutput.json(output),
});
