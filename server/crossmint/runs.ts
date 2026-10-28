import type { MaxCost } from "./client";

/**
 * Checkouts started in this process, keyed by Eve session. A conversation can only read, answer,
 * pay for, or cancel a checkout it started, so a model-supplied id cannot reach another buyer's
 * run. The cap each run was created with is kept here and checked again at payment time.
 *
 * The registry lives in process memory. After a restart or a worker change an unfinished checkout
 * is reconciled in the Crossmint console, not retried here.
 */
export interface CheckoutRecord {
  runId: string;
  maxCost: MaxCost;
  /** Authenticated principal that started the run, when the channel provided one. */
  principalId: string | null;
}

const runs = new Map<string, Map<string, CheckoutRecord>>();

export function rememberCheckout(sessionId: string, record: CheckoutRecord): void {
  let session = runs.get(sessionId);
  if (!session) {
    session = new Map();
    runs.set(sessionId, session);
  }
  session.set(record.runId, record);
}

export function sessionCheckout(sessionId: string, runId: string): CheckoutRecord | undefined {
  return runs.get(sessionId)?.get(runId);
}

export function assertSessionCheckout(sessionId: string, runId: string): CheckoutRecord {
  const record = sessionCheckout(sessionId, runId);
  if (!record) {
    throw new Error(
      "This conversation did not start that checkout in this process. Start a new checkout, or reconcile the existing one in the Crossmint console.",
    );
  }
  return record;
}
