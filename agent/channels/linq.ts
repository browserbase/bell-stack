import { linqBrowserEvents, requiredEnvironmentValue } from "../lib/linq";
import { defaultLinqAuth, linqChannel, type LinqChannelConfig } from "eve/channels/linq";
import { z } from "zod";
import { allowed } from "../../server/monitors/config";
import { digest } from "../../server/shopping/config";

const phoneNumber = z.string().regex(/^\+[1-9]\d{1,14}$/);
const signedMessage = z.object({
  id: z.string().min(1).max(256),
  sent_at: z.iso.datetime({ offset: true }).nullish(),
  parts: z.array(z.object({ type: z.enum(["text", "link"]), value: z.string() })).min(1),
});
const inboundMessage = z.object({
  direction: z.literal("inbound"),
  chat: z.object({
    is_group: z.literal(false),
    id: z.string().min(1).max(256),
    owner_handle: z.object({ handle: phoneNumber }),
  }),
  sender_handle: z.object({ handle: phoneNumber, is_me: z.literal(false) }),
});

type LinqMessage = Parameters<NonNullable<LinqChannelConfig["onMessage"]>>[1];
type IncomingMessage = Pick<LinqMessage, "author" | "raw">;

function messageDestination(message: IncomingMessage) {
  if (message.author.isBot) return;
  const incoming = inboundMessage.safeParse(message.raw);
  if (!incoming.success) return;
  const { chat, sender_handle } = incoming.data;
  const destination = { chat: chat.id, sender: sender_handle.handle, line: chat.owner_handle.handle };
  if (allowed(destination)) return destination;
}

export function isAllowedBellMessage(message: IncomingMessage): boolean {
  return !!messageDestination(message);
}

export default linqChannel({
  events: linqBrowserEvents,
  userName: "Bell",
  credentials: {
    apiKey: () => requiredEnvironmentValue("LINQ_API_KEY"),
    signingSecret: () => requiredEnvironmentValue("LINQ_WEBHOOK_SECRET"),
  },
  turnPolicy: "steer",
  onMessage(_context, message) {
    const destination = messageDestination(message);
    if (!destination) return null;
    const signed = signedMessage.safeParse(message.raw);
    const signedAttributes = signed.success && message.text.trim() ? {
      bell_linq_message: signed.data.id,
      bell_linq_text_hash: digest(message.text.trim()),
      ...(signed.data.sent_at ? { bell_linq_sent_at: signed.data.sent_at } : {}),
    } : {};
    const baseAuth = defaultLinqAuth(message);
    const auth = { ...baseAuth, attributes: { ...baseAuth.attributes, ...signedAttributes,
      bell_watch_chat: destination.chat, bell_watch_sender: destination.sender, bell_watch_line: destination.line } };
    return {
      auth,
      context: [
        "This request arrived through Bell's private Linq iMessage or SMS channel. "
        + "Reply concisely in this chat. Use the same browser for follow-up requests. "
        + "For a human-only step, send the human_handoff tool's link and wait for a reply.",
      ],
    };
  },
});
