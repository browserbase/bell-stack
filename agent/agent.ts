import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";
import { scheduledToolApproval } from "./lib/scheduled-tools";

export default defineAgent({
  model: openai.responses(process.env.BELL_MODEL ?? "gpt-5.6-sol"),
  approval: scheduledToolApproval,
  build: {
    externalDependencies: [
      "@1password/sdk",
      "@browserbasehq/sdk",
      "@browserbasehq/stagehand",
      "playwright-core",
      "pg",
    ],
  },
  limits: { sessionTimeoutMs: 24 * 60 * 60 * 1_000 },
});
