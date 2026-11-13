import type { ToolContext } from "eve/tools";
import type { ApprovalContext } from "eve/tools/approval";
import { describe, expect, it } from "vitest";
import { poppyOwner } from "../agent/lib/poppy";
import connect from "../agent/tools/poppy_connect";
import disconnect from "../agent/tools/poppy_disconnect";

describe("Poppy application authorization", () => {
  function context(auth: unknown) { return { session: { auth: { current: auth } } } as ToolContext; }

  it("rejects shared and anonymous sessions and isolates authenticated principals", () => {
    for (const auth of [undefined, { principalType: "anonymous", principalId: "anonymous" },
      { principalType: "app", principalId: "shared-app" }, { principalType: "user", principalId: "" }])
      expect(() => poppyOwner(context(auth))).toThrow("authenticated");
    const base = { authenticator: "http-basic", principalType: "user", principalId: "operator" };
    const owner = poppyOwner(context(base));
    expect(poppyOwner(context({ ...base }))).toBe(owner);
    for (const change of [{ principalId: "another-user" }, { authenticator: "linq-message" },
      { issuer: "another-issuer" }, { principalType: "local-dev" }])
      expect(poppyOwner(context({ ...base, ...change }))).not.toBe(owner);
  });

  it("requires explicit approval for each connection and disconnection", async () => {
    for (const tool of [connect, disconnect]) {
      expect(typeof tool.approval).toBe("function");
      if (typeof tool.approval !== "function") throw new Error("Missing approval policy");
      for (const approvedTools of [new Set(), new Set(["poppy_connect", "poppy_disconnect"])])
        expect(await tool.approval({ approvedTools } as unknown as ApprovalContext<{ url: string; api: number; scopes: string[] }>)).toBe("user-approval");
    }
  });
});
