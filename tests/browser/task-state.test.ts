import { describe, expect, it } from "vitest";

import {
  applyTaskEvent as applyEvent,
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
const positions = new Map<string, number>();
const event = (type: string, id: string, data: Record<string, unknown> = {}) => {
  const line = positions.get(id) ?? positions.size;
  positions.set(id, line);
  return { type, data, position: { line, index: 0 } };
};
const applyTaskEvent = (record: DurableTaskRecord, { position, ...fact }: ReturnType<typeof event>, sessionId: string) =>
  applyEvent(record, fact as Parameters<typeof applyEvent>[1], sessionId, position, "2026-09-05T00:00:00.000Z");

describe("durable Eve task state", () => {
  it("keeps a Context naming hint without copying Eve's conversation history", () => {
    let state = initializeTask(empty(), "session_fixture", "2026-09-05T00:00:00.000Z");
    state = applyTaskEvent(
      state,
      event("delivery.consumed", "evt_user", {
        parts: [{ kind: "text", text: "Research durable agents" }],
      }),
      "session_fixture",
    );
    state = applyTaskEvent(
      state,
      event("content.completed", "evt_assistant", { kind: "text", phase: "reply", value: "Finished." }),
      "session_fixture",
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
      event("delivery.consumed", "evt_one", { parts: [{ kind: "text", text: "Start" }] }),
      "session_fixture",
    );
    state = applyTaskEvent(
      state,
      event("delivery.consumed", "evt_two", { parts: [{ kind: "text", text: "move it back" }] }),
      "session_fixture",
    );
    expect(state.sessionId).toBe("session_fixture");
    expect(state.title).toBe("Start");
  });
  it("does not replay an old turn-start event over a completed turn", () => {
    const started = event("turn.started", "evt_start");
    let state = applyTaskEvent(empty(), started, "session_fixture");
    state = applyTaskEvent(state, event("turn.settled", "evt_end", { outcome: "completed" }), "session_fixture");
    expect(applyTaskEvent(state, started, "session_fixture")).toBe(state);
    expect(state.status).toBe("idle");
  });
  it("survives human waits and resumes the same workflow", () => {
    let state = applyTaskEvent(
      empty(),
      event("interaction.opened", "evt_wait", { request: { kind: "question", prompt: "Enter OTP code" } }),
      "session_fixture",
    );
    expect(state).toMatchObject({
      status: "waiting_for_user",
      waitReason: "otp",
    });
    state = applyTaskEvent(state, event("turn.paused", "evt_parked"), "session_fixture");
    expect(state).toMatchObject({
      status: "waiting_for_user",
      waitReason: "otp",
    });
    state = applyTaskEvent(state, event("interaction.settled", "evt_resume", { outcome: "accepted" }), "session_fixture");
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
      event("delivery.consumed", "evt_followup", { parts: [{ kind: "text", text: "Continue" }] }),
      "session_fixture",
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
      event("turn.settled", "evt_cancel", { outcome: "cancelled" }),
      "session_fixture",
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
