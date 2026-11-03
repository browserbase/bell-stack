import { personalBrowserEnabled, requireReusableContexts } from "../onepassword/browser-policy";
import Browserbase from "@browserbasehq/sdk";
import {
  localBrowser,
  Stagehand,
  type CookieParam,
  type StagehandBrowser,
  type Page,
} from "@browserbasehq/stagehand";

import { safeCaptchaPage, type CaptchaTransition } from "../../lib/browser/captcha";
import {
  browserProvider,
  launchHostedBrowser,
  releaseHostedSession,
  type HostedBrowserHost,
} from "./browserbase-launch";
import { CaptchaGate, CaptchaHandoffError } from "./captcha-gate";
import { addTrace } from "./trace.js";
import type { BrowserProxyLocation, BrowserState, ConversationState, RunAction } from "./types.js";

export { CaptchaHandoffError } from "./captcha-gate";
export { browserProvider, browserbaseLaunchOptions } from "./browserbase-launch";

export interface BrowserRecoveryReport {
  visitedOrigins: string[];
  blockedOrigins: string[];
  liveSourceOrigins: string[];
}

const DISCOVERY_HOSTS = ["google.", "bing.com", "duckduckgo.com", "search.brave.com", "yahoo.com"];

export class BrowserSession {
  private stagehand?: Stagehand;
  private browser?: StagehandBrowser;
  private browserbase?: Browserbase;
  private remoteSessionId?: string;
  private startPromise?: Promise<void>;
  private closeRequested = false;
  private operationTail: Promise<void> = Promise.resolve();
  private xpathMap: Record<string, string> = {};
  private readonly visitedOrigins = new Set<string>();
  private readonly blockedOrigins = new Set<string>();
  private readonly liveSourceOrigins = new Set<string>();
  private readonly captchaGate: CaptchaGate;

  constructor(
    private readonly state: ConversationState,
    private readonly options: {
      contextId?: string;
      proxyLocation?: BrowserProxyLocation;
      ensureContext?: (
        currentContextId?: string,
      ) => Promise<{ id: string; status: "draft" | "saved" }>;
      captcha?: {
        status: "idle" | "solving" | "solved" | "errored" | "timed_out";
        startedAt?: string;
      };
      onCaptchaTransition?: (transition: CaptchaTransition) => void;
    } = {},
  ) {
    this.captchaGate = new CaptchaGate(
      {
        state,
        browser: () => this.browser,
        onCaptchaTransition: options.onCaptchaTransition,
        observePage: () => this.observeCaptchaPage(),
        applyPage: (xpathMap, url, title) => {
          this.xpathMap = xpathMap;
          this.updateBrowserState(url, title);
        },
      },
      options.captcha,
    );
  }

  resumeAfterHumanInput(): void {
    this.captchaGate.resumeAfterHumanInput();
  }

  async start(): Promise<void> {
    if (this.closeRequested)
      throw new DOMException("The browser session was closed.", "AbortError");
    if (this.stagehand && this.browser && !this.browser.closed) return;
    const startPromise = this.startPromise ?? this.startOnce();
    this.startPromise = startPromise;
    try {
      await startPromise;
      if (this.closeRequested)
        throw new DOMException("The browser session was closed.", "AbortError");
    } finally {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    }
  }

  private async startOnce(): Promise<void> {
    this.state.browser.status = "starting";
    const started = performance.now();
    const requested = browserProvider();
    let contextStatus: "draft" | "saved" | undefined;

    try {
      if (requested === "browserbase") {
        const apiKey = process.env.BROWSERBASE_API_KEY;
        if (!apiKey) throw new Error("BROWSERBASE_API_KEY is required for Browserbase mode.");
        if (
          personalBrowserEnabled() &&
          (this.options.contextId || process.env.BROWSERBASE_CONTEXT_ID)
        )
          throw new Error(
            "Start a new conversation without a reusable Context for personal 1Password.",
          );
        const currentContextId = this.options.contextId ?? process.env.BROWSERBASE_CONTEXT_ID;
        if (this.options.ensureContext && !personalBrowserEnabled()) {
          const context = await this.options.ensureContext(currentContextId);
          this.options.contextId = context.id;
          contextStatus = context.status;
        } else if (currentContextId) {
          this.options.contextId = currentContextId;
          contextStatus = "saved";
        }
        await launchHostedBrowser(this.hostedBrowser(), apiKey);
      } else {
        this.browser = await localBrowser.launch({
          headless: process.env.BELL_HEADLESS !== "false",
          viewport: { width: 1360, height: 900 },
        });
        await this.attachStagehand(this.browser);
      }

      this.state.browser = {
        provider: requested,
        status: "active",
        proxies: requested === "browserbase",
        verified: requested === "browserbase",
        contextId: this.options.contextId ?? process.env.BROWSERBASE_CONTEXT_ID,
        contextStatus,
        proxyLocation: requested === "browserbase" ? this.options.proxyLocation : undefined,
        sessionId: this.remoteSessionId,
      };
      await this.captchaGate.ensureSubscriptions();
      if (requested === "browserbase" && contextStatus) {
        addTrace(
          this.state,
          "context",
          contextStatus === "draft" ? "context.draft.attach" : "context.attach",
          contextStatus === "draft"
            ? "Attached a draft Context. Browser state is now captured for a later save."
            : "Attached the saved Browserbase Context.",
          { status: contextStatus, persist: true },
        );
      }
      addTrace(
        this.state,
        "browser",
        "browser.start",
        `Started one persistent ${requested} browser for this conversation.`,
        {
          provider: requested,
          reusedByEveryTool: true,
          proxies: requested === "browserbase",
          verified: requested === "browserbase",
          contextStatus,
          proxyLocation: this.options.proxyLocation,
          transport: "Stagehand v4 native Eve tools",
        },
        Math.round(performance.now() - started),
      );
    } catch (error) {
      this.state.browser.status = "error";
      addTrace(this.state, "error", "browser.start", errorMessage(error));
      throw error;
    }
  }

  /** Run a server-owned integration in the existing hosted browser under its operation lock.
   * Never return the connection URL or private request headers from the callback.
   */
  async withHostedPage<T>(
    signal: AbortSignal,
    operation: (page: Page, connectUrl: string, sessionId: string) => Promise<T>,
    privateResult = false,
  ): Promise<T> {
    signal.throwIfAborted();
    return this.withPage(async () => {
      signal.throwIfAborted();
      if (!this.browserbase || !this.remoteSessionId || !this.browser)
        throw new Error("This integration requires a hosted Browserbase session.");
      const page =
        (await this.browser.context.activePage()) ?? (await this.browser.context.newPage());
      const session = await this.browserbase.sessions.retrieve(this.remoteSessionId);
      if (!session.connectUrl) throw new Error("The hosted browser connection is unavailable.");
      const result = await operation(page, session.connectUrl, this.remoteSessionId);
      this.xpathMap = {};
      if (!privateResult) {
        this.updateBrowserState(await page.url(), await page.title());
        await this.gateCaptcha();
      }
      return result;
    }, signal);
  }

  async snapshot(): Promise<{
    tree: string;
    url: string;
    snapshotIdCount: number;
    pageStatus: "live" | "blocked";
    recovery: BrowserRecoveryReport;
  }> {
    return this.withPage(async () => {
      const started = performance.now();
      const result = await this.requireStagehand().experimentalBatch(async ({ page }) => {
        const snapshot = await page.snapshot({ includeIframes: true });
        return {
          snapshot,
          url: await page.url(),
          title: await page.title(),
        };
      });
      await this.gateCaptcha();
      this.xpathMap = result.snapshot.xpathMap;
      const url = result.url;
      this.updateBrowserState(result.url, result.title);
      const assessment = assessSnapshot(result.snapshot.formattedTree, url);
      const origin = originOf(url);
      if (origin) this.visitedOrigins.add(origin);
      if (assessment.blocked && origin) {
        const firstBlockOnOrigin = !this.blockedOrigins.has(origin);
        this.blockedOrigins.add(origin);
        this.liveSourceOrigins.delete(origin);
        if (firstBlockOnOrigin) {
          addTrace(
            this.state,
            "browser",
            "block.detected",
            `Detected an access block on ${origin}. The task must continue on another source.`,
            { origin, signal: assessment.signal },
          );
        }
      } else if (origin && isLiveSourceUrl(url)) {
        this.liveSourceOrigins.add(origin);
      }
      addTrace(
        this.state,
        "tool",
        "snapshot",
        `Read the current accessibility tree and found ${Object.keys(result.snapshot.xpathMap).length} targets.`,
        {
          url,
          pageStatus: assessment.blocked ? "blocked" : "live",
          treePreview: result.snapshot.formattedTree.slice(0, 1200),
        },
        Math.round(performance.now() - started),
      );
      return {
        tree: result.snapshot.formattedTree.slice(0, 14_000),
        url,
        snapshotIdCount: Object.keys(result.snapshot.xpathMap).length,
        pageStatus: assessment.blocked ? "blocked" : "live",
        recovery: this.recoveryReport(),
      };
    });
  }

  async run(actions: RunAction[]): Promise<{ completed: number; url: string }> {
    for (const item of actions) {
      if (item.action !== "goto") continue;
      const destination = new URL(item.url);
      if (
        !["https:", "http:"].includes(destination.protocol) ||
        destination.username ||
        destination.password
      )
        throw new Error("Browser navigation requires an HTTP(S) URL without embedded credentials.");
    }
    return this.withPage(async () => {
      const started = performance.now();
      const resolvedActions = actions.map((item) =>
        "target" in item && item.target
          ? { ...item, target: this.resolveTarget(item.target) }
          : item,
      );
      const result = await this.requireStagehand().experimentalBatch(
        async ({ page }, batchActions) => {
          for (const item of batchActions) {
            switch (item.action) {
              case "goto":
                await page.goto(item.url);
                await page.waitForLoadState("domcontentloaded", 15_000);
                break;
              case "click":
                await page.locator(item.target).click();
                break;
              case "fill":
                await page.locator(item.target).fill(item.value);
                break;
              case "type":
                await page.locator(item.target).type(item.value);
                break;
              case "press":
                if (item.target) await page.locator(item.target).click();
                await page.keyPress(item.key);
                break;
              case "select":
                await page.locator(item.target).selectOption(item.value);
                break;
              case "wait":
                await page.waitForTimeout(Math.min(item.milliseconds, 10_000));
                break;
            }
          }
          return { url: await page.url(), title: await page.title() };
        },
        resolvedActions,
        { timeout: 60_000 },
      );

      await this.gateCaptcha();
      this.xpathMap = {};
      this.updateBrowserState(result.url, result.title);
      const url = result.url;
      const origin = originOf(url);
      if (origin) this.visitedOrigins.add(origin);
      addTrace(
        this.state,
        "tool",
        "run",
        `Completed ${actions.length} exact browser action${actions.length === 1 ? "" : "s"}.`,
        { actions, url, snapshotIdsInvalidated: true },
        Math.round(performance.now() - started),
        formatRunCode(resolvedActions),
      );
      return { completed: actions.length, url };
    });
  }

  async secureLogin(input: {
    allowedHosts: string[];
    username: string;
    password: string;
    usernameTarget: string;
    passwordTarget: string;
    submitTarget: string;
    totp?: string;
    totpTarget?: string;
    otpSubmitTarget?: string;
    successTarget?: string;
    totpAfterSubmit?: boolean;
  }): Promise<{
    status: "complete" | "waiting_for_user" | "unverified";
    host: string;
    url: string;
  }> {
    const selectors = [
      input.usernameTarget,
      input.passwordTarget,
      input.submitTarget,
      input.totpTarget,
      input.otpSubmitTarget,
      input.successTarget,
    ];
    if (
      selectors.some(
        (selector) =>
          selector && (/^\s*(?:xpath=|\/|\()/i.test(selector) || selector.includes(">>")),
      )
    )
      throw new Error(
        "Secure login requires CSS selectors in the top-level page; frame selectors are not allowed.",
      );
    return this.withLock(async () => {
      try {
        await this.start();
        await this.gateCaptcha();
        const started = performance.now();
        const result = await this.requireStagehand().experimentalBatch(
          async ({ page }, values) => {
            const checkDestination = async () => {
              const destination = new URL(await page.url());
              if (
                destination.protocol !== "https:" ||
                destination.username ||
                destination.password ||
                !values.allowedHosts.includes(destination.hostname.toLowerCase())
              )
                throw new Error("Unsafe credential destination.");
            };
            await checkDestination();
            await page.locator(values.usernameTarget).fill(values.username);
            await checkDestination();
            await page.locator(values.passwordTarget).fill(values.password);
            if (values.totpTarget && values.totp && !values.totpAfterSubmit) {
              await checkDestination();
              await page.locator(values.totpTarget).fill(values.totp);
            }
            await checkDestination();
            await page.locator(values.submitTarget).click();
            await page.waitForTimeout(1_000);
            if (values.totpTarget && values.totp && values.totpAfterSubmit) {
              await checkDestination();
              await page.locator(values.totpTarget).fill(values.totp);
              if (values.otpSubmitTarget) {
                await checkDestination();
                await page.locator(values.otpSubmitTarget).click();
              }
              await page.waitForTimeout(1_000);
            }
            const url = await page.url(),
              title = await page.title();
            const success = values.successTarget
              ? (await page.locator(values.successTarget).count()) > 0
              : false;
            return { url, title, success };
          },
          input,
          { timeout: 45_000 },
        );
        await this.gateCaptcha();
        this.updateBrowserState(result.url, result.title);
        const host = new URL(result.url).hostname;
        const status =
          input.totpTarget && !input.totp
            ? "waiting_for_user"
            : result.success
              ? "complete"
              : "unverified";
        addTrace(
          this.state,
          "tool",
          "vault.login",
          status === "complete"
            ? `Verified login state on ${host}.`
            : status === "waiting_for_user"
              ? `Login on ${host} is waiting for a human challenge.`
              : `Filled the login on ${host}, but success is not verified yet.`,
          { host, status, secretValuesRedacted: true },
          Math.round(performance.now() - started),
        );
        return { status, host, url: result.url };
      } catch (error) {
        if (error instanceof CaptchaHandoffError) throw error;
        addTrace(
          this.state,
          "error",
          "vault.login",
          "The secure login attempt failed. Secret values were redacted.",
        );
        throw new Error(
          "Secure login failed. Inspect the current page and field selectors, then retry.",
        );
      }
    });
  }

  async screenshot(): Promise<{
    mediaType: "image/png";
    data: string;
    url: string;
  }> {
    return this.withPage(async () => {
      const started = performance.now();
      const result = await this.requireStagehand().experimentalBatch(async ({ page }) => ({
        data: await page.screenshot({ type: "png" }),
        url: await page.url(),
        title: await page.title(),
      }));
      await this.gateCaptcha();
      const buffer = toBuffer(result.data);
      this.state.screenshot = buffer;
      this.updateBrowserState(result.url, result.title);
      const url = result.url;
      addTrace(
        this.state,
        "tool",
        "screenshot",
        "Captured the visible browser page.",
        { url, bytes: buffer.byteLength },
        Math.round(performance.now() - started),
      );
      return { mediaType: "image/png", data: buffer.toString("base64"), url };
    });
  }

  async close(): Promise<void> {
    this.closeRequested = true;
    await this.startPromise?.catch(() => undefined);
    await this.captchaGate.clearSubscriptions();
    const stagehand = this.stagehand;
    const browser = this.browser;
    this.stagehand = undefined;
    this.browser = undefined;
    await stagehand?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await releaseHostedSession(this.hostedBrowser());
    if (this.state.browser.status !== "error") this.state.browser.status = "idle";
  }

  hasStarted(): boolean {
    return Boolean(this.stagehand && this.browser && !this.browser.closed);
  }

  async exportCookies(): Promise<CookieParam[]> {
    requireReusableContexts();
    if (!this.hasStarted()) return [];
    return this.browser!.context.cookies();
  }

  async importCookies(cookies: CookieParam[], url?: string): Promise<void> {
    return this.withOperation(async () => {
      if (cookies.length) await this.browser!.context.addCookies(cookies);
      if (url) {
        const page =
          (await this.browser!.context.activePage()) ?? (await this.browser!.context.newPage());
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        this.updateBrowserState(await page.url(), await page.title());
      }
      addTrace(
        this.state,
        "context",
        "context.capture",
        "Moved the current browser cookies into a reusable Browserbase Context.",
        {
          cookieCount: cookies.length,
          url: url ? safeCaptchaPage(url) : undefined,
        },
      );
    });
  }

  recoveryReport(): BrowserRecoveryReport {
    return {
      visitedOrigins: [...this.visitedOrigins],
      blockedOrigins: [...this.blockedOrigins],
      liveSourceOrigins: [...this.liveSourceOrigins],
    };
  }

  private resolveTarget(target: string): string {
    const raw = target.replace(/^\[/, "").replace(/\]$/, "");
    const xpath = this.xpathMap[target] ?? this.xpathMap[raw];
    if (!xpath && /^\[?\d+\]?$/.test(target)) {
      throw new Error("This snapshot ID is not in the latest snapshot. Call snapshot again.");
    }
    if (!xpath) return target;
    return xpath.startsWith("xpath=") ? xpath : `xpath=${xpath}`;
  }

  private requireStagehand(): Stagehand {
    if (!this.stagehand) throw new Error("The Stagehand client is not ready.");
    return this.stagehand;
  }

  private async withPage<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.withOperation(async () => {
      await this.gateCaptcha();
      return operation();
    }, signal);
  }

  private async withOperation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.withLock(async () => {
      signal?.throwIfAborted();
      await this.start();
      return operation();
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireOperation();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async acquireOperation(): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.operationTail;
    this.operationTail = previous.then(() => gate);
    await previous;
    if (this.closeRequested) {
      release();
      throw new DOMException("The browser session was closed.", "AbortError");
    }
    return release;
  }

  private async attachStagehand(browser: StagehandBrowser): Promise<void> {
    try {
      const stagehand = await Stagehand.create({
        browser,
        logging: { level: "off" },
      });
      await this.captchaGate.clearSubscriptions();
      this.browser = browser;
      this.stagehand = stagehand;
      await this.captchaGate.ensureSubscriptions();
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  private async gateCaptcha(): Promise<void> {
    await this.captchaGate.gate();
  }

  private observeCaptchaPage() {
    return this.requireStagehand().experimentalBatch(async ({ page }) => ({
      snapshot: await page.snapshot({ includeIframes: true }),
      url: await page.url(),
      title: await page.title(),
    }));
  }

  private hostedBrowser(): HostedBrowserHost {
    const readBrowserbase = () => this.browserbase;
    const writeBrowserbase = (client: Browserbase | undefined) => {
      this.browserbase = client;
    };
    const readRemoteSessionId = () => this.remoteSessionId;
    const writeRemoteSessionId = (sessionId: string | undefined) => {
      this.remoteSessionId = sessionId;
    };
    const readContextId = () => this.options.contextId;
    const readProxyLocation = () => this.options.proxyLocation;
    return {
      state: this.state,
      get contextId() {
        return readContextId();
      },
      get proxyLocation() {
        return readProxyLocation();
      },
      get browserbase() {
        return readBrowserbase();
      },
      set browserbase(client) {
        writeBrowserbase(client);
      },
      get remoteSessionId() {
        return readRemoteSessionId();
      },
      set remoteSessionId(sessionId) {
        writeRemoteSessionId(sessionId);
      },
      attach: (browser) => this.attachStagehand(browser),
      discard: (browser) => this.discard(browser),
    };
  }

  private async discard(browser = this.browser): Promise<void> {
    await this.stagehand?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    this.stagehand = undefined;
    this.browser = undefined;
  }

  private updateBrowserState(url: string, title: string): BrowserState {
    this.state.browser.url = url;
    this.state.browser.title = title || "Untitled";
    this.state.browser.status = "active";
    return this.state.browser;
  }
}

export function formatRunCode(actions: RunAction[]): string {
  return actions
    .flatMap((item) => {
      switch (item.action) {
        case "goto":
          return [
            `await page.goto(${JSON.stringify(safeActivityUrl(item.url))});`,
            'await page.waitForLoadState("domcontentloaded", 15_000);',
          ];
        case "click":
          return `await page.locator(${JSON.stringify(item.target)}).click();`;
        case "fill":
          return `await page.locator(${JSON.stringify(item.target)}).fill("[value hidden]");`;
        case "type":
          return `await page.locator(${JSON.stringify(item.target)}).type("[value hidden]");`;
        case "press":
          return [
            ...(item.target ? [`await page.locator(${JSON.stringify(item.target)}).click();`] : []),
            'await page.keyPress("[key hidden]");',
          ];
        case "select":
          return `await page.locator(${JSON.stringify(item.target)}).selectOption("[value hidden]");`;
        case "wait":
          return `await page.waitForTimeout(${Math.min(item.milliseconds, 10_000)});`;
      }
    })
    .join("\n");
}

function safeActivityUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys()) {
      if (/(?:auth|code|key|otp|password|secret|token)/i.test(key))
        url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assessSnapshot(tree: string, url: string): { blocked: boolean; signal?: string } {
  const text = `${url}\n${tree}`.toLowerCase();
  if (
    tree.includes("(No visible page text)") &&
    tree.includes("(No visible interactive targets)") &&
    /^https?:\/\//i.test(url)
  ) {
    return { blocked: true, signal: "empty page" };
  }
  const signals: Array<[string, RegExp]> = [
    ["access blocked", /you have been blocked|access (?:is )?denied|request blocked/],
    ["bot challenge", /verify (?:that )?you are human|unusual traffic|robot or human|captcha/],
    ["challenge page", /just a moment|checking your browser|enable javascript and cookies/],
    [
      "navigation error",
      /chrome-error:\/\/chromewebdata|privacy error|your connection is not private/,
    ],
    ["login wall", /\/login(?:\?|\s)|log in to .{1,80}(?:email|phone|continue)/],
    ["not found", /page not found|404 not found|the page you requested (?:was|could not be) found/],
  ];
  const match = signals.find(([, pattern]) => pattern.test(text));
  return match ? { blocked: true, signal: match[0] } : { blocked: false };
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function isLiveSourceUrl(url: string): boolean {
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (host.includes("google.")) return /^\/maps\/place\//.test(parsed.pathname);
  return !DISCOVERY_HOSTS.some((item) => host.includes(item));
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return Buffer.from(value);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return Buffer.from(record.data as number[]);
    const numericValues = Object.values(record);
    if (numericValues.length && numericValues.every((item) => typeof item === "number")) {
      return Buffer.from(numericValues as number[]);
    }
  }
  throw new Error("Stagehand returned a screenshot in an unsupported byte format.");
}
