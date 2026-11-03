import { AsyncLocalStorage } from "node:async_hooks";
import { type PoolClient } from "pg";
import { personalConnectionsEnabled } from "./config";
import { createPool, withAdvisoryLock } from "../postgres";
const activeLock = new AsyncLocalStorage<{ client: PoolClient; sessionId: string }>();
export async function markSecretFill(blocked: boolean): Promise<void> {
  const lock = activeLock.getStore();
  if (!lock) throw new Error("A private browser lock is required.");
  if (blocked) await lock.client.query("INSERT INTO bell_onepassword_browser_guards(session_id) VALUES($1) ON CONFLICT DO NOTHING", [lock.sessionId]);
  else await lock.client.query("DELETE FROM bell_onepassword_browser_guards WHERE session_id=$1", [lock.sessionId]);
}
export function personalBrowserEnabled(): boolean {
  return personalConnectionsEnabled() && Boolean(process.env.BROWSERBASE_1PASSWORD_EXTENSION_ID?.trim());
}
export function requireReusableContexts(): void {
  if (personalBrowserEnabled()) throw new Error("Reusable browser Contexts are disabled for personal 1Password. Start a new private conversation instead.");
}
let pool: ReturnType<typeof createPool> | undefined;
export async function withPersonalBrowserLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  if (!personalBrowserEnabled()) return operation();
  if (!process.env.DATABASE_URL) throw new Error("Personal 1Password requires DATABASE_URL.");
  pool ??= createPool(process.env.DATABASE_URL, "Private browser", { allowExitOnIdle: true });
  return withAdvisoryLock(pool, `bell-private-browser:${sessionId}`, async (client) => {
    if ((await client.query("SELECT 1 FROM bell_onepassword_browser_guards WHERE session_id=$1", [sessionId])).rowCount) throw new Error("A private login did not finish safely. Start a new conversation.");
    return activeLock.run({ client, sessionId }, operation);
  });
}
