import type { AgentDefinition } from "eve";

export const notionReadTools = [
  "notion-search", "notion-fetch", "notion-memory-search", "notion-get-self",
  "notion-get-tool-access", "notion-query-data-sources", "notion-get-async-task",
];

const scheduledTools = new Set([
  ...notionReadTools.map(name => `notion__${name}`),
  "no_reply", "notion_status", "web_search", "web_fetch",
]);

export const scheduledToolApproval: NonNullable<AgentDefinition["approval"]> = ({ session, toolName }) => {
  if (session.schedule && !scheduledTools.has(toolName)) {
    return { type: "denied", reason: "Scheduled turns can only look up information and report it." };
  }
};
