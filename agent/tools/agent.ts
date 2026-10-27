import { disableTool } from "eve/tools";

// Delegation stays disabled: Eve's defineState does not propagate the
// server-verified Photon root conversation, audience and initiating-principal
// binding into subagents. Until a delegation path carries that binding it must
// fail closed — a subagent without it can never fall back to web or operator
// privileges just because its immediate channel differs from the root Photon
// channel.
export default disableTool();
