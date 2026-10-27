import { personalBrowserEnabled, withPersonalBrowserLock } from "../../server/onepassword/browser-policy";
import {
  createAgentContext,
  createIsolatedAgentContext,
  ensureAgentContext,
  isDraftAgentContext,
  listAgentContexts,
  promoteAgentContext,
  releaseIsolatedContext,
  selectAgentContext,
} from "../../server/browser/agent-contexts.js";
import { BrowserSession, CaptchaHandoffError } from "../../server/browser/browser-session.js";
import { getContextMetadataStore, isOwnedGroupContext } from "../../server/browser/context-metadata-store.js";
import { withBrowserPrivacyLock } from "../../server/browser/privacy-lock";
import type { BrowserProxyLocation, ConversationState, TraceEvent } from "../../server/browser/types.js";
import type { ToolContext } from "eve/tools";
import { runWithCancellation } from "./cancellation";
import {
  browserScope,
  cancellationClosesBrowser,
  resolveGroupBinding,
  type BrowserScope,
  type GroupBrowserBinding,
} from "./group-binding";
import {
  applyCaptchaTransition,
  closeTaskBrowser,
  reconcileCaptchaAfterRestart,
  recordTaskBrowserContext,
  setTaskBrowserContext,
  taskState,
  updateTaskBrowser,
  type DurableCaptchaRecord,
} from "./task-state";

type BrowserOperation<T> = (browser: BrowserSession) => Promise<T>;

export { browserScope, type BrowserScope } from "./group-binding";

/**
 * A session id or the tool context itself. Passing `ctx` is the preferred
 * form: the scope is derived from the verified messaging principal so group
 * browser tasks stay bound to their initiating member.
 */
type BrowserTarget = string | Pick<ToolContext, "session">;

function resolveBrowserTarget(
  target: BrowserTarget,
  scope?: BrowserScope,
): { sessionId: string; scope?: BrowserScope } {
  return typeof target === "string"
    ? { sessionId: target, scope }
    : { sessionId: target.session.id, scope: scope ?? browserScope(target) };
}

interface BrowserRuntime {
  browser: BrowserSession;
  state: ConversationState;
  idleTimer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
  /** Verified principal that owns this isolated group runtime, when bound. */
  isolatedOwnerId?: string;
}

export interface BrowserToolOutput<T> {
  result: T;
  workbench: {
    browser: ConversationState["browser"];
    traces: TraceEvent[];
    screenshotDataUrl?: string;
    captcha?: DurableCaptchaRecord;
  };
}

const runtimes = new Map<string, BrowserRuntime>();
const runtimeBuilds = new Map<string, Promise<unknown>>();
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

/** Group binding/staleness rules live in agent/lib/group-binding.ts. */
const hasRuntime = (sessionId: string): boolean => runtimes.has(sessionId);

/* ------------------------------------------------------------------ */
/* Launch serialization + isolated environment                          */
/* ------------------------------------------------------------------ */

/**
 * Browserbase launches read shared-Context and personal-extension fallbacks
 * straight from process.env. Group sessions must never see either, so their
 * launches run under a mask. Every launch is serialized so a masked group
 * launch cannot leak into (or be interrupted by) another session's start.
 */
const ISOLATED_BROWSER_ENV = ["BROWSERBASE_CONTEXT_ID", "BROWSERBASE_1PASSWORD_EXTENSION_ID"] as const;
let browserLaunchQueue: Promise<unknown> = Promise.resolve();

function withMaskedBrowserEnv<T>(operation: () => T): T {
  const saved = ISOLATED_BROWSER_ENV.map((name) => [name, process.env[name]] as const);
  for (const [name] of saved) delete process.env[name];
  try {
    return operation();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function launchIsolatedBrowser(start: () => Promise<void>): Promise<void> {
  const launch = browserLaunchQueue.then(() => withMaskedBrowserEnv(start));
  browserLaunchQueue = launch.then(
    () => undefined,
    () => undefined,
  );
  return launch;
}

/** Synchronous mask for task-state projection paths that read env fallbacks. */
function withIsolatedEnv<T>(runtime: BrowserRuntime, operation: () => T): T {
  return runtime.isolatedOwnerId === undefined ? operation() : withMaskedBrowserEnv(operation);
}

function createInitialState(
  sessionId: string,
  durable: ReturnType<typeof taskState.get>,
  contextId = durable.browser.contextId,
): ConversationState {
  return {
    id: sessionId,
    traces: [],
    browser: {
      provider: durable.browser.sessionId ? "browserbase" : "not-started",
      status: "idle",
      contextId,
      contextStatus: durable.browser.contextStatus,
      proxyLocation: durable.browser.proxyLocation,
      sessionId: durable.browser.sessionId,
      url: durable.browser.url,
      title: durable.browser.title,
    },
  };
}

function buildRuntime(sessionId: string, state: ConversationState): BrowserRuntime {
  return {
    state,
    browser: createRuntimeBrowser(
      sessionId,
      state,
      state.browser.contextId,
      state.browser.proxyLocation,
    ),
  };
}

function buildIsolatedRuntime(
  sessionId: string,
  state: ConversationState,
  ownerId: string,
): BrowserRuntime {
  const browser = new BrowserSession(state, {
    // Never inherit a shared/saved Context. A persisted Context id is honored
    // only after it is confirmed as this session's own isolated draft — that
    // check runs in ensureRuntime below.
    contextId: state.browser.contextId,
    proxyLocation: state.browser.proxyLocation,
    captcha: taskState.get().captcha,
    ensureContext: async (currentContextId) => {
      if (currentContextId) {
        // The isolated Context id was restored or created by this runtime;
        // reuse it for the life of this task. Never consult env fallbacks.
        return { id: currentContextId, status: "draft" as const };
      }
      const context = await createIsolatedAgentContext(sessionId, ownerId);
      state.browser.contextId = context.id;
      state.browser.contextStatus = "draft";
      taskState.update((current) => recordTaskBrowserContext(current, context.id, "draft"));
      return { id: context.id, status: "draft" as const };
    },
  });
  const start = browser.start.bind(browser);
  browser.start = () => launchIsolatedBrowser(start);
  return {
    state,
    isolatedOwnerId: ownerId,
    browser,
  };
}

/**
 * Creates (or returns) the session runtime. Group sessions get an isolated
 * runtime: fresh per-task Context, no shared-Context or extension env
 * fallbacks, no saved-Context inheritance. A runtime created before the group
 * binding was known is closed and rebuilt so no shared state can leak in.
 */
async function ensureRuntime(sessionId: string, group?: GroupBrowserBinding): Promise<BrowserRuntime> {
  const current = runtimes.get(sessionId);
  if (current && (!group || current.isolatedOwnerId)) return current;
  let build = runtimeBuilds.get(sessionId);
  const next = (build ?? Promise.resolve()).then(async () => {
    const existing = runtimes.get(sessionId);
    if (existing && (!group || existing.isolatedOwnerId)) return existing;
    if (existing) {
      runtimes.delete(sessionId);
      await existing.browser.close().catch(() => undefined);
    }

    const saved = taskState.get();
    const durable = reconcileCaptchaAfterRestart(saved, new Date().toISOString());
    if (durable !== saved) taskState.update(() => durable);
    let contextId = durable.browser.contextId;
    if (group) {
      // Restore a Context only when the metadata row proves it is this
      // session's own isolated group draft — never a shared or personal one.
      const row = contextId ? (await getContextMetadataStore().read()).contexts[contextId] : undefined;
      if (!isOwnedGroupContext(row, sessionId)) contextId = undefined;
    }
    const state = createInitialState(sessionId, durable, contextId);
    const runtime = group
      ? buildIsolatedRuntime(sessionId, state, group.ownerId)
      : buildRuntime(sessionId, state);
    runtimes.set(sessionId, runtime);
    return runtime;
  });
  build = next;
  runtimeBuilds.set(sessionId, build);
  try {
    return await next;
  } finally {
    if (runtimeBuilds.get(sessionId) === build) runtimeBuilds.delete(sessionId);
  }
}

/** Legacy synchronous path for callers that cannot carry a scope (cleanup). */
function getRuntime(sessionId: string): BrowserRuntime {
  const current = runtimes.get(sessionId);
  if (current) return current;

  const saved = taskState.get();
  const durable = reconcileCaptchaAfterRestart(saved, new Date().toISOString());
  if (durable !== saved) taskState.update(() => durable);
  const runtime = buildRuntime(sessionId, createInitialState(sessionId, durable));
  runtimes.set(sessionId, runtime);
  return runtime;
}

export async function runBrowserOperation<T>(
  target: BrowserTarget,
  operation: BrowserOperation<T>,
  includeScreenshot = false,
  scope?: BrowserScope,
): Promise<BrowserToolOutput<T>> {
  const resolved = resolveBrowserTarget(target, scope);
  const group = await resolveGroupBinding(resolved.sessionId, resolved.scope, hasRuntime);
  if (group)
    // Group tasks skip the personal-1Password and payment-privacy locks: every
    // credential path is denied upstream, and no shared lock state may attach.
    return runBrowserOperationUnlocked(resolved.sessionId, operation, includeScreenshot, group);
  return withBrowserPrivacyLock(resolved.sessionId,
    () => withPersonalBrowserLock(resolved.sessionId, () => runBrowserOperationUnlocked(resolved.sessionId, operation, includeScreenshot)),
    undefined, Boolean(taskState.get().browser.sessionId));
}

async function runBrowserOperationUnlocked<T>(sessionId: string, operation: BrowserOperation<T>, includeScreenshot: boolean, group?: GroupBrowserBinding): Promise<BrowserToolOutput<T>> {
  const runtime = await ensureRuntime(sessionId, group);
  scheduleIdleClose(sessionId, runtime);
  const traceStart = runtime.state.traces.length;
  let settled = false;
  const pending = operation(runtime.browser).finally(() => {
    settled = true;
  });
  while (!settled) {
    await Promise.race([
      pending.then(
        () => undefined,
        () => undefined,
      ),
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);
    commitCaptchaQueue(runtime);
  }
  let result: T;
  try {
    result = await pending;
  } catch (error) {
    if (!(error instanceof CaptchaHandoffError)) throw error;
    result = {
      status: "waiting_for_user",
      reason: "captcha",
      action: "Complete the challenge in the existing Live View, then resume this task.",
    } as T;
  }
  commitCaptchaQueue(runtime);
  scheduleIdleClose(sessionId, runtime);
  return {
    result,
    workbench: {
      browser: { ...runtime.state.browser },
      traces: runtime.state.traces.slice(traceStart),
      captcha: taskState.get().captcha,
      ...(includeScreenshot && runtime.state.screenshot
        ? {
            screenshotDataUrl: `data:image/png;base64,${runtime.state.screenshot.toString("base64")}`,
          }
        : {}),
    },
  };
}

function commitCaptchaQueue(runtime: BrowserRuntime): void {
  const transitions = runtime.browser.drainCaptchaTransitions();
  if (!transitions.length) return;
  withIsolatedEnv(runtime, () =>
    taskState.update((current) => {
      let next = current;
      for (const transition of transitions) next = applyCaptchaTransition(next, transition);
      return updateTaskBrowser(next, runtime.state.browser);
    }),
  );
}

export async function saveBrowserRuntime(sessionId: string): Promise<void> {
  const runtime = runtimes.get(sessionId);
  if (runtime)
    withIsolatedEnv(runtime, () =>
      taskState.update((current) => updateTaskBrowser(current, runtime.state.browser)),
    );
}

/** Deletes this session's isolated group Context, if one was attached. */
async function releaseGroupContext(sessionId: string, runtime?: BrowserRuntime): Promise<void> {
  const bound =
    runtime?.isolatedOwnerId !== undefined
    || (await getContextMetadataStore().groupBrowserTask(sessionId)) !== undefined;
  if (!bound) return;
  const contextId = runtime?.state.browser.contextId ?? taskState.get().browser.contextId;
  if (contextId) {
    try {
      await releaseIsolatedContext(contextId, sessionId);
    } catch (error) {
      // Keep the metadata row: the draft TTL sweep or a retry will remove it.
      console.error(JSON.stringify({ event: "browser.group.context_release_failed", error: String(error) }));
    }
  }
  // The task is over: a later task must bind a verified owner of its own.
  await getContextMetadataStore().unbindGroupBrowserTask(sessionId);
}

export async function closeBrowserRuntime(sessionId: string): Promise<void> {
  // Terminal cleanup can run in a new worker after the last turn. Recover the
  // persisted browser ID without opening another browser or creating a Context.
  const runtime =
    runtimes.get(sessionId) ??
    (taskState.get().browser.sessionId ? getRuntime(sessionId) : undefined);
  if (runtime) {
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    runtime.closing ??= runtime.browser.close().then(() => {
      runtimes.delete(sessionId);
      withIsolatedEnv(runtime, () =>
        taskState.update((current) =>
          closeTaskBrowser(updateTaskBrowser(current, runtime.state.browser)),
        ),
      );
    }).finally(() => { runtime.closing = undefined; });
    await runtime.closing;
    // A group Context is fresh per task and must never outlive the browser.
    await releaseGroupContext(sessionId, runtime);
    return;
  }
  taskState.update(closeTaskBrowser);
  await releaseGroupContext(sessionId, undefined);
}

export async function runCancelableBrowserWork<T>(
  target: BrowserTarget,
  signal: AbortSignal,
  operation: () => Promise<T>,
  scope?: BrowserScope,
): Promise<T> {
  const resolved = resolveBrowserTarget(target, scope);
  return runWithCancellation(signal, operation, async () => {
    // In a group-bound session only the bound owner may cancel the task's
    // browser; another member's cancellation must not release it.
    if (await cancellationClosesBrowser(resolved.sessionId, resolved.scope))
      await closeBrowserRuntime(resolved.sessionId);
  });
}

export function hasBrowserRuntime(sessionId: string): boolean {
  return runtimes.has(sessionId);
}

export function resumeBrowserAfterHumanInput(sessionId: string): void {
  runtimes.get(sessionId)?.browser.resumeAfterHumanInput();
}

/** Reusable Context storage is shared — group sessions may never reach it. */
async function assertSharedContextsAllowed(sessionId: string, scope?: BrowserScope): Promise<void> {
  if (await resolveGroupBinding(sessionId, scope, hasRuntime))
    throw new Error("Reusable browser Contexts are not available in a group conversation.");
}

export async function createBrowserContext(
  target: BrowserTarget,
  name: string,
  signal?: AbortSignal,
  scope?: BrowserScope,
): Promise<{
  id: string;
  name: string;
  selected: true;
  migratedCookieCount: number;
}> {
  const { sessionId, scope: resolvedScope } = resolveBrowserTarget(target, scope);
  await assertSharedContextsAllowed(sessionId, resolvedScope);
  signal?.throwIfAborted();
  const durable = taskState.get();
  const runtime =
    runtimes.get(sessionId) ?? (durable.browser.sessionId ? getRuntime(sessionId) : undefined);
  const currentContextId = durable.browser.contextId;
  if (currentContextId && (await isDraftAgentContext(currentContextId, sessionId))) {
    signal?.throwIfAborted();
    const context = await promoteAgentContext(currentContextId, name);
    signal?.throwIfAborted();
    taskState.update((current) => recordTaskBrowserContext(current, context.id, "saved"));
    if (runtime) runtime.state.browser.contextStatus = "saved";
    return {
      id: context.id,
      name: context.name,
      selected: true,
      migratedCookieCount: 0,
    };
  }
  const hasExistingBrowser = Boolean(
    runtime?.browser.hasStarted() || runtime?.state.browser.sessionId,
  );
  signal?.throwIfAborted();
  if (hasExistingBrowser) await runtime!.browser.start();
  signal?.throwIfAborted();
  const cookies = hasExistingBrowser ? await runtime!.browser.exportCookies() : [];
  signal?.throwIfAborted();
  const url = runtime?.state.browser.url;
  const context = await createAgentContext(name);
  signal?.throwIfAborted();
  if (hasExistingBrowser) await runtime!.browser.close();
  signal?.throwIfAborted();
  taskState.update((current) => setTaskBrowserContext(current, context.id));

  if (runtime) {
    runtime.state.browser = {
      provider: "not-started",
      status: "idle",
      contextId: context.id,
      contextStatus: "saved",
    };
    runtime.browser = createRuntimeBrowser(
      sessionId,
      runtime.state,
      context.id,
      runtime.state.browser.proxyLocation,
    );
    if (cookies.length) await runtime.browser.importCookies(cookies, url);
  }

  return {
    id: context.id,
    name: context.name,
    selected: true,
    migratedCookieCount: cookies.length,
  };
}

export async function selectBrowserContext(
  target: BrowserTarget,
  contextId: string,
  scope?: BrowserScope,
): Promise<{ id: string; name: string; selected: true }> {
  const { sessionId, scope: resolvedScope } = resolveBrowserTarget(target, scope);
  await assertSharedContextsAllowed(sessionId, resolvedScope);
  const runtime = runtimes.get(sessionId);
  if (runtime?.browser.hasStarted() || taskState.get().browser.sessionId) {
    throw new Error("Save or close the current browser before you select another Context.");
  }
  await selectAgentContext(contextId);
  const context = (await listAgentContexts()).find((item) => item.id === contextId);
  if (!context) throw new Error("Unknown Context.");
  taskState.update((current) => setTaskBrowserContext(current, contextId));
  if (runtime) {
    runtime.state.browser.contextId = contextId;
    runtime.state.browser.contextStatus = "saved";
    runtime.browser = createRuntimeBrowser(
      sessionId,
      runtime.state,
      contextId,
      runtime.state.browser.proxyLocation,
    );
  }
  return { id: context.id, name: context.name, selected: true };
}

export async function saveBrowserContext(
  target: BrowserTarget,
  name?: string,
  signal?: AbortSignal,
  scope?: BrowserScope,
): Promise<{
  id: string;
  name: string;
  status: "saved";
  migratedCookieCount: number;
}> {
  const { sessionId, scope: resolvedScope } = resolveBrowserTarget(target, scope);
  await assertSharedContextsAllowed(sessionId, resolvedScope);
  signal?.throwIfAborted();
  let contextId = taskState.get().browser.contextId;
  let migratedCookieCount = 0;
  if (!contextId) {
    const created = await createBrowserContext(
      sessionId,
      name?.trim() || `Bell ${new Date().toISOString().slice(0, 10)}`,
      signal,
    );
    contextId = created.id;
    migratedCookieCount = created.migratedCookieCount;
  }

  const draft = await isDraftAgentContext(contextId, sessionId);
  signal?.throwIfAborted();
  const contextName = name?.trim() || (draft ? defaultContextName(taskState.get()) : undefined);
  await saveBrowserRuntime(sessionId);
  await closeBrowserRuntime(sessionId);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  signal?.throwIfAborted();
  const context = await promoteAgentContext(contextId, contextName);
  signal?.throwIfAborted();
  taskState.update((current) => setTaskBrowserContext(current, contextId, "closed", "saved"));
  return {
    id: context.id,
    name: context.name,
    status: "saved",
    migratedCookieCount,
  };
}

function createRuntimeBrowser(
  sessionId: string,
  state: ConversationState,
  contextId?: string,
  proxyLocation?: BrowserProxyLocation,
): BrowserSession {
  return new BrowserSession(state, {
    contextId,
    proxyLocation,
    captcha: taskState.get().captcha,
    ensureContext: personalBrowserEnabled() ? undefined : async (currentContextId) => {
      const context = await ensureAgentContext(sessionId, currentContextId);
      state.browser.contextId = context.id;
      state.browser.contextStatus = context.status;
      taskState.update((current) => recordTaskBrowserContext(current, context.id, context.status));
      return { id: context.id, status: context.status };
    },
  });
}

function defaultContextName(record: { title: string }): string {
  const title = record.title.trim();
  if (title && title !== "New task") return title.slice(0, 80);
  return `Bell ${new Date().toISOString().slice(0, 10)}`;
}

function scheduleIdleClose(sessionId: string, runtime: BrowserRuntime): void {
  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
  if (runtime.closing || runtimes.get(sessionId) !== runtime) return;
  const configured = Number(process.env.BELL_BROWSER_IDLE_MS ?? DEFAULT_IDLE_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_IDLE_TIMEOUT_MS;
  runtime.idleTimer = setTimeout(() => {
    if (runtimes.get(sessionId) === runtime)
      void closeBrowserRuntime(sessionId).catch(() => undefined);
  }, timeoutMs);
  runtime.idleTimer.unref?.();
}

// Channel callbacks also run when Eve ends a session outside a turn.
// Global stream hooks do not run on that path in Eve 0.79.1.
export const browserChannelEvents = {
  async "session.completed"(_event: unknown, _channel: unknown, ctx: { session: { id: string } }) {
    await closeBrowserRuntime(ctx.session.id);
  },
  async "session.failed"(event: { sessionId: string }) {
    await closeBrowserRuntime(event.sessionId);
  },
};
