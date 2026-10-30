import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ launch: vi.fn(), attach: vi.fn(), release: vi.fn() }));
vi.mock("@browserbasehq/stagehand", () => ({
  browserbase: { launch: mocks.launch }, localBrowser: { launch: vi.fn() }, Stagehand: { create: mocks.attach },
}));
vi.mock("@browserbasehq/sdk", () => ({ default: class { sessions = { update: mocks.release }; } }));
import { BrowserSession } from "../../server/browser/browser-session";
import { runWithCancellation } from "../../agent/lib/cancellation";
import type { ConversationState } from "../../server/browser/types";

function fixture(id = "startup") {
  const state: ConversationState = { id, traces: [], browser: { provider: "not-started", status: "idle" } };
  const browser = { sessionId: id, closed: false, context: { pages: async () => [] }, close: vi.fn(async () => {}) };
  return { state, browser, session: new BrowserSession(state) };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BROWSERBASE_API_KEY", "synthetic-only");
  vi.stubEnv("STAGEHAND_BROWSER", "browserbase");
  vi.stubEnv("ONEPASSWORD_ENABLED", "false");
  vi.stubEnv("BROWSERBASE_CONTEXT_ID", "");
  mocks.attach.mockResolvedValue({ close: vi.fn(async () => {}) });
  mocks.release.mockResolvedValue({ status: "COMPLETED" });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("cancellation during browser startup", () => {
  it("does not launch after cancellation while a Context is being allocated", async () => {
    const { state, browser } = fixture(), controller = new AbortController();
    const context = Promise.withResolvers<{ id: string; status: "draft" }>();
    const ensureContext = vi.fn(() => context.promise), session = new BrowserSession(state, { ensureContext });
    mocks.launch.mockResolvedValue(browser);
    const pending = runWithCancellation(controller.signal, () => session.start(), () => session.close()).catch(error => error);
    await vi.waitFor(() => expect(ensureContext).toHaveBeenCalledOnce());
    controller.abort();
    context.resolve({ id: "draft-context", status: "draft" });
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(state.browser.sessionId).toBeUndefined();
  });

  it("releases a late launch before cancellation settles without initializing Stagehand", async () => {
    const { state, browser, session } = fixture(), controller = new AbortController();
    const launched = Promise.withResolvers<typeof browser>(), released = Promise.withResolvers<unknown>();
    mocks.launch.mockReturnValue(launched.promise);
    mocks.release.mockReturnValue(released.promise);
    let settled = false;
    const pending = runWithCancellation(controller.signal, () => session.start(), () => session.close()).catch(error => error).finally(() => { settled = true; });
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce());
    controller.abort();
    launched.resolve(browser);
    await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    released.resolve({ status: "COMPLETED" });
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith("startup", { status: "REQUEST_RELEASE" });
    expect(state.browser.sessionId).toBeUndefined();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("does not retry a failed launch after cancellation", async () => {
    vi.useFakeTimers();
    const { session } = fixture(), controller = new AbortController();
    const launched = Promise.withResolvers<never>();
    mocks.launch.mockReturnValue(launched.promise);
    const pending = runWithCancellation(controller.signal, () => session.start(), () => session.close()).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    launched.reject(new Error("Provider unavailable"));
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(mocks.launch).toHaveBeenCalledOnce();
  });

  it("keeps simultaneous conversations independent when one startup is canceled", async () => {
    const first = fixture("first"), second = fixture("second"), controller = new AbortController();
    const firstLaunch = Promise.withResolvers<typeof first.browser>();
    mocks.launch.mockReturnValueOnce(firstLaunch.promise).mockResolvedValueOnce(second.browser);
    const canceled = runWithCancellation(controller.signal, () => first.session.start(), () => first.session.close()).catch(error => error);
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce());
    await second.session.start();
    try {
      controller.abort();
      firstLaunch.resolve(first.browser);
      expect(await canceled).toMatchObject({ name: "AbortError" });
      expect(second.session.hasStarted()).toBe(true);
      expect(second.state.browser.sessionId).toBe("second");
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith("first", { status: "REQUEST_RELEASE" });
    } finally { await second.session.close(); }
    expect(mocks.release).toHaveBeenLastCalledWith("second", { status: "REQUEST_RELEASE" });
    expect(second.state.browser.sessionId).toBeUndefined();
  });
});
