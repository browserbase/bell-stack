import { defineTool, toolOutput } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { poppyApiIndex, poppyOwner, poppyUrl } from "../lib/poppy";
import { getPoppyClient } from "../../server/poppy/client";

export default defineTool({
  description: "Ask the user to authorize account access for one discovered Poppy API. Request only scopes needed for their task; explain each scope. Returns the company's sign-in URL and user code. The user must open it and approve themselves; never browse or automate the consent flow. Then use poppy_status. Disconnect existing access before changing scopes.",
  inputSchema: z.object({ url: poppyUrl, api: poppyApiIndex, scopes: z.array(z.string().min(1).max(256)).min(1).max(32) }),
  approval: always(),
  execute: ({ url, api, scopes }, ctx) => getPoppyClient().connect(poppyOwner(ctx), ctx.session.id, url, api, scopes, ctx.abortSignal),
  toModelOutput: output => toolOutput.json(output),
});
