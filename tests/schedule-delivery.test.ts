import { afterEach, beforeEach, expect, it, vi } from "vitest";
import linq from "../agent/channels/linq";
import morning from "../agent/schedules/morning";
import reminders from "../agent/schedules/reminders";
import * as notionOAuth from "../server/notion/oauth";
import agent from "../agent/agent";
import type { AgentDefinition } from "eve";
// @ts-expect-error Eve 1.1 does not publish declarations for its internal dispatcher.
import { ScheduleDispatcher } from "../node_modules/eve/dist/src/channel/schedule.js";
import type { ChannelAdapter, ChannelAdapterContext } from "../node_modules/eve/dist/src/channel/adapter.js";
import type { DispatchContinuationInput, RunInput, SessionSendCommandResult } from "../node_modules/eve/dist/src/channel/types.js";
import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";
import { SessionKey } from "../node_modules/eve/dist/src/context/keys.js";
import { readSessionSchedule } from "../node_modules/eve/dist/src/context/session-schedule.js";
import { emptySessionView } from "../node_modules/eve/dist/src/protocol/session-projection/fold.js";

const { adapter } = linq as unknown as {
  adapter: ChannelAdapter & { createAdapterContext(input: unknown): ChannelAdapterContext };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-18T13:30:00Z"));
  vi.stubEnv("TZ", "America/Montreal");
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

it.each([
  ["morning", false], ["morning", true], ["reminders", false],
])("delivers %s through Eve and Linq (active interactive session: %s)", async (kind, existingSession) => {
  const createSession = vi.fn<(input: RunInput) => Promise<{ sessionId: string }>>()
    .mockImplementation(async () => {
      const context = contextStorage.getStore();
      if (!context) throw new Error("Expected Eve schedule context.");
      expect(readSessionSchedule(context)).toMatchObject({ definition: kind });
      return { sessionId: "scheduled-session" };
    });
  const dispatchContinuation = vi.fn<(input: DispatchContinuationInput) => Promise<SessionSendCommandResult>>()
    .mockImplementation(async ({ continuationToken }) =>
      existingSession && continuationToken === "linq:linq:private-chat"
        ? { status: "accepted", sessionId: "interactive-session" }
        : { status: "session_not_active" },
    );
  const dispatcher = new ScheduleDispatcher({
    runtime: { createSession, dispatchContinuation },
    channels: [{ name: "linq", definition: linq, receive: linq.receive, adapter, turnPolicy: linq.turnPolicy }],
  });
  if (kind === "morning") {
    await dispatcher.trigger({ scheduleId: "morning", run: morning.run });
  } else {
    await dispatcher.triggerCollection({
      collectionId: "reminders", definition: reminders,
      occurrence: { collection: "reminders", name: "milk", scheduleId: "schedule-id", executionId: "execution-id", scheduledAt: new Date().toISOString() },
      schedule: { disable: async () => {}, delete: async () => {} },
      payload: {
        eve: { application: "bell-test", collection: "reminders", version: 3 },
        envelope: {
          version: 3, scope: "test-user",
          principal: { type: "user", authenticator: "linq-message", issuer: "linq", principalId: "linq:sender-id", subject: "sender-id" },
          payload: { task: "Remind the user to buy milk", timezone: "America/Montreal", destination: {
            chat: "private-chat", sender: "+12025550123", line: "+12025550100",
          } },
        },
      },
    });
  }
  expect(createSession).toHaveBeenCalledOnce();
  const input = createSession.mock.calls[0][0];
  if (kind === "morning") {
    expect(dispatchContinuation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      continuationToken: expect.stringMatching(/^linq:morning:\d{4}-\d{2}-\d{2}:linq:private-chat$/),
      command: expect.objectContaining({ schedule: { definition: "morning" } }),
    }));
  } else {
    expect(dispatchContinuation).not.toHaveBeenCalled();
  }
  expect(input.auth).toMatchObject({ principalType: "user", issuer: "linq", principalId: "linq:sender-id" });
  expect(input.input.state).toMatchObject({ thread: { id: "linq:private-chat" } });
  const context = new ContextContainer();
  context.set(SessionKey, { sessionId: "scheduled-session", turn: { id: "scheduled-turn" } } as never);
  await contextStorage.run(context, async () => {
    const adapterContext = adapter.createAdapterContext({
      state: input.input.state, ctx: context, session: { id: "scheduled-session" },
    });
    await adapter["content.completed"]!({
      type: "content.completed",
      data: { partId: "reply", kind: "text", phase: "reply", value: "Bell's scheduled reply" },
    }, { ...adapterContext, view: emptySessionView() });
  });
  expect(fetch).toHaveBeenCalledTimes(kind === "morning" ? 2 : 1);
});

it("limits unattended turns to read-only tools without changing interactive approvals", async () => {
  type ApprovalContext = Parameters<NonNullable<AgentDefinition["approval"]>>[0];
  const approval = agent.approval;
  const scheduled = { definition: "morning" };
  for (const toolName of ["notion__notion-search", "no_reply", "web_search"])
    expect(await approval({ session: { schedule: scheduled }, toolName } as ApprovalContext)).toBeUndefined();

  for (const toolName of ["watch_create", "schedule__reminders__create", "run", "link__checkout", "notion__notion-update-page"]) {
    expect(await approval({ session: { schedule: scheduled }, toolName } as ApprovalContext)).toMatchObject({ type: "denied" });
    expect(await approval({ session: {}, toolName } as ApprovalContext)).toBeUndefined();
  }
});
