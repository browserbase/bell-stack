import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { notionAuth } from "../lib/notion-auth";
import { notionEnabled, notionEndpoint, notionOwner, safeNotion } from "../../server/notion/config";
import { getNotionOAuth } from "../../server/notion/oauth";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (!notionEnabled()) return null;
      const auth = ctx.session.auth.current;
      if (auth?.principalType !== "user" || !["bell:operator", "linq"].includes(auth.issuer ?? "")) return null;
      const principal = { type: "user" as const, id: auth.principalId, issuer: auth.issuer };
      const owner = notionOwner(principal);
      return defineMcpClientConnection({
        url: notionEndpoint,
        instanceKey: owner,
        description: "Notion: the user's personal preferences, routines, plans, decisions, and notes across conversations. Search before relying on remembered information.",
        protocolVersionDiscovery: false,
        auth: notionAuth,
        tools: { allow: [
          "notion-search", "notion-fetch", "notion-memory-search", "notion-get-self",
          "notion-get-tool-access", "notion-query-data-sources",
          "notion-create-pages", "notion-update-page", "notion-create-database", "notion-update-data-source",
          "notion-get-async-task", "notion-delete-pages",
        ] },
        approval: async ({ toolName }) => {
          if (toolName.startsWith("notion__") && (await safeNotion(() => getNotionOAuth().status(principal))).status !== "connected")
            return "denied";
          return /__(?:notion-create-database|notion-update-data-source|notion-delete-pages)$/.test(toolName)
            ? "user-approval" : "not-applicable";
        },
      });
    },
  },
});
