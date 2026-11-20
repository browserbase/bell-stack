import { defineHook, type HookContext, type HookEvent } from "eve/hooks";

import { closeBrowserRuntime, resumeBrowserAfterHumanInput } from "../lib/browser-runtime";
import { applyTaskEvent, taskState } from "../lib/task-state";

function reduce(event: HookEvent, ctx: HookContext, current: ReturnType<typeof taskState.get>) {
  return applyTaskEvent(current, event, ctx.session.id, {
    id: ctx.occurrence.idempotencyKey, at: ctx.now.toISOString(),
  });
}

const update = (event: HookEvent, ctx: HookContext) =>
  taskState.update((current) => reduce(event, ctx, current));

export default defineHook({
  events: {
    "session.started": update,
    "turn.started": update,
    "delivery.consumed": (event, ctx) => {
      taskState.update((current) => {
        const next = reduce(event, ctx, current);
        if (current.status === "waiting_for_user" && next.status === "running")
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
