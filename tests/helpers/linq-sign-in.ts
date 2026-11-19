import type { InteractionOpened, InteractionSettled, SignInChallenge } from "eve/events";
import { emptySessionView, foldLine } from "../../node_modules/eve/dist/src/protocol/session-projection/fold.js";
import type { ChannelAdapter } from "../../node_modules/eve/dist/src/channel/adapter.js";

export function linqSignIn(adapter: ChannelAdapter, channel: object, challenge: SignInChallenge) {
  const interactionId = "sign-in-fixture";
  const opened: InteractionOpened = {
    type: "interaction.opened",
    data: {
      interactionId,
      subject: { turnId: "fixture-turn" },
      request: { kind: "sign-in", prompt: "Connect your wallet.", signIn: challenge },
    },
  };
  const accepted: InteractionSettled = { type: "interaction.settled", data: { interactionId, outcome: "accepted" } };
  const context = (facts: readonly (InteractionOpened | InteractionSettled)[]) => {
    const view = emptySessionView();
    facts.forEach((fact, line) => foldLine(view, { at: "2026-11-19T00:00:00.000Z", facts: [fact] }, line));
    return { ...channel, view } as never;
  };
  return {
    open: () => adapter["interaction.opened"]!(opened, context([opened])),
    accept: () => adapter["interaction.settled"]!(accepted, context([opened, accepted])),
  };
}
