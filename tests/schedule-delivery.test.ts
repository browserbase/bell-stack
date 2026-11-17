import { afterEach, beforeEach, expect, it, vi } from "vitest";
import linq from "../agent/channels/linq";
import morning from "../agent/schedules/morning";
import reminders from "../agent/schedules/reminders";
import * as notionOAuth from "../server/notion/oauth";
import { ScheduleDispatcher } from "../node_modules/eve/dist/src/channel/schedule.js";
import type { ChannelAdapter } from "../node_modules/eve/dist/src/channel/adapter.js";
import type { RunInput } from "../node_modules/eve/dist/src/channel/types.js";
import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";
import { SessionKey } from "../node_modules/eve/dist/src/context/keys.js";

const { adapter } = linq as unknown as { adapter: ChannelAdapter };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-18T03:00:00Z"));
  vi.stubEnv("TZ", "Asia/Kolkata");
  vi.stubEnv("NOTION_ENABLED", "true");
  vi.spyOn(notionOAuth, "getNotionOAuth").mockReturnValue({ status: async () => ({ status: "connected" }) } as never);
  vi.stubEnv("BELL_LINQ_PHONE_NUMBER", "+12025550100");
  vi.stubEnv("BELL_LINQ_ALLOWED_SENDERS", "+12025550123");
  vi.stubEnv("LINQ_API_KEY", "synthetic-test-key");
  vi.stubEnv("LINQ_WEBHOOK_SECRET", "synthetic-signing-secret");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.linqapp.com/api/partner/v3/chats?"))
      return Response.json({ chats: [{ id: "private-chat", is_group: false, handles: [
        { id: "line", handle: "+12025550100", is_me: true },
        { id: "sender-id", handle: "+12025550123", is_me: false },
      ] }], next_cursor: null });
    if (url !== "https://api.linqapp.com/api/partner/v3/chats/private-chat/messages")
      throw new Error(`Unexpected provider request: ${url}`);
    return Response.json({ chat_id: "private-chat", message: { id: "reply-id" } });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(["morning", "reminders"])("delivers %s through Eve's dispatcher and the real Linq adapter", async kind => {
  const createSession = vi.fn<(input: RunInput) => Promise<{ sessionId: string }>>()
    .mockResolvedValue({ sessionId: "scheduled-session" });
  const dispatcher = new ScheduleDispatcher({
    runtime: {
      createSession,
      dispatchContinuation: async () => ({ status: "session_not_active" }),
    } as never,
    channels: [{ name: "linq", definition: linq, receive: linq.receive, adapter }] as never,
  });
  if (kind === "morning") {
    await dispatcher.trigger({ scheduleId: "morning", run: morning.run });
  } else {
    await dispatcher.triggerCollection({
      collectionId: "reminders", definition: reminders,
      occurrence: { collection: "reminders", name: "milk", scheduleId: "schedule-id", executionId: "execution-id", scheduledAt: new Date().toISOString() },
      payload: {
        eve: { application: "bell-test", collection: "reminders", version: 3 },
        envelope: {
          version: 3, scope: "test-user",
          principal: { type: "user", authenticator: "linq-message", issuer: "linq", principalId: "linq:sender-id", subject: "sender-id" },
          payload: { task: "Remind the user to buy milk", timezone: "Asia/Kolkata", destination: {
            chat: "private-chat", sender: "+12025550123", line: "+12025550100",
          } },
        },
      },
    });
  }
  expect(createSession).toHaveBeenCalledOnce();
  const input = createSession.mock.calls[0][0];
  expect(input.auth).toMatchObject({ principalType: "user", issuer: "linq", principalId: "linq:sender-id" });
  expect(input.adapter.state?.thread).toMatchObject({ id: "linq:private-chat" });
  const context = new ContextContainer();
  context.set(SessionKey, { sessionId: "scheduled-session" } as never);
  await contextStorage.run(context, async () => {
    const adapterContext = adapter.createAdapterContext!({
      state: input.adapter.state!, ctx: context, session: { id: "scheduled-session" },
    } as never);
    await adapter["message.completed"]!({ message: "Bell's scheduled reply", finishReason: "stop" } as never, adapterContext);
  });
  expect(fetch).toHaveBeenCalledTimes(kind === "morning" ? 2 : 1);
});
