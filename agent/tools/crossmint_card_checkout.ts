import { defineTool, toolOutput } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { amount, currency, errorOutput, requesterOnly, type CheckoutToolOutput } from "../lib/crossmint";
import { runBrowserOperation, runCancelableBrowserWork } from "../lib/browser-runtime";
import { assertCheckoutPolicy } from "../../server/crossmint/client";
import {
  assertCardPayment,
  cardConfig,
  checkoutAmount,
  CrossmintCardError,
  getOrderIntent,
  idempotencyKey,
  isCrossmintCardsConfigured,
  merchantOrigin,
  mintCard,
  paymentOrigins,
} from "../../server/crossmint/cards";
import { checkoutInHostedPage } from "../../server/link/checkout-browser";
import { checkoutInput } from "../../server/link/payment";

const cardTarget = checkoutInput.shape.fields.element.extend({ field: z.enum(["number", "cvc", "exp_month", "exp_year", "expiry"]) });

const inputSchema = z.object({
  amount: amount.describe("The exact total on the merchant's checkout, including tax and shipping."),
  currency,
  merchant: z.string().min(1).max(255).describe("The checkout page's URL or host."),
  fields: z
    .array(cardTarget)
    .min(1)
    .max(16)
    .describe("Exact CSS selectors for the card inputs: number, cvc, and expiry (MM/YY) or exp_month (MM) and exp_year (YYYY). Add a frame selector for a card iframe."),
  submit: checkoutInput.shape.submit.describe("The pay button."),
  confirmation: checkoutInput.shape.submit.optional().describe("An element that appears only once the merchant confirms the order."),
});

type Input = z.infer<typeof inputSchema>;

type CardCheckoutOutput =
  | CheckoutToolOutput
  | { status: "payment_not_configured"; hint: string }
  | { status: "submission_attempted" | "merchant_confirmation_observed" | "outcome_unknown"; verify_payment: true }
  | { status: "waiting_for_user"; reason: string; action: string };

export default defineTool({
  description:
    "Pay at the merchant checkout open in this conversation's browser with the person's Crossmint agent card. First complete everything but the card and stay on the payment step. Supply the exact total and currency, the checkout page's URL or host, exact CSS selectors for the card inputs, and the pay button. Eve stops and asks the person to approve the amount and merchant. The server then checks the order intent the person approved in Crossmint (status, merchant, currency, remaining amount, expiry, verified card rail), mints a one-time card on Visa Intelligent Commerce or Mastercard Agent Pay, fills it, and presses pay once. The card number never reaches this assistant, and the browser stays private afterwards. submission_attempted, merchant_confirmation_observed, and outcome_unknown do not prove payment; check the order through human handoff. Call once per purchase and never retry an uncertain one.",
  inputSchema,
  label: {
    start: (input: Readonly<Input>) => `Paying ${input.amount} ${input.currency} at ${input.merchant} with a Crossmint agent card`,
  },
  approval: {
    request: always(),
    prompt: ({ input }) => `Pay ${input.amount} ${input.currency} at ${input.merchant} with your Crossmint agent card?`,
    response: requesterOnly,
  },
  async execute(input, ctx): Promise<CardCheckoutOutput> {
    ctx.abortSignal.throwIfAborted();
    if (!isCrossmintCardsConfigured()) {
      return { status: "not_configured", hint: "Set the Crossmint Agent Cards settings on the server. See docs/crossmint.md." };
    }
    if (!ctx.session.auth.current) {
      return { status: "error", reason: "authentication_required", message: "Payments are available to authenticated senders only. The anonymous web demo cannot pay." };
    }
    const signal = ctx.abortSignal;
    try {
      const config = cardConfig();
      if (!config.orderIntentId) {
        return { status: "payment_not_configured", hint: "No order intent is configured on the server, so Bell cannot pay. Tell the person. See docs/crossmint.md." };
      }
      const payment = { amount: input.amount, currency: input.currency };
      const origin = merchantOrigin(input.merchant);
      assertCheckoutPolicy(origin, payment, config);
      const { provider } = assertCardPayment(await getOrderIntent({ config, signal }), { ...payment, merchant: origin });
      const checkout = checkoutInput.parse({
        id: "crossmint_card",
        amount: checkoutAmount(input.amount, input.currency),
        currency: input.currency.toLowerCase(),
        credential: "card",
        fields: input.fields,
        submit: input.submit,
        ...(input.confirmation ? { confirmation: input.confirmation } : {}),
      });
      const key = idempotencyKey(ctx.session.id, ctx.callId);
      // The card is minted inside the fill, after every target and origin check, and never leaves it.
      const output = await runCancelableBrowserWork(ctx.session.id, signal, () =>
        runBrowserOperation(ctx.session.id, (browser) =>
          browser.withHostedPage(signal, (page, connection) =>
            checkoutInHostedPage(page, connection, checkout, paymentOrigins(config, origin), () => mintCard(provider, payment, key, { config, signal }), signal), true)));
      const result: { status: string; reason?: string; action?: string } = output.result;
      if (result.status === "waiting_for_user") return { status: "waiting_for_user", reason: result.reason ?? "captcha", action: result.action ?? "" };
      return { status: result.status as "submission_attempted" | "merchant_confirmation_observed" | "outcome_unknown", verify_payment: true };
    } catch (error) {
      if (error instanceof CrossmintCardError) return { status: "error", reason: error.reason, message: error.message };
      if (!signal.aborted && error instanceof Error && error.message.startsWith("Checkout stopped before submission.")) {
        return {
          status: "error",
          reason: "stopped_before_submission",
          message: "The checkout stopped after the card was issued and before it was submitted. The browser is now private. Check the merchant page through human handoff and do not retry.",
        };
      }
      return errorOutput(error);
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
