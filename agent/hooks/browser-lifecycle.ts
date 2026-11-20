import { defineHook } from "eve/hooks";

import { saveBrowserRuntime } from "../lib/browser-runtime";

export default defineHook({
  events: {
    async "turn.settled"(event, ctx) {
      if (event.data.outcome === "completed") await saveBrowserRuntime(ctx.session.id);
    },
  },
});
