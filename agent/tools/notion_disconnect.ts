import { defineTool } from "eve/tools";
import { z } from "zod";
import { notionPrincipal } from "../lib/notion-auth";
import { notionEnabled, safeNotion } from "../../server/notion/config";
import { getNotionOAuth } from "../../server/notion/oauth";

export default defineTool({
  description: "Disconnect the current caller's Notion account and revoke its grant. Leaves Notion content intact. If revocation fails, access stays blocked; retry disconnect to finish.",
  inputSchema: z.object({}),
  async execute(_, ctx) {
    if (!notionEnabled()) return { status: "disabled" };
    const principal = notionPrincipal(ctx);
    return safeNotion(() => getNotionOAuth().disconnect(principal));
  },
});
