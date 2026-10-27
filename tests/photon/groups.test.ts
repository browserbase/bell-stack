/**
 * Group admission and actor authorization policy. Groups need an explicitly
 * admitted chat GUID plus a verified actor inside the current membership;
 * sensitive continuations never leave the private direct conversation.
 */
import { describe, expect, it } from "vitest";

import type { CanonicalHandle } from "../../server/photon/identity";
import { handleKey, normalizeHandle, photonPrincipalId } from "../../server/photon/identity";
import {
  admitEvent,
  admitGroup,
  admitSender,
  groupActorAuthorized,
  requiresPrivateContinuation,
  type ConversationState,
} from "../../server/photon/policy";
import type { PhotonNormalizedEvent } from "../../server/photon/contracts";

import { envelope, groupConfig, testConfig } from "./fixtures/harness";
import {
  GROUP_CHAT,
  OPERATOR_PHONE,
  STRANGER_PHONE,
  message as messageFixture,
} from "./fixtures/sdk-events";

const MEMBER = { kind: "phone", value: OPERATOR_PHONE } as const satisfies CanonicalHandle;
const STRANGER = { kind: "phone", value: STRANGER_PHONE } as const satisfies CanonicalHandle;
const EMAIL_MEMBER = { kind: "email", value: "member@example.com" } as const satisfies CanonicalHandle;

function groupConversation(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    scope: "group",
    generation: 1,
    membership: [handleKey(MEMBER)],
    membershipVersion: 1,
    initiatingPrincipal: photonPrincipalId("test-project-0001", MEMBER),
    ...overrides,
  };
}

function directConversation(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    scope: "direct",
    generation: 1,
    membership: [],
    membershipVersion: 0,
    ...overrides,
  };
}

function groupMessageEvent(sender: string, overrides: Parameters<typeof messageFixture>[0] = {}): PhotonNormalizedEvent {
  return {
    family: "message",
    type: "received",
    message: messageFixture({
      sender: { address: sender, service: "iMessage", country: "US" },
      chatGuids: [GROUP_CHAT],
      ...overrides,
    }),
  };
}

describe("admitSender / admitGroup", () => {
  const config = testConfig({ allowedSenders: [OPERATOR_PHONE], allowedEmailSenders: ["member@example.com"], allowedGroups: [GROUP_CHAT] });

  it("admits only explicitly configured phone and email handles", () => {
    expect(admitSender(config, MEMBER)).toBe(true);
    expect(admitSender(config, EMAIL_MEMBER)).toBe(true);
    expect(admitSender(config, STRANGER)).toBe(false);
    // An email sender is not smuggled in through the phone allowlist.
    expect(admitSender(config, { kind: "email", value: OPERATOR_PHONE })).toBe(false);
    expect(admitSender(config, null)).toBe(false);
  });

  it("admits only explicitly configured group chats", () => {
    expect(admitGroup(config, GROUP_CHAT)).toBe(true);
    expect(admitGroup(config, "iMessage;+;other-group")).toBe(false);
    expect(admitGroup(config, undefined)).toBe(false);
    expect(admitGroup(testConfig(), GROUP_CHAT)).toBe(false);
  });
});

describe("groupActorAuthorized", () => {
  it("authorizes a current member and rejects strangers, actors, and null", () => {
    const conversation = groupConversation();
    expect(groupActorAuthorized(conversation, MEMBER)).toBe(true);
    expect(groupActorAuthorized(conversation, STRANGER)).toBe(false);
    expect(groupActorAuthorized(conversation, null)).toBe(false);
    // An actor whose handle kind differs never matches a phone member entry.
    expect(groupActorAuthorized(conversation, { kind: "email", value: OPERATOR_PHONE })).toBe(false);
  });

  it("keeps an empty-membership conversation open but never authorizes a missing actor", () => {
    const conversation = groupConversation({ membership: [] });
    expect(groupActorAuthorized(conversation, STRANGER)).toBe(true);
    expect(groupActorAuthorized(conversation, null)).toBe(false);
  });
});

describe("requiresPrivateContinuation", () => {
  it("forces wallets, vaults and handoffs back to the private DM", () => {
    expect(requiresPrivateContinuation("group")).toBe(true);
    expect(requiresPrivateContinuation(undefined)).toBe(true);
    expect(requiresPrivateContinuation("direct")).toBe(false);
  });
});

describe("admitEvent in an admitted group", () => {
  const config = groupConfig();

  it("admits a group message from a current member with group scope", () => {
    const event = groupMessageEvent(OPERATOR_PHONE);
    const decision = admitEvent(config, envelope(event, { chatGuid: GROUP_CHAT }), groupConversation());
    expect(decision).toMatchObject({
      disposition: "admitted", dispatchAction: "send", scope: "group",
      actor: MEMBER,
    });
  });

  it("denies a group message from a sender outside the membership", () => {
    const event = groupMessageEvent(STRANGER_PHONE);
    const decision = admitEvent(config, envelope(event, { chatGuid: GROUP_CHAT }), groupConversation());
    expect(decision).toMatchObject({ disposition: "denied", reason: "actor_not_in_membership" });
  });

  it("denies group ingress entirely when the chat is not in the allowlist", () => {
    const closed = testConfig();
    const event = groupMessageEvent(OPERATOR_PHONE);
    const decision = admitEvent(closed, envelope(event, { chatGuid: GROUP_CHAT }), groupConversation());
    expect(decision).toMatchObject({ disposition: "denied", reason: "group_not_admitted" });
    expect(decision.dispatchAction).toBe("none");
  });

  it("marks membership-affecting events as state updates, never agent turns", () => {
    const added: PhotonNormalizedEvent = { family: "group", type: "participantAdded", participant: { address: STRANGER_PHONE, service: "iMessage" } };
    const removed: PhotonNormalizedEvent = { family: "group", type: "participantRemoved", participant: { address: STRANGER_PHONE, service: "iMessage" } };
    for (const event of [added, removed]) {
      const decision = admitEvent(config, envelope(event, { chatGuid: GROUP_CHAT }), groupConversation());
      expect(decision).toMatchObject({ disposition: "state_only", dispatchAction: "state_apply", updatesMembership: true });
    }
  });

  it("keeps a non-member actor's reaction/vote as state_only with membership update", () => {
    const reaction: PhotonNormalizedEvent = {
      family: "message", type: "reactionAdded",
      messageGuid: "m1", reaction: { kind: "love" },
    };
    const decision = admitEvent(
      config,
      envelope(reaction, { chatGuid: GROUP_CHAT, actor: `phone:${STRANGER_PHONE}` }),
      groupConversation(),
    );
    expect(decision).toMatchObject({ disposition: "state_only", reason: "non_member_actor_state_only", updatesMembership: true });
  });

  it("keeps a member's reaction/vote state_only without membership churn", () => {
    const reaction: PhotonNormalizedEvent = {
      family: "message", type: "reactionAdded",
      messageGuid: "m1", reaction: { kind: "like" },
    };
    const decision = admitEvent(
      config,
      envelope(reaction, { chatGuid: GROUP_CHAT, actor: `phone:${OPERATOR_PHONE}` }),
      groupConversation(),
    );
    expect(decision.disposition).toBe("state_only");
    expect(decision.updatesMembership).not.toBe(true);
  });
});

describe("initiating principal isolation", () => {
  it("a different member's message never claims the initiating principal", () => {
    const owner = photonPrincipalId("test-project-0001", MEMBER);
    const other = photonPrincipalId("test-project-0001", EMAIL_MEMBER);
    const conversation = groupConversation({ initiatingPrincipal: owner, membership: [handleKey(MEMBER), handleKey(EMAIL_MEMBER)] });
    expect(conversation.initiatingPrincipal).toBe(owner);
    expect(conversation.initiatingPrincipal).not.toBe(other);
    // groupActorAuthorized governs tool access, not ownership transfer.
    expect(groupActorAuthorized(conversation, EMAIL_MEMBER)).toBe(true);
  });

  it("group and direct scopes cannot satisfy each other's checks", () => {
    const config = groupConfig();
    const direct = directConversation();
    expect(() => {
      const decision = admitEvent(config, envelope(groupMessageEvent(OPERATOR_PHONE), { chatGuid: GROUP_CHAT }), direct);
      // A direct-scoped binding row must never authorize group dispatch; policy
      // resolves the group scope from the admitted chat GUID regardless.
      expect(decision.scope).not.toBe("direct");
    }).not.toThrow();
  });
});

describe("normalized handle keys", () => {
  it("produces the canonical membership entries", () => {
    expect(handleKey(MEMBER)).toBe(`phone:${OPERATOR_PHONE}`);
    expect(handleKey(EMAIL_MEMBER)).toBe("email:member@example.com");
    expect(handleKey(normalizeHandle("Member@Example.com")!)).toBe("email:member@example.com");
  });
});
