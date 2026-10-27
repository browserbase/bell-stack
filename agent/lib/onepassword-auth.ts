import { defineInteractiveAuthorization, type ConnectionPrincipal } from "eve/connections";
import type { ToolContext } from "eve/tools";
import { getOnePassword, type Resume } from "../../server/onepassword/oauth";
import { failed, ownerOf } from "../../server/onepassword/config";
import { messagingPrincipal } from "./messaging-auth";

export function onePasswordPrincipal(ctx: ToolContext): ConnectionPrincipal {
  // Personal 1Password is private-only: group sessions and other callers fall
  // through to { type: "app" }, which fails ownerOf — deliberate fail-closed.
  const verified = messagingPrincipal(ctx);
  const principal: ConnectionPrincipal = verified?.audience === "direct"
    ? verified.principal
    : { type: "app" };
  ownerOf(principal);
  return principal;
}
export async function safeOnePassword<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof Error && ["ConnectionAuthorizationRequiredError", "ConnectionAuthorizationFailedError"].includes(error.name)) throw error;
    return failed("request_failed");
  }
}
export function createOnePasswordAuth(service = getOnePassword) {
  return defineInteractiveAuthorization<Resume>({
    displayName: "1Password",
    getToken: ({ principal }) => safeOnePassword(() => service().getToken(principal)),
    startAuthorization: ({ principal, callbackUrl }) => safeOnePassword(() => service().start(principal, callbackUrl)),
    completeAuthorization: ({ principal, callbackUrl, resume, callback }) => safeOnePassword(() => service().complete(principal, callbackUrl, resume, callback.params)),
  });
}
export const onePasswordAuth = createOnePasswordAuth();
