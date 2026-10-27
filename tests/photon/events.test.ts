/**
 * Inbound event pipeline: every documented SDK variant normalizes into the
 * versioned internal envelope, and each envelope family reaches its correct
 * admission disposition. Normalization lives in the parallel transport
 * workstream — those describes skip while `server/photon/normalize.ts` is
 * absent. The admission-policy integration tests run now against the frozen
 * `policy.ts`.
 */
import { describe, expect, it } from "vitest";

import type { CatchUpEvent, LiveEvent, SharedFriendLocationUpdated } from "@photon-ai/advanced-imessage/grpc";

import type { PhotonEventEnvelope } from "../../server/photon/contracts";
import { normalizeLiveEvent } from "../../server/photon/normalize";
import { admitEvent } from "../../server/photon/policy";

import {
  envelope,
  groupConfig,
  payloadHashFor,
  testConfig,
} from "./fixtures/harness";
import * as fx from "./fixtures/sdk-events";
import { handleKey } from "../../server/photon/identity";

/* ------------------------------------------------------------------ */
/* normalizeLiveEvent — transport workstream module                    */
/* ------------------------------------------------------------------ */

/** Test-facing adapter: live-source normalization with a default receivedAt. */
const n = {
  normalizeLiveEvent: (
    event: LiveEvent | CatchUpEvent | SharedFriendLocationUpdated,
    receivedAt = "2026-10-27T12:00:01.000Z",
  ): PhotonEventEnvelope | null => normalizeLiveEvent(event, "live", receivedAt),
};

describe("normalizeLiveEvent (server/photon/normalize.ts)", () => {

  it("maps common envelope context: sequence string, chatGuid, isFromMe, occurredAt", () => {
    const raw = fx.messageReceived({ chatGuid: fx.DIRECT_CHAT });
    const out = n.normalizeLiveEvent(raw, "2026-10-27T12:00:01.000Z");
    expect(out).not.toBeNull();
    expect(out!.sequence).toBe(String(raw.sequence));
    expect(out!.chatGuid).toBe(fx.DIRECT_CHAT);
    expect(out!.isFromMe).toBe(false);
    expect(out!.occurredAt).toBe(raw.occurredAt.toISOString());
    expect(out!.sourceKind).toBe("live");
    expect(out!.version).toBe(1);
  });

  it("normalizes a phone actor to phone:+E164 and an email actor to email:lowercase", () => {
    const withPhone = n.normalizeLiveEvent(fx.messageReceived({ actor: fx.phone() }));
    expect(withPhone!.actor).toBe(`phone:${fx.OPERATOR_PHONE}`);
    const withEmail = n.normalizeLiveEvent(fx.messageReceived({ actor: fx.email("Member@Example.COM") }));
    expect(withEmail!.actor).toBe("email:member@example.com");
    // An actor that cannot canonicalize must not fabricate an identity.
    const garbage = fx.messageReceived({ actor: { address: "not a handle", service: "iMessage" } });
    const out = n.normalizeLiveEvent(garbage);
    expect(out === null || out.actor === undefined).toBe(true);
  });

  it("rejects unsafe integers rather than silently truncating the sequence", () => {
    const unsafe = fx.messageReceived();
    const forged = { ...unsafe, sequence: Number.MAX_SAFE_INTEGER + 1 };
    let result: PhotonEventEnvelope | null | "threw";
    try {
      result = n.normalizeLiveEvent(forged) ?? null;
    } catch {
      result = "threw";
    }
    // Either an explicit failure or a rejection — never a truncated sequence.
    if (result === "threw") {
      expect(result).toBe("threw");
    } else {
      expect(result).toBeNull();
    }
    const maxSafe = { ...unsafe, sequence: Number.MAX_SAFE_INTEGER };
    const ok = n.normalizeLiveEvent(maxSafe);
    if (ok !== null) expect(ok.sequence).toBe(String(Number.MAX_SAFE_INTEGER));
  });

  it("maps every message variant to family 'message' with its own type", () => {
    const cases: [LiveEvent, string][] = [
      [fx.messageReceived(), "received"],
      [fx.messageEdited(), "edited"],
      [fx.messageRead(), "read"],
      [fx.messageUnsent(), "unsent"],
      [fx.reactionAdded(), "reactionAdded"],
      [fx.reactionRemoved(), "reactionRemoved"],
      [fx.stickerPlaced(), "stickerPlaced"],
    ];
    for (const [event, type] of cases) {
      const out = n.normalizeLiveEvent(event);
      expect(out?.event.family, event.type).toBe("message");
      expect(out?.event.type, event.type).toBe(type);
    }
  });

  it("preserves message content structure instead of flattening to text", () => {
    const raw = fx.messageReceived({ message: fx.unicodeMessage() });
    const out = n.normalizeLiveEvent(raw);
    const event = out!.event;
    expect(event.family).toBe("message");
    if (event.family === "message" && event.type === "received") {
      expect(event.message.content.mentions).toHaveLength(1);
      expect(event.message.content.text).toContain("🥖");
    } else {
      expect.unreachable("received message did not stay a received message");
    }
  });

  it("maps every chat variant to family 'chat'", () => {
    for (const event of [fx.backgroundChanged(), fx.backgroundRemoved(), fx.chatMarkedRead(), fx.chatArchived(), fx.chatUnarchived()]) {
      const out = n.normalizeLiveEvent(event);
      expect(out?.event.family, event.type).toBe("chat");
      expect(out?.event.type, event.type).toBe(event.type.slice("chat.".length));
    }
  });

  it("maps all six group.changed deltas to distinct group types", () => {
    const events: [ReturnType<typeof fx.groupEvent>, string][] = [
      [fx.groupDisplayNameChanged(), "displayNameChanged"],
      [fx.groupParticipantAdded(), "participantAdded"],
      [fx.groupParticipantRemoved(), "participantRemoved"],
      [fx.groupParticipantLeft(), "participantLeft"],
      [fx.groupIconChanged(), "iconChanged"],
      [fx.groupIconRemoved(), "iconRemoved"],
    ];
    for (const [event, type] of events) {
      const out = n.normalizeLiveEvent(event);
      expect(out?.event.family, event.change.type).toBe("group");
      expect(out?.event.type, event.change.type).toBe(type);
      expect(out?.chatGuid).toBe(fx.GROUP_CHAT);
    }
  });

  it("separates the group change initiator from the changed participant", () => {
    const out = n.normalizeLiveEvent(
      fx.groupParticipantRemoved(fx.phone(fx.STRANGER_PHONE), { actor: fx.phone(fx.OPERATOR_PHONE) }),
    );
    expect(out?.actor).toBe(`phone:${fx.OPERATOR_PHONE}`);
    const event = out?.event;
    if (event?.family === "group" && event.type === "participantRemoved") {
      expect(event.participant.address).toBe(fx.STRANGER_PHONE);
    } else {
      expect.unreachable("participantRemoved did not keep its participant");
    }
  });

  it("maps all four poll deltas including titleless creation", () => {
    for (const [event, type] of [
      [fx.pollCreated(), "created"],
      [fx.pollCreatedTitleless(), "created"],
      [fx.pollOptionAdded(), "optionAdded"],
      [fx.pollVoted(), "voted"],
      [fx.pollUnvoted(), "unvoted"],
    ] as const) {
      const out = n.normalizeLiveEvent(event);
      expect(out?.event.family, type).toBe("poll");
      expect(out?.event.type, type).toBe(type);
    }
    const created = n.normalizeLiveEvent(fx.pollVoted("opt-aaaa"));
    if (created?.event.family === "poll" && created.event.type === "voted") {
      expect(created.event.delta.optionIdentifier).toBe("opt-aaaa");
    }
  });

  it("maps location updates and the catchup.complete marker", () => {
    const out = n.normalizeLiveEvent(fx.locationUpdated());
    expect(out?.event.family).toBe("location");
    if (out?.event.family === "location") expect(out.event.type).toBe("updated");
    // Location watch sequences live in their own namespace — they can never
    // collide with durable-log inbox sequences.
    expect(out?.sequence).toBe(`loc:${fx.locationUpdated().sourceSequence}`);
    const done = n.normalizeLiveEvent(fx.catchupComplete(42) as unknown as LiveEvent);
    if (done !== null) {
      expect(done.event.family).toBe("catchup");
      expect(done.event.type).toBe("complete");
      if (done.event.family === "catchup") expect(done.event.headSequence).toBe("42");
    }
  });

  it("returns null for unknown variants instead of throwing", () => {
    const futuristic = { type: "message.unknownFuture", sequence: 9, chatGuid: "c", isFromMe: false, occurredAt: new Date() } as unknown as LiveEvent;
    expect(() => n.normalizeLiveEvent(futuristic)).not.toThrow();
    expect(n.normalizeLiveEvent(futuristic)).toBeNull();
  });

  it("produces envelopes whose canonical payload hash ignores transport metadata", () => {
    const raw = fx.messageReceived();
    const live = n.normalizeLiveEvent({ ...raw }, "2026-10-27T12:00:01.000Z");
    const replayed = n.normalizeLiveEvent({ ...raw }, "2026-10-27T12:00:09.000Z");
    expect(live).not.toBeNull();
    expect(replayed).not.toBeNull();
    // The hash covers provider identity only: same event from live and
    // catch-up collides into one inbox record, not two.
    const canonical = (env: PhotonEventEnvelope) =>
      payloadHashFor({ ...env, sourceKind: "live" });
    expect(canonical({ ...live!, sourceKind: "catchup" })).toBe(canonical(live!));
  });
});

/* ------------------------------------------------------------------ */
/* admitEvent — frozen policy, runs now                                */
/* ------------------------------------------------------------------ */

const config = testConfig();
const gconfig = groupConfig();

function admitDirect(event: Parameters<typeof envelope>[0], input: Parameters<typeof envelope>[1] = {}) {
  return admitEvent(config, envelope(event, { chatGuid: fx.DIRECT_CHAT, ...input }));
}

describe("admitEvent per envelope kind", () => {
  it("admits a direct message from an allowlisted sender for an agent turn", () => {
    const decision = admitDirect({ family: "message", type: "received", message: fx.message() });
    expect(decision).toMatchObject({
      disposition: "admitted", reason: "direct_message",
      dispatchAction: "send", scope: "direct",
      actor: { kind: "phone", value: fx.OPERATOR_PHONE },
    });
  });

  it("stores a self-origin echo as state_only — never a new turn", () => {
    for (const env of [
      envelope({ family: "message", type: "received", message: fx.message({ isFromMe: true }) }, { chatGuid: fx.DIRECT_CHAT }),
      envelope({ family: "message", type: "received", message: fx.message() }, { chatGuid: fx.DIRECT_CHAT, isFromMe: true }),
      envelope({ family: "message", type: "received", message: fx.message({ isAutoReply: true }) }, { chatGuid: fx.DIRECT_CHAT }),
    ]) {
      const decision = admitEvent(config, env);
      expect(decision.disposition).toBe("state_only");
      expect(decision.reason).toBe("self_origin_echo");
      expect(decision.dispatchAction).toBe("state_apply");
    }
  });

  it("denies system, service and non-normal item types without dispatch", () => {
    for (const message of [
      fx.message({ isSystemMessage: true }),
      fx.message({ isServiceMessage: true }),
      fx.message({ itemType: "participantChange" }),
      fx.message({ itemType: "groupNameChange" }),
    ]) {
      const decision = admitDirect({ family: "message", type: "received", message });
      expect(decision).toMatchObject({ disposition: "denied", reason: "system_message", dispatchAction: "none" });
    }
  });

  it("rejects a conflicting destinationCallerId but accepts the verified line or absence", () => {
    const foreign = admitDirect({
      family: "message", type: "received",
      message: fx.message({ destinationCallerId: "+12025550177" }),
    });
    expect(foreign).toMatchObject({ disposition: "denied", reason: "destination_caller_mismatch" });

    const ownLine = admitDirect({
      family: "message", type: "received",
      message: fx.message({ destinationCallerId: fx.RECEIVING_LINE }),
    });
    expect(ownLine.disposition).toBe("admitted");

    const absent = admitDirect({
      family: "message", type: "received",
      message: fx.message({ destinationCallerId: undefined }),
    });
    expect(absent.disposition).toBe("admitted");
  });

  it("denies senders outside every allowlist and unverifiable senders", () => {
    const stranger = admitDirect({
      family: "message", type: "received",
      message: fx.message({ sender: fx.phone(fx.STRANGER_PHONE) }),
    });
    expect(stranger).toMatchObject({ disposition: "denied", reason: "sender_not_allowed" });

    // A sender the provider reports but Bell cannot verify as a handle never
    // falls through to admission, even when no actor attribute exists.
    const anonymous = admitDirect({
      family: "message", type: "received",
      message: fx.message({ sender: fx.phone("not-a-handle") }),
    });
    expect(anonymous).toMatchObject({ disposition: "denied", reason: "sender_unverified" });
  });

  it("falls back to the event actor when the message sender is absent", () => {
    const decision = admitEvent(
      config,
      envelope(
        { family: "message", type: "received", message: fx.message({ sender: undefined }) },
        { chatGuid: fx.DIRECT_CHAT, actor: `phone:${fx.OPERATOR_PHONE}` },
      ),
    );
    expect(decision).toMatchObject({ disposition: "admitted", actor: { kind: "phone", value: fx.OPERATOR_PHONE } });
  });

  it("treats non-received message variants as state-only, even when self-origin", () => {
    const variants = [
      { family: "message", type: "edited", messageGuid: "m", content: fx.message().content, editedAt: "t" },
      { family: "message", type: "read", messageGuid: "m", readAt: "t" },
      { family: "message", type: "unsent", messageGuid: "m", retractedAt: "t" },
      { family: "message", type: "reactionAdded", messageGuid: "m", reaction: { kind: "love" } },
      { family: "message", type: "reactionRemoved", messageGuid: "m", reaction: { kind: "love" } },
      { family: "message", type: "stickerPlaced", messageGuid: "m" },
    ] as const;
    for (const event of variants) {
      const decision = admitDirect(event as never, { actor: `phone:${fx.OPERATOR_PHONE}` });
      expect(decision.disposition, event.type).toBe("state_only");
      expect(decision.dispatchAction, event.type).toBe("state_apply");
    }
    const selfEcho = admitDirect(variants[0] as never, { isFromMe: true });
    expect(selfEcho.reason).toBe("self_origin_mutation");
  });

  it("keeps disallowed actors' state mutations from authorizing anything", () => {
    const decision = admitDirect(
      { family: "message", type: "reactionAdded", messageGuid: "m", reaction: { kind: "like" } },
      { actor: `phone:${fx.STRANGER_PHONE}` },
    );
    expect(decision).toMatchObject({ disposition: "state_only", reason: "actor_not_allowed", dispatchAction: "state_apply" });
  });

  it("marks chat, poll, location and catchup families as state_apply", () => {
    const cases: [Parameters<typeof envelope>[0], string][] = [
      [{ family: "chat", type: "markedRead" }, "chat_markedRead"],
      [{ family: "chat", type: "archived" }, "chat_archived"],
      [{ family: "poll", type: "created", pollMessageGuid: "p", delta: { type: "created", title: "t", options: [] } }, "poll_created"],
      [{ family: "poll", type: "voted", pollMessageGuid: "p", delta: { type: "voted", optionIdentifier: "o" } }, "poll_voted"],
      [{ family: "location", type: "updated", location: fx.sharedLocation(), sourceSequence: "7" }, "location_update"],
      [{ family: "catchup", type: "complete", headSequence: "99" }, "catchup_complete_marker"],
    ];
    for (const [event, reason] of cases) {
      const decision = admitDirect(event);
      expect(decision.disposition, reason).toBe("state_only");
      expect(decision.dispatchAction, reason).toBe("state_apply");
      expect(decision.reason, reason).toBe(reason);
    }
  });

  it("denies a group-scoped envelope when group ingress is closed", () => {
    const decision = admitEvent(
      config,
      envelope({ family: "message", type: "received", message: fx.message({ chatGuids: [fx.GROUP_CHAT] }) }, { chatGuid: fx.GROUP_CHAT }),
      { scope: "group", generation: 1, membership: [], membershipVersion: 0 },
    );
    expect(decision).toMatchObject({ disposition: "denied", reason: "group_not_admitted" });
  });

  it("admits an allowed group's member message and flags membership events", () => {
    const conversation = {
      scope: "group" as const, generation: 1,
      membership: [handleKey({ kind: "phone" as const, value: fx.OPERATOR_PHONE })],
      membershipVersion: 2,
    };
    const decision = admitEvent(
      gconfig,
      envelope(
        { family: "message", type: "received", message: fx.message({ chatGuids: [fx.GROUP_CHAT] }) },
        { chatGuid: fx.GROUP_CHAT },
      ),
      conversation,
    );
    expect(decision).toMatchObject({ disposition: "admitted", scope: "group", dispatchAction: "send" });
    const memberEvent = admitEvent(
      gconfig,
      envelope(
        { family: "group", type: "participantLeft", participant: { address: fx.STRANGER_PHONE, service: "iMessage" } },
        { chatGuid: fx.GROUP_CHAT },
      ),
      conversation,
    );
    expect(memberEvent).toMatchObject({ disposition: "state_only", updatesMembership: true });
  });
});
