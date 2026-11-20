import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { poppyOwner, poppyUrl } from "../lib/poppy";
import { getPoppyClient } from "../../server/poppy/client";

export default defineTool({
  description: "Disconnect this Bell user's account from a Poppy company. Blocks local access first, revokes saved refresh grants, and clears sessions. Retry if remote revocation fails. Does not cancel orders or delete the company's account.",
  inputSchema: z.object({ url: poppyUrl }),
  approval: always(),
  execute: ({ url }, ctx) => getPoppyClient().disconnect(poppyOwner(ctx), url, ctx.abortSignal),
});
