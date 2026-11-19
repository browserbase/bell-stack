import { defineSchedule } from "eve/schedules";
import linq from "../channels/linq";
import { localTimezone } from "../lib/linq";
import { privateLinqRecipients } from "../../server/linq";
import { notionEnabled } from "../../server/notion/config";
import { getNotionOAuth } from "../../server/notion/oauth";

const timezone = localTimezone();
const calendarDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
});

export default defineSchedule({
  cron: "30 8 * * *",
  timezone,
  async run({ to }) {
    if (!notionEnabled()) return;
    const now = new Date();
    const morningDate = calendarDate.format(now);

    for (const { destination, principalId, subject } of await privateLinqRecipients()) {
      try {
        if ((await getNotionOAuth().status({ type: "user", issuer: "linq", id: principalId })).status !== "connected") continue;
        const chat = destination.chat;
        await to(linq, { adapterName: "linq", threadId: `linq:${chat}`, morningDate }).send(
          "Give the user a short morning update. Use notion-memory to check their current priorities, "
            + "unfinished plans, and upcoming deadlines. Reply directly in this chat with useful source links. "
            + `It is ${now.toISOString()}; the local timezone is ${timezone}. `
            + "If there is nothing useful to share, call no_reply.",
          { idempotencyKey: `morning:${morningDate}:${chat}`, auth: {
            principalType: "user", authenticator: "linq-message", issuer: "linq", principalId,
            subject,
            attributes: { bell_timezone: timezone, bell_watch_chat: chat, bell_watch_sender: destination.sender, bell_watch_line: destination.line },
          } },
        );
      } catch (error) {
        console.error("Could not queue a Linq morning briefing.", error instanceof Error ? error.name : "Unknown error");
      }
    }
  },
});
