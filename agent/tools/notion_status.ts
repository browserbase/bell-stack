import { defineTool } from "eve/tools";
import { z } from "zod";
import { notionPrincipal } from "../lib/notion-auth";
import { notionEnabled, safeNotion } from "../../server/notion/config";
import { getNotionOAuth } from "../../server/notion/oauth";

export default defineTool({
  description: "Check the current caller's stored Notion connection without starting consent or exposing credentials. Connected means a grant is stored; it does not verify remote access or memory setup.",
  inputSchema: z.object({}),
  async execute(_, ctx) {
    if (!notionEnabled()) return { status: "disabled" };
    const principal = notionPrincipal(ctx);
    return safeNotion(() => getNotionOAuth().status(principal));
  },
});
