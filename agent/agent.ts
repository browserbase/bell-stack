import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const model = process.env.BELL_MODEL ?? "gpt-6.1-sol";
const apiGatewayKey = process.env.AI_GATEWAY_API_KEY?.trim();

export default defineAgent({
  model: apiGatewayKey
    ? model.includes("/")
      ? model
      : `openai/${model}`
    : openai.responses(model),
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
