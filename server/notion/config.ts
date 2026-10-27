import { ConnectionAuthorizationFailedError, type ConnectionPrincipal } from "eve/connections";

export const notionEndpoint = "https://mcp.notion.com/mcp";
export const notionEnabled = () => process.env.NOTION_ENABLED === "true";

export function failed(reason: string): never {
  throw new ConnectionAuthorizationFailedError("notion", { reason, retryable: false });
}

export function notionOwner(principal: ConnectionPrincipal): string {
  if (principal.type !== "user" || !principal.issuer || !principal.id || principal.id.length > 512)
    return failed("principal_required");
  if (!(principal.issuer === "bell:operator" && principal.id === "operator")
    && !(principal.issuer === "linq" && principal.id.startsWith("linq:") && principal.id.length > 5))
    return failed("principal_not_allowed");
  return JSON.stringify([principal.issuer, principal.id]);
}

export function notionConfig() {
  if (!notionEnabled()) return failed("notion_disabled");
  const origin = process.env.BELL_PUBLIC_URL?.trim() ?? "";
  let url: URL;
  try { url = new URL(origin); } catch { return failed("invalid_public_url"); }
  if (url.origin !== origin || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    return failed("invalid_public_url");
  const encodedKey = process.env.NOTION_TOKEN_ENCRYPTION_KEY?.trim() ?? "";
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey) return failed("invalid_encryption_key");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return failed("database_required");
  return { origin, key, databaseUrl, redirectUri: `${origin}/api/notion/oauth/callback` };
}

export async function safeNotion<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof Error && ["ConnectionAuthorizationRequiredError", "ConnectionAuthorizationFailedError"].includes(error.name)) throw error;
    return failed("notion_request_failed");
  }
}
