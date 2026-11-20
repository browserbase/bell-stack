import { describe, expect, it } from "vitest";
import type { HookEvent } from "eve/hooks";

import {
  applyTaskEvent as reduceTaskEvent,
  initializeTask,
  recordTaskBrowserContext,
  safeText,
  setTaskBrowserContext,
  updateTaskBrowser,
  type DurableTaskRecord,
} from "../../agent/lib/task-state";

const empty = (): DurableTaskRecord => ({
  version: 1,
  taskId: "",
  sessionId: "",
  title: "New task",
  status: "idle",
  browser: { lifecycle: "not_started" },
  processedEventIds: [],
  createdAt: "",
  updatedAt: "",
});
const applyTaskEvent = (state: DurableTaskRecord, event: HookEvent, id: string) =>
  reduceTaskEvent(state, event, "session_fixture", { id, at: "2026-09-05T00:00:00.000Z" });
const reply = (text: string): HookEvent<"delivery.consumed"> => ({
  type: "delivery.consumed", data: { deliveryId: "delivery", turnId: "turn", parts: [{ kind: "text", text }] },
});

describe("durable Eve task state", () => {
  it("keeps a Context naming hint without copying Eve's conversation history", () => {
    let state = initializeTask(empty(), "session_fixture", "2026-09-05T00:00:00.000Z");
    state = applyTaskEvent(
      state,
      reply("Research durable agents"),
      "evt_user",
    );
    state = applyTaskEvent(
      state,
      { type: "content.completed", data: { partId: "reply", kind: "text", phase: "reply", value: "Finished." } },
      "evt_assistant",
    );
    expect(state).toMatchObject({
      version: 1,
      sessionId: "session_fixture",
      title: "Research durable agents",
    });
    expect(state).not.toHaveProperty("messages");
  });
  it("keeps the original Context naming hint across follow-ups", () => {
    let state = applyTaskEvent(
      empty(),
      reply("Start"),
      "evt_one",
    );
    state = applyTaskEvent(
      state,
      reply("move it back"),
      "evt_two",
    );
    expect(state.sessionId).toBe("session_fixture");
    expect(state.title).toBe("Start");
  });
  it("does not replay an old turn-start event over a completed turn", () => {
    const started: HookEvent<"turn.started"> = {
      type: "turn.started", data: { turnId: "turn", follows: null, cause: { deliveryId: "delivery" } },
    };
    let state = applyTaskEvent(empty(), started, "evt_start");
    state = applyTaskEvent(state, { type: "turn.settled", data: { outcome: "completed", turnId: "turn" } }, "evt_end");
    expect(applyTaskEvent(state, started, "evt_start")).toBe(state);
    expect(state.status).toBe("idle");
  });
  it("survives human waits and resumes the same workflow", () => {
    let state = applyTaskEvent(
      empty(),
      { type: "interaction.opened", data: { interactionId: "otp", subject: { turnId: "turn" }, request: { kind: "question", prompt: "Enter OTP code" } } },
      "evt_wait",
    );
    expect(state).toMatchObject({
      status: "waiting_for_user",
      waitReason: "otp",
    });
    state = applyTaskEvent(state, { type: "turn.paused", data: { turnId: "turn", awaiting: [{ interactionId: "otp" }] } }, "evt_parked");
    expect(state).toMatchObject({
      status: "waiting_for_user",
      waitReason: "otp",
    });
    state = applyTaskEvent(state, { type: "interaction.settled", data: { interactionId: "otp", outcome: "accepted" } }, "evt_resume");
    expect(state).toMatchObject({ status: "running", activeStep: "resuming" });
  });
  it("continues a stored task without using or extending legacy bookkeeping", () => {
    const legacy = {
      ...initializeTask(empty(), "session_fixture", "2026-09-05T00:00:00.000Z"),
      title: "Existing task",
      messages: [{ id: "old-message", role: "user", text: "Existing task", at: "old" }],
      loadedSkillIds: ["fill-form"],
      artifacts: [],
      traceEventIds: ["old-trace"],
      browser: {
        lifecycle: "active" as const,
        sessionId: "session_12345678",
        contextId: "context_12345678",
        contextStatus: "saved" as const,
        proxyLocation: { country: "US" },
      },
    };
    let state = applyTaskEvent(
      legacy,
      reply("Continue"),
      "evt_followup",
    );
    state = updateTaskBrowser(state, {
      provider: "browserbase",
      status: "active",
      sessionId: "session_12345678",
      url: "https://example.com/account?token=secret",
      title: "Account",
    });
    expect(state).toMatchObject({
      sessionId: "session_fixture",
      title: "Existing task",
      browser: {
        lifecycle: "active",
        sessionId: "session_12345678",
        contextId: "context_12345678",
        contextStatus: "saved",
        proxyLocation: { country: "US" },
        url: "https://example.com/account",
      },
      messages: legacy.messages,
      loadedSkillIds: legacy.loadedSkillIds,
      traceEventIds: legacy.traceEventIds,
    });
  });
  it("keeps a reusable Context while it clears the old browser session", () => {
    const state = setTaskBrowserContext(
      {
        ...empty(),
        browser: {
          lifecycle: "active",
          sessionId: "session_12345678",
          contextId: "context_old_1234",
        },
      },
      "context_new_1234",
      "closed",
    );
    expect(state.browser).toMatchObject({
      contextId: "context_new_1234",
      lifecycle: "closed",
    });
    expect(state.browser.sessionId).toBeUndefined();
  });
  it("records a draft Context without closing the active browser", () => {
    const state = recordTaskBrowserContext(
      {
        ...empty(),
        browser: {
          lifecycle: "active",
          sessionId: "session_12345678",
        },
      },
      "context_draft_1234",
      "draft",
    );
    expect(state.browser).toMatchObject({
      contextId: "context_draft_1234",
      contextStatus: "draft",
      lifecycle: "active",
      sessionId: "session_12345678",
    });
  });
  it("cancels the task and closes its browser without clearing its Context", () => {
    const state = applyTaskEvent(
      {
        ...empty(),
        status: "running",
        browser: {
          lifecycle: "active",
          sessionId: "session_12345678",
          contextId: "context_12345678",
          url: "https://example.com/login",
        },
      },
      { type: "turn.settled", data: { outcome: "cancelled", turnId: "turn" } },
      "evt_cancel",
    );
    expect(state).toMatchObject({
      status: "canceled",
      browser: {
        lifecycle: "closed",
        contextId: "context_12345678",
        url: "https://example.com/login",
      },
    });
    expect(state.browser.sessionId).toBeUndefined();
  });
  it("redacts secrets and signed Browserbase URLs", () => {
    const text = safeText(
      "password=hunter2 otp:123456 https://www.browserbase.com/devtools-fullscreen/x.html?wss=secret",
    );
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("123456");
    expect(text).not.toContain("wss=secret");
  });
});
