import { readFileSync, writeFileSync } from "node:fs";

import { chromium, type Browser } from "playwright-core";
import { Extensions } from "@browserbasehq/sdk/resources/extensions";
import { browserbase, Stagehand, type StagehandBrowser } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { BrowserSession } from "../../server/browser/browser-session.js";
import type { ConversationState } from "../../server/browser/types.js";

const live = process.env.BELL_LIVE_RESTART === "1" && Boolean(process.env.BROWSERBASE_API_KEY),
  phase = process.env.BELL_RESTART_PHASE,
  stateFile = process.env.BELL_RESTART_STATE_FILE;

describe("opt-in Browserbase restart recovery", () => {
  it.runIf(live && phase === "prepare")(
    "leaves a live session for a new process",
    async () => {
      if (!stateFile) throw new Error("The restart state file is required.");
      const state: ConversationState = {
          id: "restart-otp-fixture",
          traces: [],
          browser: { provider: "not-started", status: "idle" },
        },
        session = new BrowserSession(state),
        fixture = "https://bell-fixture.invalid/restart-otp",
        page = `
          <title>Restart OTP fixture</title>
          <form id="login">
            <input id="username" />
            <input id="password" type="password" />
            <input id="otp" />
            <button id="submit" type="button" onclick="
              if (document.querySelector('#otp').value === '123456') {
                document.querySelector('#result').textContent = 'OTP accepted after restart';
              }
            ">Continue</button>
          </form>
          <p id="result">Waiting for OTP</p>
        `;
      let fixtureBrowser: Browser | undefined;
      let parked = false;
      const uploads = vi.spyOn(Extensions.prototype, "create");
      const instances = vi.spyOn(Stagehand, "create");
      try {
        fixtureBrowser = await session.withHostedPage(new AbortController().signal, (_page, connectUrl) =>
          chromium.connectOverCDP(connectUrl));
        // Keep the fixture in the hosted page so the second process can resume it.
        await fixtureBrowser.contexts()[0].route(fixture, route => route.fulfill({
          contentType: "text/html", body: page,
        }));
        await session.run([
          { action: "goto", url: fixture },
          { action: "fill", target: "#username", value: "public-test-user" },
          { action: "fill", target: "#password", value: "public-test-password" },
        ]);
        expect((await session.snapshot()).tree).toContain("Waiting for OTP");
        const instance = await instances.mock.results[0].value;
        await expect(Stagehand.create({ browser: instance.browser, replaceExistingInstance: true })).rejects.toThrow("requires an existing browser connection");
        if (!state.browser.sessionId) throw new Error("Browserbase did not return a session ID.");
        writeFileSync(
          stateFile,
          JSON.stringify({
            id: state.id,
            traces: [],
            extensionIds: await Promise.all(uploads.mock.results.map(async result => (await result.value).id)),
            browser: {
              provider: "browserbase",
              status: "idle",
              sessionId: state.browser.sessionId,
              url: state.browser.url,
              title: state.browser.title,
            },
          }),
          { mode: 0o600 },
        );
        parked = true;
        console.log(JSON.stringify({ status: "parked", remoteSessionKeptAlive: true }));
      } finally {
        try {
          // Disconnect this CDP client; leave the hosted session alive for the resume phase.
          await fixtureBrowser?.close();
        } finally {
          uploads.mockRestore();
          instances.mockRestore();
          if (!parked) await session.close();
        }
      }
    },
    60_000,
  );

  it.runIf(live && phase === "resume")(
    "reconnects and enters a code",
    async () => {
      if (!stateFile) throw new Error("The restart state file is required.");
      const saved = JSON.parse(readFileSync(stateFile, "utf8")) as ConversationState,
        session = new BrowserSession(saved);
      const originalSessionId = saved.browser.sessionId;
      let unchangedConnection: StagehandBrowser | undefined;
      try {
        unchangedConnection = await browserbase.connect({ apiKey: process.env.BROWSERBASE_API_KEY!, sessionId: originalSessionId! });
        await expect(Stagehand.create({ browser: unchangedConnection, logging: { level: "off" } })).rejects.toThrow("already initialized");
        await session.start();
        expect(saved.browser.sessionId, "Restart must reconnect to the original hosted session").toBe(originalSessionId);
        expect((await session.snapshot()).tree, "The prepared page must survive the worker restart").toContain("Waiting for OTP");
        await session.run([
          { action: "fill", target: "#otp", value: "123456" },
          { action: "click", target: "#submit" },
        ]);
        const page = await session.snapshot();
        expect(page.tree).toContain("OTP accepted after restart");
        expect(saved.traces.some((event) => event.name === "browser.reattach")).toBe(true);
        console.log(
          JSON.stringify({
            status: "pass",
            reattachedSameSession: true,
            otpAcceptedAfterRestart: true,
          }),
        );
      } finally {
        try { await session.close(); } finally { await unchangedConnection?.close(); }
      }
    },
    60_000,
  );
});
