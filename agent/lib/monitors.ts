import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { digest } from "../../server/shopping/config";
import type { Inbound } from "../../server/shopping/store";
import { assertOwner, destinationSchema } from "../../server/monitors/config";

export function watchIdentity(ctx: ToolContext) {
  const auth = ctx.session.auth.current;
  if (!auth || auth.authenticator !== "linq-message" || auth.principalType !== "user") throw new Error("Watches require an authenticated Linq sender.");
  const owner = { issuer: auth.issuer ?? "", id: auth.principalId };
  assertOwner(owner);
  return owner;
}
export function watchDestination(ctx: ToolContext) {
  watchIdentity(ctx);
  const attributes = ctx.session.auth.current!.attributes;
  return destinationSchema.parse({ chat: attributes.bell_watch_chat, sender: attributes.bell_watch_sender, line: attributes.bell_watch_line });
}
export async function safeWatch<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/^(Watches |Watch not found|Watch operation|This Linq)/.test(message)) throw new Error(message);
    throw new Error("Watch operation failed. List watches before retrying creation; an uncertain watch may already exist.");
  }
}

export function signedPriceMessage(ctx: ToolContext): Inbound {
  const owner = watchIdentity(ctx);
  const destination = watchDestination(ctx);
  const attributes = ctx.session.auth.current!.attributes;
  const signed = z.object({
    bell_linq_message: z.string().min(1).max(256),
    bell_linq_sent_at: z.iso.datetime({ offset: true }).optional(),
    bell_linq_text_hash: z.string(),
  }).safeParse(attributes);
  // The current auth attributes can be older than a steering message represented in tool history.
  // Require the latest user text the tool actually saw to agree with the authenticated input.
  const user = ctx.messages.findLast(message => message.role === "user");
  const text = typeof user?.content === "string" ? user.content : user?.content.length === 1 &&
    user.content[0].type === "text" ? user.content[0].text : undefined;
  if (!signed.success || !text || digest(text.trim()) !== signed.data.bell_linq_text_hash) {
    throw new Error("Watch operation needs the exact current Linq message. Ask the shopper to send the complete request again.");
  }
  return { owner, destination, messageId: signed.data.bell_linq_message, sentAt: signed.data.bell_linq_sent_at };
}
