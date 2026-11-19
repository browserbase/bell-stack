import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import linq from "../agent/channels/linq";
import * as notionOAuth from "../server/notion/oauth";

const line = "+12025550100";
const sender = "+12025550123";
function chat(id = "private-chat", senderId = "sender-id", phone = sender) {
  return { id, is_group: false, handles: [
    { id: "line-id", handle: line, is_me: true, status: "active", left_at: null },
    { id: senderId, handle: phone, is_me: false, status: "active", left_at: null },
  ] };
}
const connected = vi.fn(async () => ({ status: "connected" }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-18T03:00:00Z"));
  vi.stubEnv("TZ", "Asia/Kolkata");
  vi.stubEnv("NOTION_ENABLED", "true");
  vi.stubEnv("LINQ_API_KEY", "synthetic-key");
  vi.stubEnv("BELL_LINQ_PHONE_NUMBER", line);
  vi.stubEnv("BELL_LINQ_ALLOWED_SENDERS", sender);
  connected.mockReset().mockResolvedValue({ status: "connected" });
  vi.spyOn(notionOAuth, "getNotionOAuth").mockReturnValue({ status: connected } as never);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ chats: [chat()], next_cursor: null })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function run() {
  const morning = (await import("../agent/schedules/morning")).default;
  const send = vi.fn(async () => ({} as never));
  const to = vi.fn(() => ({ send }));
  await morning.run!({ to, waitUntil: () => {}, appAuth: {} as never });
  return { to, send };
}

describe("Fixed morning schedule", () => {
  it("configures Eve to run daily at 8:30 in the configured IANA timezone", async () => {
    const morning = (await import("../agent/schedules/morning")).default;
    expect(morning).toMatchObject({
      cron: "30 8 * * *",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it("reuses the existing private chat and its connected Notion identity", async () => {
    const { to, send } = await run();
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(new URL(String(url)).searchParams.get("from")).toBe(line);
    expect(options?.headers).toMatchObject({ Authorization: "Bearer synthetic-key" });
    expect(connected).toHaveBeenCalledWith({ type: "user", issuer: "linq", id: "linq:sender-id" });
    expect(to).toHaveBeenCalledWith(linq, { adapterName: "linq", threadId: "linq:private-chat" });
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Give the user a short morning update"), {
      auth: expect.objectContaining({
        principalType: "user", issuer: "linq", principalId: "linq:sender-id", subject: "sender-id",
        attributes: expect.objectContaining({ bell_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, bell_watch_chat: "private-chat", bell_watch_sender: sender }),
      }),
    });
  });

  it.each([undefined, null])("reuses a private chat when participant metadata is %s", async metadata => {
    const value = chat();
    const handles = value.handles.map(handle => ({ ...handle, is_me: metadata, status: metadata }));
    vi.mocked(fetch).mockResolvedValue(Response.json({ chats: [{ ...value, handles }], next_cursor: null }));
    const { to, send } = await run();
    expect(to).toHaveBeenCalledWith(linq, { adapterName: "linq", threadId: "linq:private-chat" });
    expect(connected).toHaveBeenCalledWith({ type: "user", issuer: "linq", id: "linq:sender-id" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("ignores the deprecated archive flag", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ chats: [{ ...chat(), is_archived: true }], next_cursor: null }));
    expect((await run()).send).toHaveBeenCalledOnce();
  });

  it.each([
    ["group", (value: ReturnType<typeof chat>) => { value.is_group = true; }],
    ["wrong line", (value: ReturnType<typeof chat>) => { value.handles[0].handle = "+12025550999"; }],
    ["line marked as external", (value: ReturnType<typeof chat>) => { value.handles[0].is_me = false; }],
    ["sender marked as owned", (value: ReturnType<typeof chat>) => { value.handles[1].is_me = true; }],
    ["unlisted sender", (value: ReturnType<typeof chat>) => { value.handles[1].handle = "+12025550999"; }],
    ["removed participant", (value: ReturnType<typeof chat>) => { value.handles[1].status = "removed"; }],
    ["extra participant", (value: ReturnType<typeof chat>) => { value.handles.push({ ...value.handles[1], id: "third" }); }],
  ])("skips a %s chat", async (_name, change) => {
    const value = chat();
    change(value);
    vi.mocked(fetch).mockResolvedValue(Response.json({ chats: [value], next_cursor: null }));
    expect((await run()).send).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
  });

  it("follows chat pagination and sends once per Linq identity", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ chats: [], next_cursor: "next-page" }))
      .mockResolvedValueOnce(Response.json({ chats: [chat(), chat("other-chat")], next_cursor: null }));
    expect((await run()).send).toHaveBeenCalledOnce();
    expect(new URL(String(vi.mocked(fetch).mock.calls[1][0])).searchParams.get("cursor")).toBe("next-page");
  });

  it("uses each allowed sender's own chat and Notion identity", async () => {
    vi.stubEnv("BELL_LINQ_ALLOWED_SENDERS", `${sender},+12025550456`);
    vi.mocked(fetch).mockResolvedValue(Response.json({ chats: [chat(), chat("second-chat", "second-sender", "+12025550456")] }));
    const { send, to } = await run();
    expect(send).toHaveBeenCalledTimes(2);
    expect(to).toHaveBeenNthCalledWith(2, linq, { adapterName: "linq", threadId: "linq:second-chat" });
    expect(connected).toHaveBeenNthCalledWith(2, { type: "user", issuer: "linq", id: "linq:second-sender" });
  });

  it("does not create a chat when none exists", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ chats: [], next_cursor: null }));
    expect((await run()).send).not.toHaveBeenCalled();
  });

  it("skips disconnected Notion accounts", async () => {
    connected.mockResolvedValue({ status: "disconnected" });
    expect((await run()).send).not.toHaveBeenCalled();
  });

  it("does not contact Linq when Notion is disabled", async () => {
    vi.stubEnv("NOTION_ENABLED", "false");
    expect((await run()).send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["LINQ_API_KEY", "BELL_LINQ_PHONE_NUMBER", "BELL_LINQ_ALLOWED_SENDERS"])("skips delivery when existing %s setup is missing", async name => {
    vi.stubEnv(name, "");
    expect((await run()).send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
