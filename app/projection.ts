import type { Fact, Progress } from "eve/events";

export function browserPreview(events: readonly (Fact | Progress)[]) {
  let screenshot: string | undefined;
  let url: string | undefined;
  let httpStatus: number | undefined;
  // Read stream facts rather than projected messages, which can omit large screenshots.
  const toolNames = new Map<string, string>();
  for (const event of events) {
    if (event.type === "call.requested" && event.data.capability.kind === "tool") {
      toolNames.set(event.data.callId, event.data.capability.name);
      continue;
    }
    if (event.type !== "call.settled" || event.data.outcome !== "completed") continue;
    const toolName = toolNames.get(event.data.callId);
    const { output: value } = event.data;
    if (toolName === undefined || !value || typeof value !== "object") continue;
    const envelope = value as {
      result?: Record<string, unknown>;
      workbench?: { screenshotDataUrl?: string; browser?: { url?: string } };
    };
    const output = envelope.result ?? (value as Record<string, unknown>);
    const workbench = envelope.workbench;
    const nextUrl = typeof output.url === "string" ? output.url : workbench?.browser?.url;
    if (toolName === "run" || (typeof nextUrl === "string" && nextUrl !== url)) {
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
