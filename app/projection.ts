import type { CallRequestedData, CallSettledData, ReceivedEvent } from "eve/events";

export function browserPreview(events: readonly Pick<ReceivedEvent, "type" | "data">[]) {
  let screenshot: string | undefined;
  let url: string | undefined;
  let httpStatus: number | undefined;
  const tools = new Map<string, string>();
  for (const event of events) {
    if (event.type === "call.requested") {
      const call = event.data as CallRequestedData;
      if (call.capability.kind === "tool") tools.set(call.callId, call.capability.name);
    }
    if (event.type !== "call.settled") continue;
    const { callId, outcome, output: result } = event.data as CallSettledData;
    if (outcome !== "completed") continue;
    const name = tools.get(callId);
    if (!name || !result || typeof result !== "object" || Array.isArray(result)) continue;
    const envelope = result as {
      result?: Record<string, unknown>;
      workbench?: { screenshotDataUrl?: string; browser?: { url?: string } };
    };
    const output = envelope.result ?? (result as Record<string, unknown>);
    const workbench = envelope.workbench;
    const nextUrl = typeof output.url === "string" ? output.url : workbench?.browser?.url;
    if (name === "run" || (typeof nextUrl === "string" && nextUrl !== url)) {
      // Ordinary browser work can navigate without reporting an HTTP status.
      httpStatus = undefined;
      screenshot = undefined;
    }
    if (typeof nextUrl === "string") url = nextUrl;
    if (typeof output.httpStatus === "number") {
      httpStatus = output.httpStatus;
      screenshot = undefined;
    }
    if (
      typeof output.screenshot === "string" &&
      output.screenshot.startsWith("data:image/png;base64,")
    )
      screenshot = output.screenshot;
    if (workbench?.screenshotDataUrl?.startsWith("data:image/png;base64,"))
      screenshot = workbench.screenshotDataUrl;
    if (output.closed === true) {
      screenshot = undefined;
      url = undefined;
      httpStatus = undefined;
    }
  }
  return { screenshot, url, httpStatus };
}
