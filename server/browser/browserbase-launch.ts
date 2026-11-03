import Browserbase from "@browserbasehq/sdk";
import { browserbase as stagehandBrowserbase, type StagehandBrowser } from "@browserbasehq/stagehand";

import { personalBrowserEnabled } from "../onepassword/browser-policy";
import { addTrace } from "./trace";
import type { BrowserProxyLocation, ConversationState } from "./types";

export interface HostedBrowserHost {
  readonly state: ConversationState;
  readonly contextId?: string;
  readonly proxyLocation?: BrowserProxyLocation;
  browserbase?: Browserbase;
  remoteSessionId?: string;
  attach(browser: StagehandBrowser): Promise<void>;
  discardAttached(): Promise<void>;
  discardLaunch(browser: StagehandBrowser | undefined): Promise<void>;
}

export function browserProvider(): "local" | "browserbase" {
  if (process.env.STAGEHAND_BROWSER === "local") return "local";
  if (process.env.STAGEHAND_BROWSER === "browserbase") return "browserbase";
  return process.env.BROWSERBASE_API_KEY ? "browserbase" : "local";
}

export function browserbaseLaunchOptions(
  apiKey: string,
  durableContextId?: string,
  proxyLocation?: BrowserProxyLocation,
) {
  const contextId = durableContextId ?? process.env.BROWSERBASE_CONTEXT_ID;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (personalBrowserEnabled() && contextId) throw new Error("Personal 1Password cannot use a reusable Context.");
  return {
    apiKey,
    ...(personalBrowserEnabled() ? { extensionId: process.env.BROWSERBASE_1PASSWORD_EXTENSION_ID!.trim() } : {}),
    ...(projectId ? { projectId } : {}),
    proxies: proxyLocation
      ? [
          {
            type: "browserbase" as const,
            geolocation: proxyLocation,
          },
        ]
      : true,
    keepAlive: true,
    browserSettings: {
      verified: true,
      logSession: false,
      recordSession: false,
      solveCaptchas: true,
      ...(contextId ? { context: { id: contextId, persist: true } } : {}),
    },
    userMetadata: {
      product: "bell",
      transport: "stagehand-v4-eve",
      networkLogging: "false",
      sessionRecording: "false",
      ...(personalBrowserEnabled()
        ? {
            onepasswordExtension: process.env.BROWSERBASE_1PASSWORD_EXTENSION_ID!.trim(),
            privateContext: "true",
          }
        : {}),
    },
  };
}

export async function launchHostedBrowser(host: HostedBrowserHost, apiKey: string): Promise<void> {
  const client = new Browserbase({ apiKey });
  host.browserbase = client;
  const persistedSessionId = host.state.browser.sessionId;

  if (persistedSessionId) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const prior = await client.sessions.retrieve(persistedSessionId);
        if (prior.userMetadata?.networkLogging !== "false" || prior.userMetadata?.sessionRecording !== "false")
          throw new Error("Session logging and recording settings cannot be verified.");
        const personalSession =
          prior.userMetadata?.privateContext === "true" || Boolean(prior.userMetadata?.onepasswordExtension);
        if (
          personalBrowserEnabled()
            ? prior.userMetadata?.onepasswordExtension !== process.env.BROWSERBASE_1PASSWORD_EXTENSION_ID ||
              prior.userMetadata?.privateContext !== "true"
            : personalSession
        )
          throw new Error("The personal 1Password browser settings cannot be verified.");
        const browser = await stagehandBrowserbase.connect({
          apiKey,
          sessionId: persistedSessionId,
        });
        await host.attach(browser);
        host.remoteSessionId = persistedSessionId;
        addTrace(
          host.state,
          "browser",
          "browser.reattach",
          "Reattached Stagehand v4 to the saved Browserbase session.",
          { sessionId: persistedSessionId, attempt },
        );
        return;
      } catch {
        await host.discardAttached();
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    host.remoteSessionId = persistedSessionId;
    await releaseHostedSession(host);
    addTrace(
      host.state,
      "system",
      "browser.replace",
      "The saved Browserbase session expired. Bell is starting a replacement with the same Context.",
      {
        contextPreserved: Boolean(host.contextId ?? process.env.BROWSERBASE_CONTEXT_ID),
      },
    );
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let launched: StagehandBrowser | undefined;
    try {
      launched = await stagehandBrowserbase.launch(
        browserbaseLaunchOptions(apiKey, host.contextId, host.proxyLocation),
      );
      await host.attach(launched);
      if (!launched.sessionId) throw new Error("Stagehand did not return a Browserbase session ID.");
      host.remoteSessionId = launched.sessionId;
      host.state.browser.sessionId = launched.sessionId;
      return;
    } catch (error) {
      lastError = error;
      await host.discardLaunch(launched);
      if (launched?.sessionId) {
        host.remoteSessionId = launched.sessionId;
        await releaseHostedSession(host);
      }
      if (attempt < 3) {
        addTrace(
          host.state,
          "system",
          "browser.start.retry",
          `The Browserbase connection failed. Bell will retry with a new verified, proxied session (${attempt}/3).`,
          { attempt, proxies: true, verified: true },
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function releaseHostedSession(host: HostedBrowserHost): Promise<void> {
  const sessionId = host.remoteSessionId ?? host.state.browser.sessionId;
  if (!sessionId) return;
  const client = host.browserbase ?? new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  host.browserbase = client;
  try {
    await client.sessions.update(sessionId, { status: "REQUEST_RELEASE" });
  } catch (error) {
    // An already removed session is released.
    if (!(error instanceof Browserbase.APIError) || error.status !== 404)
      throw new Error("The hosted browser could not be released. Retry cleanup.");
  }
  host.remoteSessionId = undefined;
  delete host.state.browser.sessionId;
}
