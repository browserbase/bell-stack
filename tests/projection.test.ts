import { describe, expect, it } from "vitest";
import type { CallFact, JsonValue } from "eve/events";
import { browserPreview } from "../app/projection";

let nextCall = 0;
function toolEvents(output: JsonValue, isError = false, name = "browser"): CallFact[] {
  const callId = `call-${nextCall++}`;
  return [
    { type: "call.requested", data: { callId, owner: { turnId: "turn" }, capability: { kind: "tool", name } } },
    { type: "call.settled", data: { callId, outcome: isError ? "failed" : "completed", output } },
  ];
}
describe("shared browser output in the Bell panel", () => {
  it("reads the browser runtime's nested screenshot even when larger than Eve's projected output limit", () => {
    const screenshot = `data:image/png;base64,${"aGVs".repeat(5_000)}`;
    expect(
      browserPreview(toolEvents({
        result: {},
        workbench: {
          browser: { url: "https://example.com/" },
          screenshotDataUrl: screenshot,
        },
      })),
    ).toEqual({
      url: "https://example.com/",
      screenshot,
      httpStatus: undefined,
    });
  });
  it("clears the old capture after a new merchant navigation", () => {
    expect(
      browserPreview([
        ...toolEvents({
          workbench: { screenshotDataUrl: "data:image/png;base64,aA==" },
        }),
        ...toolEvents({
          result: { url: "https://example.com/protected", httpStatus: 401 },
        }),
      ]).screenshot,
    ).toBeUndefined();
  });
  it("ignores failed tools and remote image URLs", () => {
    expect(
      browserPreview([
        ...toolEvents({ screenshot: "https://example.com/tracker" }),
        ...toolEvents({ httpStatus: 200 }, true),
      ]),
    ).toEqual({ url: undefined, screenshot: undefined, httpStatus: undefined });
  });
  it("does not show a previous HTTP 200 after an ordinary browser visit", () => {
    const ordinary = toolEvents({ result: { completed: true, url: "https://example.com/protected" } }, false, "run");
    expect(
      browserPreview([
        ...toolEvents({ httpStatus: 200, screenshot: "data:image/png;base64,aA==" }),
        ...ordinary,
      ]),
    ).toEqual({
      url: "https://example.com/protected",
      screenshot: undefined,
      httpStatus: undefined,
    });
  });
  it("clears the previous page's capture and status after a login redirects", () => {
    expect(browserPreview([
      ...toolEvents({ url: "https://shop.example/login", httpStatus: 200, screenshot: "data:image/png;base64,aA==" }),
      ...toolEvents({
        result: { status: "complete" },
        workbench: { browser: { url: "https://shop.example/account" } },
      }),
    ])).toEqual({
      url: "https://shop.example/account",
      screenshot: undefined,
      httpStatus: undefined,
    });
  });
  it("keeps a new page's own capture and status when its URL changes", () => {
    expect(browserPreview([
      ...toolEvents({ url: "https://shop.example/login", httpStatus: 200, screenshot: "data:image/png;base64,aA==" }),
      ...toolEvents({ url: "https://shop.example/account", httpStatus: 403, screenshot: "data:image/png;base64,bA==" }),
    ])).toEqual({
      url: "https://shop.example/account",
      screenshot: "data:image/png;base64,bA==",
      httpStatus: 403,
    });
  });
});
