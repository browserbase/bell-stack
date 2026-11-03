import type { CDPSubscription, StagehandBrowser } from "@browserbasehq/stagehand";

import {
  captchaTimeoutMs,
  parseBrowserbaseCaptchaEvent,
  safeCaptchaPage,
  type CaptchaSignal,
  type CaptchaTransition,
} from "../../lib/browser/captcha";
import type { ConversationState } from "./types";
import { addTrace } from "./trace";

export class CaptchaHandoffError extends Error {
  readonly code = "captcha_handoff";
  constructor(readonly reason: "errored" | "timed_out") {
    super(
      reason === "errored"
        ? "CAPTCHA solving errored. Continue in Live View, then resume this task."
        : "CAPTCHA solving timed out. Continue in Live View, then resume this task.",
    );
  }
}

export interface CaptchaObservation {
  snapshot: { formattedTree: string; xpathMap: Record<string, string> };
  url: string;
  title: string;
}

interface CaptchaGateHost {
  state: ConversationState;
  browser(): StagehandBrowser | undefined;
  onCaptchaTransition?: (transition: CaptchaTransition) => void;
  observePage(): Promise<CaptchaObservation>;
  applyPage(xpathMap: Record<string, string>, url: string, title: string): void;
}

/** Tracks Browserbase CAPTCHA console events and blocks page work until a solve finishes or hands off. */
export class CaptchaGate {
  readonly subscriptions = new Map<string, CDPSubscription>();
  private status: "idle" | "solving" | "solved" | "errored" | "timed_out";
  private startedAt?: string;
  private needsObservation = false;

  constructor(
    private readonly host: CaptchaGateHost,
    captcha?: { status: CaptchaGate["status"]; startedAt?: string },
  ) {
    this.status = captcha?.status ?? "idle";
    this.startedAt = captcha?.startedAt;
  }

  resumeAfterHumanInput(): void {
    if (this.status !== "errored" && this.status !== "timed_out") return;
    this.status = "idle";
    this.needsObservation = true;
  }

  async ensureSubscriptions(): Promise<void> {
    const browser = this.host.browser();
    if (!browser) return;
    for (const page of await browser.context.pages()) {
      if (this.subscriptions.has(page.pageId)) continue;
      const subscription = await page.on("console", (event) => {
        const signal = parseBrowserbaseCaptchaEvent(event);
        if (signal) this.recordSignal(signal);
      });
      this.subscriptions.set(page.pageId, subscription);
    }
  }

  async clearSubscriptions(): Promise<void> {
    const subscriptions = [...this.subscriptions.values()];
    this.subscriptions.clear();
    await Promise.all(
      subscriptions.map((subscription) => subscription.unsubscribe().catch(() => undefined)),
    );
  }

  async gate(): Promise<void> {
    await this.ensureSubscriptions();
    if (this.status === "solving") {
      const started = Date.parse(this.startedAt ?? new Date().toISOString());
      while (this.status === "solving" && Date.now() - started < captchaTimeoutMs())
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (this.status === "solving") {
        const at = new Date().toISOString();
        this.status = "timed_out";
        const page = safeCaptchaPage(this.host.state.browser.url);
        this.emit("timed_out", at);
        addTrace(
          this.host.state,
          "error",
          "captcha.timed_out",
          "CAPTCHA solving timed out; human input is required.",
          page,
        );
      }
    }
    if (this.status === "errored" || this.status === "timed_out")
      throw new CaptchaHandoffError(this.status);
    if (this.needsObservation) {
      this.needsObservation = false;
      const result = await this.host.observePage();
      this.host.applyPage(result.snapshot.xpathMap, result.url, result.title);
      addTrace(
        this.host.state,
        "browser",
        "captcha.observed",
        "Read the post-CAPTCHA page after the current gate.",
        {
          page: safeCaptchaPage(result.url),
          treePreview: result.snapshot.formattedTree.slice(0, 800),
        },
      );
    }
  }

  private emit(type: CaptchaTransition["type"], at: string): void {
    this.host.onCaptchaTransition?.({
      id: crypto.randomUUID(),
      type,
      at,
      page: safeCaptchaPage(this.host.state.browser.url),
    });
  }

  private recordSignal(signal: CaptchaSignal): void {
    const at = new Date().toISOString();
    const page = safeCaptchaPage(this.host.state.browser.url);
    if (signal === "started") {
      if (this.status === "solving") return;
      this.status = "solving";
      this.startedAt = at;
      this.emit("started", at);
      addTrace(this.host.state, "browser", "captcha.started", "Browserbase is solving a CAPTCHA.", page);
    } else if (signal === "finished" && this.status === "solving") {
      this.status = "solved";
      this.needsObservation = true;
      this.emit("finished", at);
      addTrace(this.host.state, "browser", "captcha.finished", "Browserbase solved the CAPTCHA.", page);
    } else if (signal === "errored" && this.status === "solving") {
      this.status = "errored";
      this.emit("errored", at);
      addTrace(
        this.host.state,
        "error",
        "captcha.errored",
        "Browserbase CAPTCHA solving errored; human input is required.",
        page,
      );
    }
  }
}
