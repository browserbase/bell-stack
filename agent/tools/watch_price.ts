import { defineTool, toolOutput } from "eve/tools";
import { watchTerms } from "../../server/shopping/evidence";
import { priceWatches } from "../../server/shopping/watches";
import { safeWatch, signedPriceMessage } from "../lib/monitors";

export default defineTool({
  description: "Set a one-time price-drop alert when the shopper explicitly asks in a direct Linq chat. Use the exact product or public listing, country, currency and target. Ask about unresolved variants. An in-stock offer that already meets the target is returned immediately.",
  inputSchema: watchTerms,
  execute: (terms, ctx) => safeWatch(() => priceWatches().enroll(signedPriceMessage(ctx), terms, ctx.abortSignal)),
  toModelOutput: output => toolOutput.json(output),
});
