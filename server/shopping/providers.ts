import { z } from "zod";
import type { Destination } from "../monitors/config";
import { postLinqMessage } from "../monitors/provider";

const status = z.enum(["pending", "queued", "sent", "delivered", "received", "read", "failed"]);
const message = z.object({
  id: z.string().min(1).max(256),
  status: status.optional(),
  delivery_status: status.optional(),
  from_handle: z.object({ handle: z.string() }).nullish(),
  sender_handle: z.object({ handle: z.string() }).nullish(),
  from: z.string().nullish(),
  is_from_me: z.boolean().optional(),
  direction: z.string().optional(),
});
const sentMessage = z.object({ chat_id: z.string(), message });

export type Delivery =
  | { state: "accepted" | "failed"; messageId: string; status: string }
  | { state: "uncertain" };

export async function sendPriceAlert(destination: Destination, text: string, key: string, signal?: AbortSignal): Promise<Delivery> {
  const parsed = sentMessage.safeParse(await postLinqMessage(destination, text, key, signal));
  if (!parsed.success) return { state: "uncertain" };
  const { chat_id: chat, message: sent } = parsed.data;
  const handles = [sent.from, sent.from_handle?.handle, sent.sender_handle?.handle].filter(handle => handle != null);
  const result = sent.status ?? sent.delivery_status;
  if (chat !== destination.chat || handles.some(handle => handle !== destination.line) ||
    sent.is_from_me === false || sent.direction === "inbound" || !result ||
    (sent.status && sent.delivery_status && sent.status !== sent.delivery_status)) {
    return { state: "uncertain" };
  }
  return { state: result === "failed" ? "failed" : "accepted", messageId: sent.id, status: result };
}
