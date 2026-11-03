export const CAPTCHA_EVENT_NAMES = [
  "browserbase-solving-started",
  "browserbase-solving-finished",
  "browserbase-solving-errored",
] as const;
export type CaptchaSignal = "started" | "finished" | "errored";
export interface CaptchaTransition {
  id: string;
  type: CaptchaSignal | "timed_out";
  at: string;
  page?: { origin: string; path: string };
}

export function captchaTimeoutMs(): number {
  const value = Number(process.env.BELL_CAPTCHA_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

export function parseBrowserbaseCaptchaEvent(value: unknown): CaptchaSignal | undefined {
  if (!value || typeof value !== "object") return;
  const event = value as {
    method?: unknown;
    params?: { args?: Array<{ type?: unknown; value?: unknown }> };
  };
  if (event.method !== undefined && event.method !== "Runtime.consoleAPICalled") return;
  const message = event.params?.args?.find(
    (arg) => arg?.type === "string" && typeof arg.value === "string",
  )?.value;
  if (message === CAPTCHA_EVENT_NAMES[0]) return "started";
  if (message === CAPTCHA_EVENT_NAMES[1]) return "finished";
  if (message === CAPTCHA_EVENT_NAMES[2]) return "errored";
}

export function safeCaptchaPage(value?: string): { origin: string; path: string } | undefined {
  try {
    if (!value) return;
    const url = new URL(value);
    return { origin: url.origin, path: url.pathname };
  } catch {
    return;
  }
}
