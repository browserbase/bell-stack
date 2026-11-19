import { defineHook, type HookContext, type HookEvent } from "eve/hooks";

import { closeBrowserRuntime, resumeBrowserAfterHumanInput } from "../lib/browser-runtime";
import { applyTaskEvent, taskState } from "../lib/task-state";

const update = (event: HookEvent, ctx: HookContext) =>
  taskState.update((current) => applyTaskEvent(current, event, ctx.session.id, ctx.position, ctx.now.toISOString()));

export default defineHook({
  events: {
    "session.started": update,
    "turn.started": update,
    "delivery.consumed": (event, ctx) => {
      taskState.update((current) => {
        const next = applyTaskEvent(current, event, ctx.session.id, ctx.position, ctx.now.toISOString());
        if (next !== current && current.status === "waiting_for_user" && event.data.parts.length > 0)
          resumeBrowserAfterHumanInput(ctx.session.id);
        return next;
      });
    },
    "model.started": update,
    "interaction.opened": update,
    "interaction.settled": update,
    async "turn.settled"(event, ctx) {
      if (event.data.outcome === "cancelled") await closeBrowserRuntime(ctx.session.id);
      update(event, ctx);
    },
    "session.ended": update,
  },
});
