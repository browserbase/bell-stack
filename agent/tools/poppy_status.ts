import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { poppyOwner, poppyUrl } from "../lib/poppy";
import { getPoppyClient } from "../../server/poppy/client";

export default defineTool({
  description: "Check whether the user completed Poppy device sign-in. Respects the provider's polling interval and keeps all tokens private. If pending, report that and wait for the user; do not busy-loop or approve the sign-in yourself.",
  inputSchema: z.object({ url: poppyUrl }),
  execute: ({ url }, ctx) => getPoppyClient().status(poppyOwner(ctx), url, ctx.abortSignal),
  toModelOutput: output => toolOutput.json(output),
});
