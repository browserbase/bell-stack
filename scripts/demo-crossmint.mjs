import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// Opt-in: starts one real Crossmint Agent Checkout and watches it. Answers nothing, so it stops at
// the first question or the first terminal state. Crossmint bills the run. Cancel it in the console.
// Usage: node scripts/demo-crossmint.mjs <product-url> <amount> [currency]
const preset = new Set(Object.keys(process.env));
for (const file of [".env", ".env.local"]) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  for (const [key, value] of Object.entries(parseEnv(text))) if (!preset.has(key)) process.env[key] = value;
}

const [startUrl, amount, currency = "USD"] = process.argv.slice(2);
if (!startUrl || !amount) throw new Error("Usage: node scripts/demo-crossmint.mjs <product-url> <amount> [currency]");
if (!URL.canParse(startUrl) || new URL(startUrl).protocol !== "https:") throw new Error("The product URL must be https.");
if (!/^(?:[1-9]\d{0,14}(?:\.\d{1,2})?|0\.(?=\d*[1-9])\d{1,2})$/.test(amount)) throw new Error("The cap must be a decimal such as 20.00.");
if (!/^[A-Z]{3}$/.test(currency)) throw new Error("The currency must be an ISO 4217 code such as USD.");
const apiKey = process.env.CROSSMINT_SERVER_API_KEY?.trim();
const userId = process.env.CROSSMINT_USER_ID?.trim();
if (!apiKey?.startsWith("sk_") || !userId) throw new Error("Set CROSSMINT_SERVER_API_KEY (sk_...) and CROSSMINT_USER_ID.");
const baseUrl = (process.env.CROSSMINT_API_BASE_URL?.trim() || "https://www.crossmint.com/api/unstable").replace(/\/$/, "");
const buyerProfileId = process.env.CROSSMINT_BUYER_PROFILE_ID?.trim();
const headers = { "X-API-KEY": apiKey, "x-crossmint-user-id": userId, "Content-Type": "application/json" };

// Errors never include the response body: it can echo the request, the key prefix, or merchant data.
async function call(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Crossmint returned HTTP ${response.status} for ${init.method ?? "GET"} ${path}.`);
  return response.json();
}

const describe = (run) => {
  const action = run.requiredAction?.request;
  if (!action) return "";
  const { interaction } = action;
  if (interaction.kind === "form") {
    const fields = interaction.fields.map((field) => `${field.key} (${field.handling}, ${field.input.kind})`).join(", ");
    return `\n  question: ${action.question}\n  fields: ${fields}`;
  }
  if (interaction.kind === "payment") {
    return `\n  question: ${action.question}\n  payment: ${interaction.method} ${interaction.amount.kind} ${interaction.amount.value} ${interaction.amount.currency} at ${interaction.merchant?.url ?? "unknown merchant"}`;
  }
  return `\n  question: ${action.question}`;
};

const { runId } = await call("/agent-checkouts", {
  method: "POST",
  body: JSON.stringify({
    request: { startUrl, task: `Go to the checkout for this product with standard delivery and pay by card.` },
    constraints: { maxCost: { amount, currency } },
    ...(buyerProfileId ? { buyerProfileId } : {}),
  }),
});
console.log(`run ${runId}`);
console.log(`console https://www.crossmint.com/console (Agent Checkouts, search for the run id)`);

const deadline = Date.now() + 10 * 60_000;
let last = "";
let run;
do {
  run = await call(`/agent-checkouts/${encodeURIComponent(runId)}`);
  const line = `${run.status} (revision ${run.revision})${describe(run)}`;
  if (line !== last) console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
  last = line;
  if (run.status === "awaiting_input" || ["succeeded", "failed", "cancelled", "blocked"].includes(run.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
} while (Date.now() < deadline);

if (run.status === "awaiting_input") console.log("Stopped at the first question. Nothing was answered and nothing was bought. Cancel the run in the console when done.");
else if (run.status === "blocked") console.log(`Blocked with ${run.result?.code ?? "no code"}: ${run.result?.summary ?? ""}`);
else if (run.status === "failed") console.log(`Failed with reason ${run.reason ?? "unknown"}.`);
else if (run.status === "succeeded") console.log(`Succeeded: ${run.result?.summary ?? ""}`);
else if (run.status === "cancelled") console.log("Cancelled.");
else { console.log("Still running after ten minutes. Watch it in the console."); process.exitCode = 1; }
