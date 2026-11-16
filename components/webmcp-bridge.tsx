"use client";

import { useEffect } from "react";
import { createAgent, registerTools } from "@ui-sdk/react/agent";

let agent: ReturnType<typeof createAgent> | undefined;

function getAgent() {
  agent ??= createAgent({
    allow: (step) =>
      !step.confirm ||
      window.confirm(`Allow browser agent?\n\n${step.confirm}`),
  });
  return agent;
}

export function WebMcpBridge() {
  useEffect(() => {
    // The bridge handles confirmation, so WebMCP must not ask a second time.
    return registerTools(getAgent(), { allow: () => true });
  }, []);

  return null;
}
