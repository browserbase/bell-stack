import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { amount, currency, errorOutput, notConfigured, requestId, runId, WAIT_MS, type CheckoutToolOutput } from "../lib/crossmint";
import { answerForm, cancelCheckout, createCheckout, declineRequest, getCheckout, waitForCheckout } from "../../server/crossmint/client";
import { assertSessionCheckout, rememberCheckout } from "../../server/crossmint/runs";

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    startUrl: z.string().url().max(2048).describe("Product or store page to start from."),
    task: z.string().min(1).max(20_000).describe("What to buy, in plain language. Item, options, quantity, delivery."),
    maxCost: z.object({ amount: amount.describe("Spending cap including shipping and tax."), currency }),
    merchantGuidance: z.string().min(1).max(20_000).optional().describe("Optional notes about this merchant's checkout."),
    countryCode: z.string().length(2).toUpperCase().optional().describe("Optional browser location for the checkout, such as ES or US."),
  }),
  z.object({ action: z.literal("status"), runId }),
  z.object({
    action: z.literal("answer"),
    runId,
    requestId,
    answers: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
      .describe("One value per form field key. For a choice field, an option value. Protected fields cannot be answered here."),
  }),
  z.object({ action: z.literal("decline"), runId, requestId }),
  z.object({ action: z.literal("cancel"), runId }),
]);

export default defineTool({
  description:
    "Buy at any store through Crossmint Agent Checkouts under a hard spending cap. Crossmint picks the fastest path for the store, the merchant API, an agent protocol, or its own checkout browser, so nothing runs in this conversation's browser. The person pays with their own card, worldwide, and the card number never reaches this assistant. Call start with the product URL, a plain-language task, and maxCost, then follow requiredAction. For a form, call answer with one value per field key. For a payment, call crossmint_pay. decline refuses a request and cancel stops the run. Each call returns a status snapshot and waits up to ninety seconds for the next step. A succeeded result with purchase.kind receipt_captured is the only proof of a placed order. Never start a second checkout for the same request while one is unresolved.",
  inputSchema,
  label: {
    start: (input) =>
      input.action === "start" ? `Starting a Crossmint checkout at ${new URL(input.startUrl).hostname}` : `Crossmint checkout: ${input.action}`,
  },
  async execute(input, ctx): Promise<CheckoutToolOutput> {
    ctx.abortSignal.throwIfAborted();
    const unavailable = notConfigured();
    if (unavailable) return unavailable;
    const sessionId = ctx.session.id;
    const signal = ctx.abortSignal;
    try {
      switch (input.action) {
        case "start": {
          const { runId } = await createCheckout(input, { signal });
          rememberCheckout(sessionId, { runId, maxCost: input.maxCost, principalId: ctx.session.auth.current?.principalId ?? null });
          return await waitForCheckout(runId, { signal, timeoutMs: WAIT_MS });
        }
        case "status":
          assertSessionCheckout(sessionId, input.runId);
          return await waitForCheckout(input.runId, { signal, timeoutMs: WAIT_MS });
        case "answer": {
          assertSessionCheckout(sessionId, input.runId);
          const current = await getCheckout(input.runId, { signal });
          const action = current.requiredAction;
          if (!action || action.requestId !== input.requestId) return current;
          if (action.interaction.kind !== "form") {
            return { status: "error", reason: "wrong_interaction", message: "This request is not a form. Payment requests go through crossmint_pay." };
          }
          const protectedKeys = new Set(action.interaction.fields.filter((field) => field.handling === "protected").map((field) => field.key));
          if (Object.keys(input.answers).some((key) => protectedKeys.has(key))) {
            return {
              status: "error",
              reason: "protected_field",
              message: "Protected fields (codes, passwords, card data) cannot be answered through the model. Decline the request or ask the person to finish in Crossmint's hosted flow.",
            };
          }
          await answerForm(input.runId, input.requestId, input.answers, { signal });
          return await waitForCheckout(input.runId, { signal, timeoutMs: WAIT_MS, skipRequestId: input.requestId });
        }
        case "decline":
          assertSessionCheckout(sessionId, input.runId);
          await declineRequest(input.runId, input.requestId, { signal });
          return await waitForCheckout(input.runId, { signal, timeoutMs: 30_000, skipRequestId: input.requestId });
        case "cancel":
          assertSessionCheckout(sessionId, input.runId);
          await cancelCheckout(input.runId, { signal });
          return await waitForCheckout(input.runId, { signal, timeoutMs: 30_000 });
      }
    } catch (error) {
      return errorOutput(error);
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
