import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";

export default defineAgent({
  model: openai.responses(process.env.BELL_MODEL ?? "gpt-5.6-sol"),
  build: {
    externalDependencies: [
      "@1password/sdk",
      "@browserbasehq/sdk",
      "@browserbasehq/stagehand",
      "playwright-core",
      "pg",
    ],
  },
  experimental: {
    workflow: {
      // Keep finished-run data at the World default so the Photon output
      // projector and incident recovery can re-read completed sessions.
      retention: "default",
    },
  },
  limits: { sessionTimeoutMs: 24 * 60 * 60 * 1_000 },
});
