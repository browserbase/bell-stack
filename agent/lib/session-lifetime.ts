import type { PhotonDb } from "../../server/photon/store.js";

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
