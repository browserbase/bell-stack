/**
 * Representative `@photon-ai/advanced-imessage` 2.4.0 SDK event fixtures.
 *
 * Every builder returns an object shaped exactly like the pinned SDK's public
 * event types (see dist/groups-PW-Snfsc.d.ts). The normalization and admission
 * pipeline under test must map all 24 documented inbound variants; unknown or
 * malformed variants must never throw their way into the agent.
 */
import type {
  AttachmentInfo,
  CatchUpEvent,
  ChatEvent,
  GroupChange,
  GroupEvent,
  LiveEvent,
  Message,
  MessageEvent,
  MessageReaction,
  PollChangeDelta,
  PollEvent,
  SharedFriendLocation,
  SharedFriendLocationUpdated,
  SingleServiceAddressInfo,
  StickerPlacement,
} from "@photon-ai/advanced-imessage/grpc";

export const RECEIVING_LINE = "+12025550100";
export const OPERATOR_PHONE = "+12025550123";
export const OPERATOR_EMAIL = "operator@example.com";
export const STRANGER_PHONE = "+12025550199";
export const DIRECT_CHAT = "iMessage;-;+12025550123";
export const GROUP_CHAT = "iMessage;+;chat000000000000000001";

export function phone(address = OPERATOR_PHONE, service: SingleServiceAddressInfo["service"] = "iMessage"): SingleServiceAddressInfo {
  return { address, country: "US", service };
}

export function email(address = OPERATOR_EMAIL): SingleServiceAddressInfo {
  return { address, service: "iMessage" };
}

interface EventContextInput {
  readonly actor?: SingleServiceAddressInfo;
  readonly chatGuid?: string;
  readonly isFromMe?: boolean;
  readonly occurredAt?: Date;
}

function context(input: EventContextInput = {}) {
  return {
    actor: input.actor,
    chatGuid: input.chatGuid ?? DIRECT_CHAT,
    isFromMe: input.isFromMe ?? false,
    occurredAt: input.occurredAt ?? new Date("2026-10-27T12:00:00.000Z"),
  };
}

/* ------------------------------------------------------------------ */
/* Message fixtures                                                    */
/* ------------------------------------------------------------------ */

export interface MessageInput {
  readonly guid?: string;
  readonly chatGuids?: readonly string[];
  readonly text?: string;
  readonly sender?: SingleServiceAddressInfo;
  readonly isFromMe?: boolean;
  readonly isAutoReply?: boolean;
  readonly isSystemMessage?: boolean;
  readonly isServiceMessage?: boolean;
  readonly isAudioMessage?: boolean;
  readonly itemType?: Message["itemType"];
  readonly destinationCallerId?: string;
  readonly subject?: string;
  readonly replyTargetGuid?: string;
  readonly attachments?: readonly AttachmentInfo[];
  readonly mentions?: Message["content"]["mentions"];
  readonly formatting?: Message["content"]["formatting"];
  readonly content?: Partial<Message["content"]>;
}

export function attachment(overrides: Partial<AttachmentInfo> = {}): AttachmentInfo {
  return {
    fileName: "photo.heic",
    guid: "att-guid-0001",
    isHidden: false,
    isOutgoing: false,
    isSticker: false,
    mimeType: "image/heic",
    totalBytes: 65_536,
    transferState: "finished",
    uti: "public.heic",
    ...overrides,
  };
}

export function message(input: MessageInput = {}): Message {
  const content: Message["content"] = {
    attachments: input.attachments ?? [],
    formatting: input.formatting ?? [],
    mentions: input.mentions ?? [],
    text: input.text ?? "Open Best Buy and tell me the homepage title.",
    ...input.content,
  };
  return {
    appliedReactions: [],
    chatGuids: input.chatGuids ?? [DIRECT_CHAT],
    content,
    dataDetectorResultsPresent: false,
    dateCreated: new Date("2026-10-27T12:00:00.000Z"),
    didNotifyRecipient: false,
    guid: input.guid ?? "msg-guid-0001",
    isArchived: false,
    isAudioMessage: input.isAudioMessage ?? false,
    isAutoReply: input.isAutoReply ?? false,
    isCorrupt: false,
    isDelayed: false,
    isDelivered: false,
    isDeliveredQuietly: false,
    isExpirable: false,
    isForward: false,
    isFromMe: input.isFromMe ?? false,
    isSent: true,
    isServiceMessage: input.isServiceMessage ?? false,
    isSpam: false,
    isSystemMessage: input.isSystemMessage ?? false,
    itemType: input.itemType ?? "normal",
    placedStickers: [],
    sendErrorCode: 0,
    sender: input.sender ?? phone(),
    destinationCallerId: input.destinationCallerId,
    subject: input.subject,
    replyTargetGuid: input.replyTargetGuid,
  };
}

/** Non-ASCII + emoji multipart message exercising UTF-16 range handling. */
export function unicodeMessage(): Message {
  return message({
    guid: "msg-guid-unicode",
    text: "Réponds en français 🥖 — テスト — مرحبا",
    content: {
      attachments: [],
      mentions: [{ address: OPERATOR_PHONE, start: 0, length: 7 }],
      formatting: [{ type: "bold", start: 20, length: 6 }],
      text: "Réponds en français 🥖 — テスト — مرحبا",
    },
  });
}

export function attachmentOnlyMessage(): Message {
  return message({
    guid: "msg-guid-attach",
    attachments: [attachment()],
    content: { attachments: [attachment()], formatting: [], mentions: [] },
  });
}

export function audioNoteMessage(): Message {
  return message({
    guid: "msg-guid-voice",
    isAudioMessage: true,
    attachments: [attachment({ fileName: "voice.m4a", mimeType: "audio/mp4", uti: "com.apple.m4a-audio" })],
    content: {
      attachments: [attachment({ fileName: "voice.m4a", mimeType: "audio/mp4", uti: "com.apple.m4a-audio" })],
      formatting: [],
      mentions: [],
    },
  });
}

/* ------------------------------------------------------------------ */
/* MessageEvent variants (all seven)                                   */
/* ------------------------------------------------------------------ */

let sequence = 1;
export function nextSequence(): number {
  return sequence++;
}

export function messageReceived(input: { message?: Message } & EventContextInput = {}): Extract<MessageEvent, { type: "message.received" }> {
  return {
    ...context(input),
    type: "message.received",
    sequence: nextSequence(),
    message: input.message ?? message(),
  };
}

export function messageEdited(input: { messageGuid?: string; content?: Message["content"]; editedAt?: Date } & EventContextInput = {}): Extract<MessageEvent, { type: "message.edited" }> {
  return {
    ...context(input),
    type: "message.edited",
    sequence: nextSequence(),
    messageGuid: input.messageGuid ?? "msg-guid-0001",
    content: input.content ?? { attachments: [], formatting: [], mentions: [], text: "edited: actually close the tab" },
    editedAt: input.editedAt ?? new Date("2026-10-27T12:05:00.000Z"),
  };
}

export function messageRead(input: { messageGuid?: string; readAt?: Date } & EventContextInput = {}): Extract<MessageEvent, { type: "message.read" }> {
  return {
    ...context(input),
    type: "message.read",
    sequence: nextSequence(),
    messageGuid: input.messageGuid ?? "msg-guid-0001",
    readAt: input.readAt ?? new Date("2026-10-27T12:06:00.000Z"),
  };
}

export function messageUnsent(input: { messageGuid?: string; retractedAt?: Date } & EventContextInput = {}): Extract<MessageEvent, { type: "message.unsent" }> {
  return {
    ...context(input),
    type: "message.unsent",
    sequence: nextSequence(),
    messageGuid: input.messageGuid ?? "msg-guid-0001",
    retractedAt: input.retractedAt ?? new Date("2026-10-27T12:07:00.000Z"),
  };
}

export function reaction(input: Partial<MessageReaction> = {}): MessageReaction {
  return { kind: "love", ...input };
}

export function reactionAdded(input: { messageGuid?: string; reaction?: MessageReaction; targetPartIndex?: number } & EventContextInput = {}): Extract<MessageEvent, { type: "message.reactionAdded" }> {
  return {
    ...context(input),
    type: "message.reactionAdded",
    sequence: nextSequence(),
    messageGuid: input.messageGuid ?? "msg-guid-0001",
    reaction: input.reaction ?? reaction(),
    targetPartIndex: input.targetPartIndex,
  };
}

export function reactionRemoved(input: { messageGuid?: string; reaction?: MessageReaction; targetPartIndex?: number } & EventContextInput = {}): Extract<MessageEvent, { type: "message.reactionRemoved" }> {
  return {
    ...context(input),
    type: "message.reactionRemoved",
    sequence: nextSequence(),
    messageGuid: input.messageGuid ?? "msg-guid-0001",
    reaction: input.reaction ?? reaction({ kind: "like" }),
    targetPartIndex: input.targetPartIndex,
  };
}

export function stickerPlaced(input: { messageGuid?: string; sticker?: AttachmentInfo; placement?: StickerPlacement; targetPartIndex?: number } & EventContextInput = {}): Extract<MessageEvent, { type: "message.stickerPlaced" }> {
  return {
    ...context(input),
    type: "message.stickerPlaced",
    sequence: nextSequence(),
    messageGuid: input.messageGuid ?? "msg-guid-0001",
    sticker: input.sticker ?? attachment({ isSticker: true, mimeType: "image/png" }),
    placement: input.placement ?? { x: 0.5, y: 0.5, scale: 1.2, rotation: 0.25 },
    targetPartIndex: input.targetPartIndex,
  };
}

/* ------------------------------------------------------------------ */
/* ChatEvent variants (all five)                                       */
/* ------------------------------------------------------------------ */

export function chatEvent(type: ChatEvent["type"], input: EventContextInput = {}): ChatEvent {
  return { ...context(input), type, sequence: nextSequence() } as ChatEvent;
}

export function backgroundChanged(input: EventContextInput = {}): ChatEvent {
  return chatEvent("chat.backgroundChanged", input);
}

export function backgroundRemoved(input: EventContextInput = {}): ChatEvent {
  return chatEvent("chat.backgroundRemoved", input);
}

export function chatMarkedRead(input: EventContextInput = {}): ChatEvent {
  return chatEvent("chat.markedRead", input);
}

export function chatArchived(input: EventContextInput = {}): ChatEvent {
  return chatEvent("chat.archived", input);
}

export function chatUnarchived(input: EventContextInput = {}): ChatEvent {
  return chatEvent("chat.unarchived", input);
}

/* ------------------------------------------------------------------ */
/* GroupEvent variants (all six GroupChange types)                     */
/* ------------------------------------------------------------------ */

export function groupEvent(change: GroupChange, input: EventContextInput = {}): GroupEvent {
  return {
    ...context({ chatGuid: GROUP_CHAT, ...input }),
    type: "group.changed",
    sequence: nextSequence(),
    change,
  };
}

export function groupDisplayNameChanged(displayName = "Weekend crew", input: EventContextInput = {}): GroupEvent {
  return groupEvent({ type: "displayNameChanged", displayName }, input);
}

export function groupParticipantAdded(participant = phone(STRANGER_PHONE), input: EventContextInput = {}): GroupEvent {
  return groupEvent({ type: "participantAdded", participant }, input);
}

export function groupParticipantRemoved(participant = phone(STRANGER_PHONE), input: EventContextInput = {}): GroupEvent {
  return groupEvent({ type: "participantRemoved", participant }, input);
}

export function groupParticipantLeft(participant = phone(STRANGER_PHONE), input: EventContextInput = {}): GroupEvent {
  return groupEvent({ type: "participantLeft", participant }, input);
}

export function groupIconChanged(input: EventContextInput = {}): GroupEvent {
  return groupEvent({ type: "iconChanged" }, input);
}

export function groupIconRemoved(input: EventContextInput = {}): GroupEvent {
  return groupEvent({ type: "iconRemoved" }, input);
}

/* ------------------------------------------------------------------ */
/* PollEvent variants (all four PollChangeDelta types)                 */
/* ------------------------------------------------------------------ */

export const POLL_GUID = "poll-msg-guid-0001";

export function pollOptions() {
  return [
    { optionIdentifier: "opt-aaaa", text: "Sushi 🍣", creatorHandle: OPERATOR_PHONE },
    { optionIdentifier: "opt-bbbb", text: "Pizza", creatorHandle: OPERATOR_PHONE },
    // Duplicate labels are legal: identity is the optionIdentifier.
    { optionIdentifier: "opt-cccc", text: "Pizza", creatorHandle: STRANGER_PHONE },
  ];
}

export function pollEvent(delta: PollChangeDelta, input: { pollMessageGuid?: string } & EventContextInput = {}): PollEvent {
  return {
    ...context({ chatGuid: GROUP_CHAT, ...input }),
    type: "poll.changed",
    sequence: nextSequence(),
    pollMessageGuid: input.pollMessageGuid ?? POLL_GUID,
    delta,
  };
}

export function pollCreated(input: { title?: string; pollMessageGuid?: string } & EventContextInput = {}): PollEvent {
  return pollEvent({ type: "created", title: input.title ?? "Dinner tonight?", options: pollOptions() }, input);
}

/** Native polls can arrive titleless — never fabricate a question. */
export function pollCreatedTitleless(input: EventContextInput = {}): PollEvent {
  return pollEvent({ type: "created", title: "", options: pollOptions() }, input);
}

export function pollOptionAdded(input: EventContextInput = {}): PollEvent {
  return pollEvent({
    type: "optionAdded",
    title: "Dinner tonight?",
    options: [...pollOptions(), { optionIdentifier: "opt-dddd", text: "Tacos", creatorHandle: STRANGER_PHONE }],
  }, input);
}

export function pollVoted(optionIdentifier = "opt-aaaa", input: EventContextInput = {}): PollEvent {
  return pollEvent({ type: "voted", optionIdentifier }, input);
}

export function pollUnvoted(optionIdentifier = "opt-aaaa", input: EventContextInput = {}): PollEvent {
  return pollEvent({ type: "unvoted", optionIdentifier }, input);
}

/* ------------------------------------------------------------------ */
/* Catch-up + location events                                          */
/* ------------------------------------------------------------------ */

export function catchupComplete(headSequence = nextSequence() - 1): Extract<CatchUpEvent, { type: "catchup.complete" }> {
  return { type: "catchup.complete", headSequence };
}

export function sharedLocation(overrides: Partial<SharedFriendLocation> = {}): SharedFriendLocation {
  return {
    address: OPERATOR_PHONE,
    accuracy: 14.2,
    expiresAt: new Date("2026-10-27T13:00:00.000Z"),
    isLocatingInProgress: false,
    latitude: 37.7749,
    locationTimestamp: new Date("2026-10-27T11:59:00.000Z"),
    locationType: "live",
    longitude: -122.4194,
    name: "Operator",
    ...overrides,
  };
}

export function locationUpdated(input: { location?: SharedFriendLocation; sourceSequence?: number } = {}): SharedFriendLocationUpdated {
  return {
    location: input.location ?? sharedLocation(),
    sourceSequence: input.sourceSequence ?? 7,
  };
}

/* ------------------------------------------------------------------ */
/* One fixture for every documented live variant, keyed by family.     */
/* ------------------------------------------------------------------ */

/** All 22 live/catch-up event variants from PRD §12 (EV01–EV22 + EV24). */
export function allLiveVariants(): readonly LiveEvent[] {
  return [
    messageReceived(),
    messageEdited(),
    messageRead(),
    messageUnsent(),
    reactionAdded(),
    reactionRemoved(),
    stickerPlaced(),
    backgroundChanged(),
    backgroundRemoved(),
    chatMarkedRead(),
    chatArchived(),
    chatUnarchived(),
    groupDisplayNameChanged(),
    groupParticipantAdded(),
    groupParticipantRemoved(),
    groupParticipantLeft(),
    groupIconChanged(),
    groupIconRemoved(),
    pollCreated(),
    pollOptionAdded(),
    pollVoted(),
    pollUnvoted(),
  ];
}

export function allCatchUpVariants(): readonly CatchUpEvent[] {
  return [...allLiveVariants(), catchupComplete()];
}
