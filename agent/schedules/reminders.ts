import { defineDynamicSchedules } from "eve/experimental/schedules";
import { z } from "zod";
import linq from "../channels/linq";
import { localTimezone } from "../lib/linq";
import { allowed, destinationSchema } from "../../server/monitors/config";

const inputSchema = z.object({ task: z.string().trim().min(1).max(2_000) }).strict();
const savedSchema = inputSchema.extend({ destination: destinationSchema, timezone: z.string().optional() }).strict();

export default defineDynamicSchedules({
  description: "Schedule one-time reminders or recurring tasks in your private Linq chat, requested by the user. "
    + "Use their local timezone from context or a saved preference without asking. Set expression.timezone for wall-clock times. "
    + "List existing schedules before retrying creation or making changes.",
  inputSchema,
  preparePayload(payload, { session }) {
    const auth = session.auth.current;
    if (auth?.principalType !== "user" || auth.authenticator !== "linq-message" || auth.issuer !== "linq")
      throw new Error("Create reminders from your private Linq chat.");
    const destination = destinationSchema.parse({
      chat: auth.attributes.bell_watch_chat,
      sender: auth.attributes.bell_watch_sender,
      line: auth.attributes.bell_watch_line,
    });
    if (!allowed(destination)) throw new Error("This Linq sender or receiving line is no longer allowed.");
    return { ...payload, destination, timezone: typeof auth.attributes.bell_timezone === "string" ? auth.attributes.bell_timezone : localTimezone() };
  },
  auth({ principal, payload }) {
    const saved = savedSchema.safeParse(payload);
    if (!saved.success || principal.type !== "user" || principal.authenticator !== "linq-message"
      || principal.issuer !== "linq" || !allowed(saved.data.destination)) return null;
    const { destination } = saved.data;
    return {
      principalType: principal.type, authenticator: principal.authenticator,
      issuer: principal.issuer, principalId: principal.principalId, subject: principal.subject,
      attributes: { bell_timezone: saved.data.timezone ?? localTimezone(), bell_watch_chat: destination.chat, bell_watch_sender: destination.sender, bell_watch_line: destination.line },
    };
  },
  async run({ payload, occurrence, to }) {
    const { task, destination, timezone } = savedSchema.parse(payload);
    await to(linq, { adapterName: "linq", threadId: `linq:${destination.chat}` }).send(
      `Do this scheduled task now: ${task}\nScheduled for: ${occurrence.scheduledAt}. `
        + `Local timezone: ${timezone ?? localTimezone()}. Respect a timezone specified in the task.`,
    );
  },
});
