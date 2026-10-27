import { Stagehand, type StagehandBrowser } from "@browserbasehq/stagehand";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserSession } from "../../server/browser/browser-session";
import type { ConversationState } from "../../server/browser/types";
import { stagehandFixture } from "./stagehand-fixture";

const login = {
  allowedHosts: ["shop.example"],
  username: "synthetic-user",
  password: "synthetic-password",
  totp: "synthetic-otp",
  usernameTarget: "#username",
  passwordTarget: "#password",
  totpTarget: "#otp",
  submitTarget: "#submit",
  otpSubmitTarget: "#otp-submit",
  successTarget: "#success",
};

function fixture() {
  const state: ConversationState = {
    id: "browser-security-test",
    traces: [],
    browser: { provider: "not-started", status: "idle" },
  };
  const session = new BrowserSession(state);
  let url = "https://shop.example/login";
  const fill = vi.fn<(target: string, value: string) => Promise<void>>().mockResolvedValue();
  const click = vi.fn<(target: string) => Promise<void>>().mockResolvedValue();
  const type = vi.fn<(target: string, value: string) => Promise<void>>().mockResolvedValue();
  const select = vi.fn<(target: string, value: unknown) => Promise<void>>().mockResolvedValue();
  const taggedTargets = new Map<string, string>();
  const page = {
    pageId: "fixture-page",
    url: async () => url,
    title: async () => "Test shop",
    // The middleware evaluates locator queries, then tags the matched element
    // before dispatching native input. Preserve the original selector for assertions.
    evaluate: vi.fn(async (expression: string | (() => unknown)) => {
      if (typeof expression === "function") return url;
      const match = expression.match(/return await execute\((.+)\);/);
      if (!match) return { width: 1360, height: 900 };
      const query = JSON.parse(match[1]) as {
        operation: string;
        plan: Array<{ kind: string; value?: string }>;
        token?: string;
      };
      if (query.operation === "tag" && query.token) {
        const target = query.plan.find(step => step.kind === "selector")?.value;
        if (!target) throw new Error("The fixture requires a concrete selector.");
        taggedTargets.set('[data-stagehand-pw-compat="' + query.token + '"]', target);
      }
      return { count: 1, visible: true };
    }),
    goto: vi.fn(async (next: string) => { url = next; }),
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    keyPress: vi.fn<(key: string) => Promise<void>>().mockResolvedValue(),
    snapshot: vi.fn(async () => ({
      formattedTree: "[0-42] textbox: Email\n[7] button: Submit",
      xpathMap: {
        "0-42": "/html/body/input",
        "7": "xpath=/html/body/button",
        "0-99": "/html/body/div",
      },
    })),
    screenshot: vi.fn(async () => Uint8Array.from([137, 80, 78, 71])),
    on: vi.fn(async () => ({ unsubscribe: async () => {} })),
    locator: (target: string) => ({
      fill: (value: string) => fill(taggedTargets.get(target) ?? target, value),
      click: () => click(taggedTargets.get(target) ?? target),
      type: (value: string) => type(taggedTargets.get(target) ?? target, value),
      selectOption: (value: unknown) => select(taggedTargets.get(target) ?? target, value),
      count: async () => 1,
    }),
  };
  const { stagehand, browser, batch, context } = stagehandFixture(page);
  const start = vi.spyOn(session, "start").mockResolvedValue();
  vi.spyOn(session as unknown as { gateCaptcha(): Promise<void> }, "gateCaptcha")
    .mockResolvedValue();
  Object.assign(session, {
    stagehand,
    browser,
    browserbase: {},
  });
  return { session, state, start, batch, context, page, fill, click, type, select,
    setUrl: (next: string) => { url = next; } };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("vault login credential boundary", () => {
  it.each(["iframe >> #password", "xpath=/html/body/iframe/input", "/html/body/iframe/input", "(//iframe)/input"])(
    "rejects selectors that could send credentials into another frame: %s", async passwordTarget => {
      const { session, start, fill } = fixture();
      await expect(session.secureLogin({ ...login, passwordTarget })).rejects.toThrow("CSS selectors");
      expect(start).not.toHaveBeenCalled();
      expect(fill).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://shop.example/login",
    "https://other.example/login",
    "https://user:password@shop.example/login",
  ])("does not fill credentials at an unsafe destination: %s", async (url) => {
    const { session, setUrl, fill } = fixture();
    setUrl(url);
    await expect(session.secureLogin(login)).rejects.toThrow("Secure login failed");
    expect(fill).not.toHaveBeenCalled();
  });

  it("rechecks the destination before filling the password", async () => {
    const { session, setUrl, fill } = fixture();
    fill.mockImplementationOnce(async () => { setUrl("https://other.example/login"); });
    await expect(session.secureLogin(login)).rejects.toThrow("Secure login failed");
    expect(fill.mock.calls).toEqual([[login.usernameTarget, login.username]]);
  });

  it.each([false, true])("rechecks the destination before OTP, afterSubmit=%s", async (afterSubmit) => {
    const { session, setUrl, fill, click } = fixture();
    if (afterSubmit) {
      click.mockImplementationOnce(async () => { setUrl("https://other.example/otp"); });
    } else {
      fill.mockImplementation(async (target) => {
        if (target === login.passwordTarget) setUrl("http://shop.example/otp");
      });
    }
    await expect(session.secureLogin({ ...login, totpAfterSubmit: afterSubmit }))
      .rejects.toThrow("Secure login failed");
    expect(fill.mock.calls.some(([, value]) => value === login.totp)).toBe(false);
  });

  it("allows HTTPS login without exposing secrets in its result or trace", async () => {
    const { session, state, fill } = fixture();
    const result = await session.secureLogin(login);
    expect(result.status).toBe("complete");
    expect(fill).toHaveBeenCalledTimes(3);
    for (const value of [login.username, login.password, login.totp]) {
      expect(JSON.stringify({ state, result })).not.toContain(value);
    }
  });

  it("redacts failures and releases the operation lock for the next attempt", async () => {
    const { session, state, fill } = fixture();
    fill.mockRejectedValueOnce(new Error(login.password));
    await expect(session.secureLogin(login)).rejects.toThrow("Secure login failed");
    expect(JSON.stringify(state)).not.toContain(login.password);
    await expect(session.secureLogin(login)).resolves.toMatchObject({ status: "complete" });
  });
});

describe("browser navigation boundary", () => {
  it("fills the original values without retaining them in traces", async () => {
    const { session, state, fill } = fixture();
    const values = ["synthetic-credential-2b87e", "4242424242424242"];
    await session.run(values.map((value, i) => ({ action: "fill", target: `#field-${i}`, value })));
    for (const [i, value] of values.entries()) {
      expect(fill).toHaveBeenCalledWith(`#field-${i}`, value);
      expect(JSON.stringify(state.traces)).not.toContain(value);
    }
    expect(state.traces.find(trace => trace.name === "run")?.detail).toMatchObject({
      actions: values.map((_, i) => ({ action: "fill", target: `#field-${i}`, value: "[value hidden]" })),
    });
  });

  it("rejects operations queued behind a browser that has been closed", async () => {
    const { session, batch, fill } = fixture();
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    fill.mockImplementationOnce(async () => { await gate; });
    const first = session.run([{ action: "fill", target: "#first", value: "one" }]);
    await vi.waitFor(() => expect(batch).toHaveBeenCalledOnce());
    const second = session.run([{ action: "fill", target: "#second", value: "two" }]);
    const rejected = expect(second).rejects.toMatchObject({ name: "AbortError" });
    await session.close();
    resume();
    await first;
    await rejected;
    await expect(session.run([{ action: "wait", milliseconds: 1 }])).rejects.toMatchObject({ name: "AbortError" });
    expect(batch).toHaveBeenCalledOnce();
  });
  it.each([
    "file:///tmp/bell-synthetic-fixture",
    "javascript:alert(1)",
    "data:text/html,example",
    "https://user:password@shop.example/",
  ])("rejects unsafe navigation before starting a browser: %s", async (url) => {
    const { session, start, batch } = fixture();
    await expect(session.run([{ action: "goto", url }])).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it("validates the whole batch before executing an earlier action", async () => {
    const { session, batch } = fixture();
    await expect(session.run([
      { action: "goto", url: "https://shop.example/" },
      { action: "goto", url: "file:///tmp/bell-synthetic-fixture" },
    ])).rejects.toThrow();
    expect(batch).not.toHaveBeenCalled();
  });

  it("does not let a loopback URL override the configured browser provider", async () => {
    vi.stubEnv("STAGEHAND_BROWSER", "browserbase");
    const { session, start, page } = fixture();
    await session.run([{ action: "goto", url: "http://127.0.0.1:4318/" }]);
    expect(start).toHaveBeenCalledWith();
    expect(page.goto.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4318/");
  });
});


describe("middleware-backed browser tools", () => {
  it("preserves snapshot targets and runs mixed typed actions in one batch", async () => {
    const { session, batch, context, page, fill, click, type, select } = fixture();
    const snapshot = await session.snapshot();
    expect(snapshot).toMatchObject({
      tree: "[0-42] textbox: Email\n[7] button: Submit",
      url: "https://shop.example/login",
      // Count the complete map, including nodes omitted from the displayed tree.
      snapshotIdCount: 3,
    });
    expect(page.snapshot).toHaveBeenCalledWith({ includeIframes: true });

    const result = await session.run([
      { action: "fill", target: "[0-42]", value: "synthetic-email" },
      { action: "type", target: "#notes", value: "synthetic-notes" },
      { action: "press", target: "[7]", key: "Enter" },
      { action: "select", target: "#choice", value: "second" },
      { action: "wait", milliseconds: 5 },
    ]);
    expect(result).toEqual({ completed: 5, url: "https://shop.example/login" });
    expect(fill).toHaveBeenCalledWith("xpath=/html/body/input", "synthetic-email");
    expect(type).toHaveBeenCalledWith("#notes", "synthetic-notes");
    expect(click).toHaveBeenCalledWith("xpath=/html/body/button");
    expect(page.keyPress.mock.calls[0]?.[0]).toBe("Enter");
    expect(select).toHaveBeenCalledWith("#choice", "second");
    expect(page.waitForTimeout).toHaveBeenCalledWith(5);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(context.newPage).not.toHaveBeenCalled();

    for (const target of ["[7]", "[0-42]"]) {
      await expect(session.run([{ action: "click", target }]))
        .rejects.toThrow("Call snapshot again");
    }
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it("keeps quotes, backslashes and newlines as literal action inputs", async () => {
    const { session, fill, page, state } = fixture();
    const target = '#field"); throw new Error("injected selector"); //';
    const value = '"; throw new Error("injected value"); //\\\nsecond line';
    await expect(session.run([{ action: "fill", target, value }]))
      .resolves.toMatchObject({ completed: 1 });
    expect(fill).toHaveBeenCalledExactlyOnceWith(target, value);
    expect(page.goto).not.toHaveBeenCalled();
    expect(JSON.stringify(state.traces)).not.toContain("injected value");
  });

  it("preserves navigation waits and untargeted keyboard input", async () => {
    const { session, page, batch } = fixture();
    await session.run([
      { action: "goto", url: "https://shop.example/account" },
      { action: "press", key: "Tab" },
    ]);
    expect(page.goto.mock.calls[0]?.[0]).toBe("https://shop.example/account");
    expect(page.waitForLoadState).toHaveBeenCalledWith("domcontentloaded", 15_000);
    expect(page.keyPress.mock.calls[0]?.[0]).toBe("Tab");
    expect(batch).toHaveBeenCalledOnce();
  });

  it("reports live metadata when keyboard input navigates the page", async () => {
    const { session, page, state, setUrl } = fixture();
    const destination = "https://shop.example/search?q=fixture";
    page.keyPress.mockImplementationOnce(async () => { setUrl(destination); });

    await expect(session.run([{ action: "press", key: "Enter" }]))
      .resolves.toEqual({ completed: 1, url: destination });
    expect(state.browser.url).toBe(destination);
  });

  it("reports the current URL when navigation finishes during snapshot capture", async () => {
    const { session, page, state, setUrl } = fixture();
    const capture = page.snapshot.getMockImplementation()!;
    const destination = "https://shop.example/account";
    page.snapshot.mockImplementationOnce(async () => {
      setUrl(destination);
      return capture();
    });

    await expect(session.snapshot()).resolves.toMatchObject({ url: destination });
    expect(state.browser.url).toBe(destination);
  });

  it("never replays an action batch after a partial failure", async () => {
    const { session, fill, click, batch } = fixture();
    fill.mockRejectedValueOnce(new Error("Synthetic fill failure"));
    await expect(session.run([
      { action: "click", target: "#first" },
      { action: "fill", target: "#second", value: "fixture" },
      { action: "click", target: "#third" },
    ])).rejects.toThrow("Synthetic fill failure");
    expect(click.mock.calls).toEqual([["#first"]]);
    expect(batch).toHaveBeenCalledOnce();
    await expect(session.run([{ action: "click", target: "#next" }]))
      .resolves.toMatchObject({ completed: 1 });
    expect(click.mock.calls).toEqual([["#first"], ["#next"]]);
  });

  it("rebinds middleware to the new Stagehand client after reattachment", async () => {
    const current = fixture();
    const replacement = fixture();
    const native = stagehandFixture(replacement.page);
    await current.session.snapshot();
    vi.spyOn(Stagehand, "create").mockResolvedValue(native.stagehand);

    await (current.session as unknown as {
      attachStagehand(browser: StagehandBrowser): Promise<void>;
    }).attachStagehand(native.browser as unknown as StagehandBrowser);

    await current.session.snapshot();
    expect(current.page.snapshot).toHaveBeenCalledOnce();
    expect(replacement.page.snapshot).toHaveBeenCalledOnce();
    expect(native.batch).toHaveBeenCalledOnce();
    expect(native.context.newPage).not.toHaveBeenCalled();
  });

  it("preserves PNG bytes for the viewer and model image output", async () => {
    const { session, state, page, context } = fixture();
    const image = await session.screenshot();
    expect(image).toEqual({
      mediaType: "image/png",
      data: Buffer.from([137, 80, 78, 71]).toString("base64"),
      url: "https://shop.example/login",
    });
    expect(state.screenshot).toEqual(Buffer.from(image.data, "base64"));
    expect(page.screenshot).toHaveBeenCalledWith({ type: "png" });
    expect(state.browser).toMatchObject({
      url: image.url,
      title: "Test shop",
      status: "active",
    });
    expect(context.newPage).not.toHaveBeenCalled();
  });
});
