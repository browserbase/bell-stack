import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { notionPrincipal } from "../lib/notion-auth";
import { safeNotion } from "../../server/notion/config";
import { getNotionOAuth } from "../../server/notion/oauth";

export default defineTool({
  description: "Disconnect the current caller's Notion account and revoke its grant after confirmation. If revocation fails, access stays blocked. Retry disconnect to finish.",
  inputSchema: z.object({}),
  approval: always(),
  async execute(_, ctx) {
    const principal = notionPrincipal(ctx);
    return safeNotion(() => getNotionOAuth({ allowDisabled: true }).disconnect(principal));
  },
});
