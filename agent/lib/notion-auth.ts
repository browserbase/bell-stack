import { defineInteractiveAuthorization, type ConnectionPrincipal } from "eve/connections";
import type { ToolContext } from "eve/tools";
import { failed, notionOwner, safeNotion } from "../../server/notion/config";
import { getNotionOAuth, type NotionResume } from "../../server/notion/oauth";

export function notionPrincipal(ctx: { session: { auth: ToolContext["session"]["auth"] } }): ConnectionPrincipal {
  const auth = ctx.session.auth.current;
  if (auth?.principalType !== "user") return failed("principal_required");
  const principal: ConnectionPrincipal = { type: "user", id: auth.principalId, issuer: auth.issuer };
  notionOwner(principal);
  return principal;
}

export function createNotionAuth(service = getNotionOAuth) {
  return defineInteractiveAuthorization<NotionResume>({
    getToken: ({ principal }) => safeNotion(() => service().getToken(principal)),
    evict: ({ principal }) => safeNotion(() => service().evict(principal)),
    startAuthorization: ({ principal, callbackUrl }) => safeNotion(() => service().start(principal, callbackUrl)),
    completeAuthorization: ({ principal, callbackUrl, resume, callback }) =>
      safeNotion(() => service().complete(principal, callbackUrl, resume, callback.params)),
  });
}

export const notionAuth = createNotionAuth();
