import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleScopeContext } from "eve/experimental/schedules";
import { inMemoryScheduleProvider } from "eve/experimental/schedules/testing";
import reminders from "../agent/schedules/reminders";
import linq from "../agent/channels/linq";
import { createScheduleCollectionClient } from "../node_modules/eve/dist/src/runtime/schedules/collection-client.js";

const destination = { chat: "private-chat", sender: "+12025550123", line: "+12025550100" };
const principal = { type: "user", authenticator: "linq-message", issuer: "linq", principalId: "linq:sender", subject: "sender" };
const auth = {
  principalType: principal.type, ...principal,
  attributes: { bell_watch_chat: destination.chat, bell_watch_sender: destination.sender, bell_watch_line: destination.line },
};
const context: ScheduleScopeContext = {
  session: { id: "creating-session", auth: { current: auth, initiator: auth } },
  channel: { kind: "channel:linq", metadata: {} }, abortSignal: new AbortController().signal,
};
const occurrence = { collection: "reminders", name: "morning", scheduleId: "schedule-id", executionId: "execution-id", scheduledAt: "2026-11-18T03:00:00Z" };

const schedule = { disable: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
const expression = { type: "delay", minutes: 10 } as const;

beforeEach(() => {
  vi.stubEnv("TZ", "America/New_York");
  vi.stubEnv("BELL_LINQ_PHONE_NUMBER", destination.line);
  vi.stubEnv("BELL_LINQ_ALLOWED_SENDERS", destination.sender);
});
afterEach(() => vi.unstubAllEnvs());

describe("Native Eve schedules", () => {
  it("captures the verified chat instead of accepting model-supplied recipients", async () => {
    const saved = await reminders.preparePayload!({ task: "Read my Notion priorities" }, { ...context, operation: "create", expression, name: "morning" });
    expect(saved).toEqual({ task: "Read my Notion priorities", destination, timezone: "America/New_York" });
    expect((await reminders.inputSchema["~standard"].validate({ task: "Hello", destination })).issues).toBeDefined();
  });

  it("rejects creation outside a private Linq identity", async () => {
    expect(() => reminders.preparePayload!({ task: "Hello" }, {
      ...context, operation: "create", expression, name: "test", session: { ...context.session, auth: { current: null, initiator: null } },
    })).toThrow("private Linq");
  });

  it("rechecks the creator and current sender allowlist before a run", async () => {
    const payload = { task: "Hello", destination, timezone: "America/New_York" };
    expect(await reminders.auth({ principal, payload, occurrence, schedule })).toMatchObject({ principalId: principal.principalId });
    expect(await reminders.auth({ principal: { ...principal, issuer: "other" }, payload, occurrence, schedule })).toBeNull();
    vi.stubEnv("BELL_LINQ_ALLOWED_SENDERS", "");
    expect(await reminders.auth({ principal, payload, occurrence, schedule })).toBeNull();
  });

  it("hands the task to the existing Linq channel as a fresh scheduled run", async () => {
    const send = vi.fn(async () => ({} as never));
    const to = vi.fn(() => ({ send }));
    await reminders.run({ payload: { task: "Read fresh Notion plans", destination, timezone: "America/New_York" }, occurrence, auth, schedule, to, waitUntil: () => {} });
    expect(to).toHaveBeenCalledWith(linq, { adapterName: "linq", threadId: `linq:${destination.chat}` });
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Read fresh Notion plans"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining(occurrence.scheduledAt));
  });

  it.each(["0 7 * * *", "30 8 * * *", "0 9 * * *"])("uses Eve's CRUD and per-user scope for daily %s schedules", async cron => {
    const definition = { ...reminders, provider: inMemoryScheduleProvider() };
    const client = createScheduleCollectionClient(definition, { ...context, application: "bell-test", collection: "reminders" });
    const record = await client.create({ name: "morning", expression: { type: "cron", cron, timezone: "Asia/Kolkata" }, payload: { task: "Read Notion plans in Asia/Kolkata" } });
    const timezone = new Intl.DateTimeFormat("en", { timeZone: "Asia/Kolkata" }).resolvedOptions().timeZone;
    expect(record.expression).toEqual({ type: "cron", cron, timezone });
    expect((await client.list()).data).toHaveLength(1);
    const other = createScheduleCollectionClient(definition, {
      ...context, application: "bell-test", collection: "reminders",
      session: { ...context.session, auth: { current: { ...auth, principalId: "linq:other" }, initiator: auth } },
    });
    expect((await other.list()).data).toHaveLength(0);
    expect(await other.delete(record.name)).toBe(false);
    expect((await client.disable(record.name)).state).toBe("inactive");
    expect((await client.enable(record.name)).state).toBe("active");
    await client.update(record.name, { expression: { type: "cron", cron: "0 10 * * *", timezone: "Asia/Kolkata" } });
    expect((await client.get(record.name))?.expression).toMatchObject({ cron: "0 10 * * *" });
    expect(await client.delete(record.name)).toBe(true);
  });
});
