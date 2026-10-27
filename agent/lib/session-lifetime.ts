import type { DeadlineRow, PhotonDb } from "../../server/photon/store.js";

/**
 * Persisted absolute session deadline policy.
 *
 * Eve 0.82 redefined `sessionTimeoutMs` as an idle timeout that resets on
 * every turn. Bell's pre-upgrade contract was a 24-hour maximum conversation
 * lifetime, so this module keeps an absolute deadline in the channel store:
 * it is written once on the first admitted turn (`ON CONFLICT DO NOTHING`),
 * survives restarts, and is enforced by the dispatch route before each send
 * and by the worker's retirement sweep through `/internal/photon/retire`.
 */
export const SESSION_ABSOLUTE_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export class SessionDeadlineExpiredError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Photon session ${sessionId} passed its absolute deadline.`);
    this.name = "SessionDeadlineExpiredError";
    this.sessionId = sessionId;
  }
}

/**
 * Records the absolute deadline for a bound Eve session. The insert is
 * idempotent: the first admitted turn owns the deadline so follow-up turns
 * never extend the maximum lifetime.
 */
export async function registerSessionDeadline(
  db: PhotonDb,
  sessionId: string,
  bindingId?: string,
  now: Date = new Date(),
): Promise<Date> {
  const deadlineAt = new Date(now.getTime() + SESSION_ABSOLUTE_LIFETIME_MS);
  await db.registerDeadline(sessionId, bindingId, deadlineAt);
  return deadlineAt;
}

/**
 * Enrolls the deadline right after a dispatch bound a session. This is the
 * same operation as {@link registerSessionDeadline}; the separate name keeps
 * the dispatch route's intent readable.
 */
export async function enrollDeadlineOnDispatch(
  db: PhotonDb,
  sessionId: string,
  bindingId: string,
): Promise<Date> {
  return registerSessionDeadline(db, sessionId, bindingId);
}

/**
 * Whether the session's persisted absolute deadline has passed and the
 * session has not already been retired. Sessions without a deadline row are
 * not expired: the deadline is registered on the first admitted turn.
 */
export async function isSessionExpired(
  db: PhotonDb,
  sessionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const deadline = await db.getDeadline(sessionId);
  return !!deadline && !deadline.retiredAt && now.getTime() > deadline.deadlineAt.getTime();
}

/**
 * Throws {@link SessionDeadlineExpiredError} when the session's absolute
 * deadline has passed. Kept pure — the caller decides whether to retire,
 * reset or reject.
 */
export async function assertSessionAlive(
  db: PhotonDb,
  sessionId: string,
  now: Date = new Date(),
): Promise<void> {
  if (await isSessionExpired(db, sessionId, now))
    throw new SessionDeadlineExpiredError(sessionId);
}

/**
 * Opportunistic read of due deadlines for Eve-side checks. The worker owns
 * the authoritative sweep and calls `/internal/photon/retire`; channel code
 * only inspects so a late event never reopens retired sensitive work.
 */
export function sweepDeadlines(
  db: PhotonDb,
  now: Date = new Date(),
  limit = 100,
): Promise<DeadlineRow[]> {
  return db.dueDeadlines(now, limit);
}
