import { requiredEnvironmentValue } from "browsie/channels/linq";
import { defaultLinqAuth, linqChannel, type LinqChannelConfig } from "eve/channels/linq";
import { z } from "zod";

const phoneNumber = z.string().regex(/^\+[1-9]\d{1,14}$/);
const inboundMessage = z.object({
  direction: z.literal("inbound"),
  chat: z.object({
    is_group: z.literal(false),
    owner_handle: z.object({ handle: phoneNumber }),
  }),
  sender_handle: z.object({ handle: phoneNumber, is_me: z.literal(false) }),
});

type LinqMessage = Parameters<NonNullable<LinqChannelConfig["onMessage"]>>[1];

export function isAllowedBellMessage(message: Pick<LinqMessage, "author" | "raw">): boolean {
  if (message.author.isBot) return false;
  const incoming = inboundMessage.safeParse(message.raw);
  const receivingNumber = phoneNumber.safeParse(process.env.BELL_LINQ_PHONE_NUMBER?.trim());
  const allowedSenders = z.array(phoneNumber).nonempty().safeParse(
    (process.env.BELL_LINQ_ALLOWED_SENDERS ?? "").split(",").map((value) => value.trim()),
  );

  return incoming.success && receivingNumber.success && allowedSenders.success
    && incoming.data.chat.owner_handle.handle === receivingNumber.data
    && allowedSenders.data.includes(incoming.data.sender_handle.handle);
}

export default linqChannel({
  userName: "Bell",
  credentials: {
    apiKey: () => requiredEnvironmentValue("LINQ_API_KEY"),
    signingSecret: () => requiredEnvironmentValue("LINQ_WEBHOOK_SECRET"),
  },
  turnPolicy: "steer",
  onMessage(_context, message) {
    if (!isAllowedBellMessage(message)) return null;
    return {
      auth: defaultLinqAuth(message),
      context: [
        "This request arrived through Bell's private Linq iMessage or SMS channel. "
        + "Reply concisely in this chat. Use the same browser for follow-up requests. "
        + "For a human-only step, send the human_handoff tool's link and wait for a reply.",
      ],
    };
  },
});
