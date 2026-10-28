import { z } from "zod";
import {
  AMOUNT,
  CrossmintPolicyError,
  CrossmintRequestError,
  CrossmintSetupError,
  isCrossmintConfigured,
  type CheckoutSnapshot,
} from "../../server/crossmint/client";

/** How long one tool call waits for Crossmint before returning the latest snapshot. */
export const WAIT_MS = 90_000;

export const amount = z.string().regex(AMOUNT, "Decimal string such as 20.00");
export const currency = z.string().length(3).toUpperCase().describe("ISO 4217 code, such as USD or EUR.");
export const runId = z.string().min(1).max(200);
export const requestId = z.string().min(1).max(200);

export type CheckoutToolOutput =
  | { status: "not_configured"; hint: string }
  | { status: "error"; reason: string; message: string }
  | CheckoutSnapshot;

export function notConfigured(): CheckoutToolOutput | undefined {
  if (isCrossmintConfigured()) return undefined;
  return { status: "not_configured", hint: "Set CROSSMINT_SERVER_API_KEY and CROSSMINT_USER_ID on the server. See docs/crossmint.md." };
}

/** Crossmint errors carry fixed, sanitized messages the model may see. Anything else is rethrown. */
export function errorOutput(error: unknown): CheckoutToolOutput {
  if (error instanceof CrossmintSetupError || error instanceof CrossmintRequestError || error instanceof CrossmintPolicyError) {
    return { status: "error", reason: error.reason, message: error.message };
  }
  throw error;
}
