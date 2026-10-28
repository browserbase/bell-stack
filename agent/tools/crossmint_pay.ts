import { defineTool, toolOutput } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { amount, currency, errorOutput, notConfigured, requestId, requesterOnly, runId, WAIT_MS, type CheckoutToolOutput } from "../lib/crossmint";
import { CrossmintSetupError, getCheckout, payWithOrderIntent, waitForCheckout } from "../../server/crossmint/client";
import { assertPaymentMatches, PaymentMismatchError } from "../../server/crossmint/payment";
import { assertSessionCheckout } from "../../server/crossmint/runs";

const inputSchema = z.object({
  runId,
  requestId: requestId.describe("The open payment request's id."),
  amount: amount.describe("The exact total Crossmint is asking for, copied from the payment request."),
  currency,
  merchant: z.string().min(1).max(255).describe("The merchant URL or host from the payment request."),
});

type Input = z.infer<typeof inputSchema>;

type PayOutput = CheckoutToolOutput | { status: "payment_not_configured"; runId: string; requestId: string; hint: string };

export default defineTool({
  description:
    "Pay the open payment request of a Crossmint checkout with the person's own card, through the order intent held on the server. Copy amount, currency, and merchant exactly from the payment request. Eve stops and asks the person to approve this call. The server then compares those three values with the live request and with the cap the run started with, and refuses on any difference. The card number never reaches this assistant. Needs an authenticated sender. Call once per payment request. Use crossmint_checkout decline if the person says no.",
  inputSchema,
  label: {
    start: (input: Readonly<Input>) => `Paying ${input.amount} ${input.currency} at ${input.merchant} through Crossmint`,
  },
  approval: {
    request: always(),
    prompt: ({ input }) => `Pay ${input.amount} ${input.currency} to ${input.merchant} with your Crossmint order intent?`,
    response: requesterOnly,
  },
  async execute(input, ctx): Promise<PayOutput> {
    ctx.abortSignal.throwIfAborted();
    const unavailable = notConfigured();
    if (unavailable) return unavailable;
    const auth = ctx.session.auth.current;
    if (!auth) {
      return { status: "error", reason: "authentication_required", message: "Payments are available to authenticated senders only. The anonymous web demo cannot pay." };
    }
    const signal = ctx.abortSignal;
    try {
      const record = assertSessionCheckout(ctx.session.id, input.runId);
      if (record.principalId !== null && record.principalId !== auth.principalId) {
        return { status: "error", reason: "principal_mismatch", message: "A different sender started this checkout." };
      }
      try {
        assertPaymentMatches(input, await getCheckout(input.runId, { signal }), record);
        await payWithOrderIntent(input.runId, input.requestId, { signal });
      } catch (error) {
        if (error instanceof PaymentMismatchError) return { status: "error", reason: error.reason, message: error.message };
        if (error instanceof CrossmintSetupError && error.setting === "CROSSMINT_ORDER_INTENT_ID") {
          return {
            status: "payment_not_configured",
            runId: input.runId,
            requestId: input.requestId,
            hint: "No order intent is configured on the server, so Bell cannot pay. Decline the request and tell the person. See docs/crossmint.md.",
          };
        }
        throw error;
      }
      return await waitForCheckout(input.runId, { signal, timeoutMs: WAIT_MS, skipRequestId: input.requestId });
    } catch (error) {
      return errorOutput(error);
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
