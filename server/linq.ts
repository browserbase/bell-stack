import { z } from "zod";
import { allowed } from "./monitors/config";
import { request } from "./monitors/provider";

const handleSchema = z.object({
  id: z.string().min(1), handle: z.string(), is_me: z.boolean().optional(),
  left_at: z.string().nullish(), status: z.string().optional(),
});
const chatsSchema = z.object({
  chats: z.array(z.object({
    id: z.string().min(1), is_group: z.boolean(), is_archived: z.boolean().optional(),
    handles: z.array(handleSchema),
  })),
  next_cursor: z.string().nullish(),
});

export async function privateLinqRecipients() {
  const key = process.env.LINQ_API_KEY?.trim();
  const line = process.env.BELL_LINQ_PHONE_NUMBER?.trim();
  if (!key || !line || !process.env.BELL_LINQ_ALLOWED_SENDERS?.trim()) return [];
  const recipients = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  const params = new URLSearchParams({ from: line, limit: "100" });
  for (;;) {
    const page = chatsSchema.parse(await request(`https://api.linqapp.com/api/partner/v3/chats?${params}`, key, "GET", undefined, true));
    for (const chat of page.chats) {
      if (chat.is_group || chat.is_archived) continue;
      const handles = chat.handles.filter(handle => !handle.left_at && (!handle.status || handle.status === "active"));
      if (handles.length !== 2 || !handles.some(handle => handle.is_me && handle.handle === line)) continue;
      const sender = handles.find(handle => handle.is_me === false);
      if (!sender || seen.has(sender.id)) continue;
      const destination = { chat: chat.id, sender: sender.handle, line };
      if (!allowed(destination)) continue;
      seen.add(sender.id);
      recipients.push({ destination, principalId: `linq:${sender.id}`, subject: sender.id });
    }
    if (!page.next_cursor) return recipients;
    if (cursors.has(page.next_cursor)) throw new Error("Linq chat pagination did not advance.");
    cursors.add(page.next_cursor);
    params.set("cursor", page.next_cursor);
  }
}
