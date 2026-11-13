import type { ToolContext } from "eve/tools";
import { z } from "zod";

export const poppyUrl = z.string().url().max(2048).describe("HTTPS company URL; discovery uses its well-known manifest.");
export const poppyApiIndex = z.number().int().min(0).max(99).describe("API index returned by poppy_discover.");

export function poppyOwner(ctx: ToolContext): string {
  const auth = ctx.session.auth.current;
  if (!auth?.principalId || !["user", "local-dev"].includes(auth.principalType))
    throw new Error("Poppy account access requires an authenticated Bell user or loopback development session.");
  return JSON.stringify([auth.authenticator, auth.issuer ?? "", auth.principalType, auth.principalId]);
}
