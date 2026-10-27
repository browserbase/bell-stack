import { createServer, type Server } from "node:http";

import { chromium, type Browser } from "playwright-core";
import { describe, expect, it } from "vitest";

import { BrowserSession, browserProvider } from "../../server/browser/browser-session.js";
import type { ConversationState } from "../../server/browser/types.js";

const live = process.env.BELL_LIVE_MIDDLEWARE === "1";
const literal = '"); await page.locator("#literal").fill("injected"); // "quoted" \\ ${literal}';
const typed = 'typed "quotes" and \\ ${expression}';
const option = 'option "quoted"; throw new Error("injected")';
const fixtureHtml = `<!doctype html>
<title>Bell middleware fixture</title>
<h1>Browser middleware regression</h1>
<label for="literal">Literal value</label><input id="literal">
<label for="typed">Typed value</label><input id="typed">
<label for="choice">Selection</label><select id="choice"><option value="">Choose</option></select>
<button id="record" type="button">Record result</button>
<p id="result">Waiting for actions</p>
<script>
const expected = ${JSON.stringify({ literal, typed, option })};
const choice = document.querySelector("#choice");
const option = document.createElement("option");
option.value = expected.option;
option.textContent = "Quoted choice";
choice.appendChild(option);
let clicks = 0;
let keys = 0;
function report() {
  document.querySelector("#result").textContent = [
    "Literal preserved: " + (document.querySelector("#literal").value === expected.literal ? "yes" : "no"),
    "Typed preserved: " + (document.querySelector("#typed").value === expected.typed ? "yes" : "no"),
    "Option preserved: " + (choice.value === expected.option ? "yes" : "no"),
    "Clicks: " + clicks,
    "Keys: " + keys,
  ].join(". ");
}
document.querySelector("#record").addEventListener("click", () => { clicks++; report(); });
document.querySelector("#typed").addEventListener("keydown", event => {
  if (event.key === "Enter") { keys++; report(); }
  if (event.key === "Escape") history.replaceState(null, "", "#keyboard-navigation");
});
</script>`;

async function startLocalFixture(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(fixtureHtml);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port.");
  return { server, url: `http://127.0.0.1:${address.port}/middleware` };
}

describe("opt-in real middleware browser regression", () => {
  it.runIf(live)(
    "preserves all typed actions, snapshot IDs, images, and browser lifetime",
    async () => {
      const provider = browserProvider();
      if (provider === "browserbase" && !process.env.BROWSERBASE_API_KEY)
        throw new Error("BROWSERBASE_API_KEY is required for the hosted middleware regression.");
      const state: ConversationState = {
        id: "middleware-live-fixture",
        traces: [],
        browser: { provider: "not-started", status: "idle" },
      };
      const session = new BrowserSession(state);
      let fixtureBrowser: Browser | undefined;
      let fixtureServer: Server | undefined;
      let browser: { closed: boolean } | undefined;
      try {
        let fixtureUrl: string;
        if (provider === "browserbase") {
          fixtureUrl = "https://bell-fixture.invalid/middleware";
          fixtureBrowser = await session.withHostedPage(
            new AbortController().signal,
            (_page, connectUrl) => chromium.connectOverCDP(connectUrl),
          );
          await fixtureBrowser.contexts()[0].route(fixtureUrl, route => route.fulfill({
            contentType: "text/html", body: fixtureHtml,
          }));
        } else {
          const fixture = await startLocalFixture();
          fixtureServer = fixture.server;
          fixtureUrl = fixture.url;
        }

        expect(await session.run([{ action: "goto", url: fixtureUrl }])).toEqual({
          completed: 1, url: fixtureUrl,
        });
        browser = (session as unknown as { browser: { closed: boolean } }).browser;
        const sessionId = state.browser.sessionId;
        const snapshot = await session.snapshot();
        expect(snapshot.url).toBe(fixtureUrl);
        expect(snapshot.pageStatus).toBe("live");
        expect(snapshot.snapshotIdCount).toBeGreaterThanOrEqual(4);
        expect(snapshot.recovery.visitedOrigins).toContain(new URL(fixtureUrl).origin);
        expect(state.browser.title).toBe("Bell middleware fixture");
        const recordLine = snapshot.tree.split("\n").find(line => line.includes("Record result"));
        const recordId = recordLine?.match(/\[([0-9-]+)\]/)?.[1];
        expect(recordId, "The fixture button should have a snapshot ID.").toBeTruthy();
        if (!recordId) throw new Error("The fixture button has no snapshot ID.");

        const result = await session.run([
          { action: "fill", target: "#literal", value: literal },
          { action: "type", target: "#typed", value: typed },
          { action: "select", target: "#choice", value: option },
          { action: "click", target: `[${recordId}]` },
          { action: "press", target: "#typed", key: "Enter" },
          { action: "press", key: "Enter" },
          { action: "wait", milliseconds: 20 },
        ]);
        expect(result).toEqual({ completed: 7, url: fixtureUrl });
        await expect(session.run([{ action: "click", target: recordId }])).rejects.toThrow(
          "This snapshot ID is not in the latest snapshot. Call snapshot again.",
        );
        const after = await session.snapshot();
        for (const expected of [
          "Literal preserved: yes", "Typed preserved: yes", "Option preserved: yes", "Clicks: 1", "Keys: 2",
        ]) expect(after.tree).toContain(expected);
        expect(after.snapshotIdCount).toBeGreaterThanOrEqual(4);
        expect(after.url).toBe(fixtureUrl);

        const navigatedUrl = `${fixtureUrl}#keyboard-navigation`;
        expect(await session.run([{ action: "press", target: "#typed", key: "Escape" }])).toEqual({
          completed: 1, url: navigatedUrl,
        });
        expect(state.browser.url).toBe(navigatedUrl);
        expect((await session.snapshot()).url).toBe(navigatedUrl);

        const screenshot = await session.screenshot();
        const png = Buffer.from(screenshot.data, "base64");
        expect(screenshot.mediaType).toBe("image/png");
        expect(screenshot.url).toBe(navigatedUrl);
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(png.byteLength).toBeGreaterThan(100);
        expect(state.screenshot?.equals(png)).toBe(true);
        expect((session as unknown as { browser: unknown }).browser === browser).toBe(true);
        expect(state.browser.sessionId === sessionId).toBe(true);
        expect(state.traces.filter(event => event.name === "browser.start")).toHaveLength(1);
        expect(session.hasStarted()).toBe(true);
      } finally {
        try {
          await fixtureBrowser?.close();
        } finally {
          try {
            await session.close();
          } finally {
            await new Promise<void>((resolve, reject) => {
              if (!fixtureServer) return resolve();
              fixtureServer.close(error => error ? reject(error) : resolve());
            });
          }
        }
      }
      expect(browser?.closed).toBe(true);
      expect(session.hasStarted()).toBe(false);
      expect(state.browser.status).toBe("idle");
      await expect(session.start()).rejects.toMatchObject({ name: "AbortError" });
    },
    120_000,
  );
});
