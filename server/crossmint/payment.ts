import { compareAmounts, type CheckoutSnapshot, type MaxCost } from "./client";
import type { CheckoutRecord } from "./runs";

/** The payment the person approved, as the model stated it in the tool call. */
export interface ApprovedPayment {
  requestId: string;
  amount: string;
  currency: string;
  merchant: string;
}

export class PaymentMismatchError extends Error {
  constructor(
    readonly reason:
      | "no_payment_request"
      | "request_changed"
      | "unsupported_method"
      | "unsupported_amount"
      | "currency_mismatch"
      | "amount_mismatch"
      | "merchant_mismatch"
      | "cap_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "PaymentMismatchError";
  }
}

function hostOf(value: string): string | undefined {
  return URL.parse(value.includes("://") ? value : `https://${value}`)?.hostname.toLowerCase();
}

/**
 * Compare the approved payment with the request Crossmint is showing right now and with the cap
 * the run was created under. Anything that differs refuses the payment. The approval dialog shows
 * the person the model's numbers; this check makes sure those are also Crossmint's numbers.
 */
export function assertPaymentMatches(approved: ApprovedPayment, live: CheckoutSnapshot, record: CheckoutRecord): { amount: MaxCost; merchant: string } {
  const refuse = (reason: PaymentMismatchError["reason"], message: string) => new PaymentMismatchError(reason, message);
  const action = live.requiredAction;
  if (live.status !== "awaiting_input" || !action || action.interaction.kind !== "payment") {
    throw refuse("no_payment_request", "Crossmint is not waiting for a payment on this checkout.");
  }
  if (action.requestId !== approved.requestId) {
    throw refuse("request_changed", "The payment request changed since approval. Show the person the new request.");
  }
  const { method, amount, merchant } = action.interaction;
  if (method !== "card") {
    throw refuse("unsupported_method", `Crossmint is asking for a ${method} payment, which an order intent cannot pay. Decline and tell the person.`);
  }
  if (amount.kind !== "exact") {
    throw refuse("unsupported_amount", "Crossmint sent a maximum rather than an exact total. Decline and ask the person how to proceed.");
  }
  if (amount.currency !== approved.currency) {
    throw refuse("currency_mismatch", "The approved currency differs from Crossmint's.");
  }
  if (compareAmounts(amount.value, approved.amount) !== 0) {
    throw refuse("amount_mismatch", `Crossmint is asking for ${amount.value} ${amount.currency}, not the approved amount.`);
  }
  const liveHost = merchant.url ? hostOf(merchant.url) : undefined;
  if (!liveHost || liveHost !== hostOf(approved.merchant)) {
    throw refuse("merchant_mismatch", "The approved merchant differs from the one Crossmint is checking out at.");
  }
  if (record.maxCost.currency !== amount.currency || compareAmounts(amount.value, record.maxCost.amount) > 0) {
    throw refuse("cap_exceeded", `The total exceeds the ${record.maxCost.amount} ${record.maxCost.currency} cap this checkout was started with.`);
  }
  return { amount: { amount: amount.value, currency: amount.currency }, merchant: liveHost };
}
