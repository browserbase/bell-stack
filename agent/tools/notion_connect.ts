import { defineTool } from "eve/tools";
import { z } from "zod";
import { notionAuth, notionPrincipal } from "../lib/notion-auth";
import { getNotionOAuth } from "../../server/notion/oauth";
import { notionEnabled, safeNotion } from "../../server/notion/config";

export default defineTool({
  description: "Connect your Notion account to remember personal preferences, plans, and notes across conversations. Sends a private consent link through Eve; never asks for tokens in chat.",
  inputSchema: z.object({}),
  async execute(_, ctx) {
    if (!notionEnabled()) return { status: "disabled", setting: "NOTION_ENABLED" };
    const principal = notionPrincipal(ctx);
    await ctx.getToken(notionAuth, { authKey: "notion" });
    return safeNotion(() => getNotionOAuth().status(principal));
  },
});
