import { budgetKey, parseRetryAfter, PersonalAgentProtocolError, SharedRateLimitBudget } from "@datalayer/personal-agent-protocol";

const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 60 * 60;

export type PoppyRateLimited = { error: "rate_limited"; message: string; retryAfterSeconds: number };

/** A provider asked Bell to wait. `sent` is false when Bell refused locally without a request. */
export class PoppyRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number, readonly sent: boolean) {
    super(`Bell is pausing requests to this Poppy provider at its request. Retry after ${retryAfterSeconds} seconds.`);
    this.name = "PoppyRateLimitedError";
  }
}

// One budget per process, keyed by provider origin, so a Retry-After applies across tool calls.
function createBudget() {
  return new SharedRateLimitBudget({ maxWait: 0, monotonic: () => Date.now() / 1000 });
}
let budget = createBudget();

/** Refuse locally, without a request, while the provider's requested pause is in effect. */
export async function beforePoppyRequest(url: string): Promise<void> {
  try { await budget.acquire(budgetKey(url)); }
  catch (error) {
    if (!(error instanceof PersonalAgentProtocolError) || error.code !== "rate_limited") throw error;
    const seconds = Number(error.details?.retry_after);
    throw new PoppyRateLimitedError(Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 1, false);
  }
}

/** Record a 429 (or 503 with Retry-After) for every later request to that origin, then stop. */
export async function afterPoppyResponse(url: string, response: Response): Promise<void> {
  if (response.status !== 429 && response.status !== 503) return;
  const requested = parseRetryAfter(response.headers.get("retry-after"), new Date());
  if (requested === undefined && response.status === 503) return;
  const seconds = Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(requested ?? DEFAULT_RETRY_AFTER_SECONDS)));
  await budget.defer(budgetKey(url), seconds);
  await response.body?.cancel().catch(() => undefined);
  throw new PoppyRateLimitedError(seconds, true);
}

/** The rate-limit refusal behind an error, including one wrapped by an SDK. */
export function poppyRateLimit(error: unknown): PoppyRateLimitedError | undefined {
  let current = error;
  for (let depth = 0; current && depth < 10; depth++) {
    if (current instanceof PoppyRateLimitedError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function rateLimitedResult(error: PoppyRateLimitedError): PoppyRateLimited {
  return { error: "rate_limited", message: error.message, retryAfterSeconds: error.retryAfterSeconds };
}

/** Forget provider pauses (tests and process restarts). */
export function resetPoppyRateLimits(): void { budget = createBudget(); }
