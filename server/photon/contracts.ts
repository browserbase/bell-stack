import type {
  AttachmentInfo,
  Chat,
  CatchUpEvent,
  GroupChange,
  LiveEvent,
  LocationRequestReceipt,
  Message,
  MessageListPage,
  MessageReaction,
  MiniAppCardSession,
  MiniAppMessageResult,
  MultiServiceAddressInfo,
  Poll,
  PollChangeDelta,
  SharedFriendLocation,
  SingleServiceAddressInfo,
  StickerPlacement,
} from "@photon-ai/advanced-imessage/grpc";
import { z } from "zod";

import type { CanonicalHandle } from "./identity.js";

/**
 * Versioned internal event/command contract shared by the transport worker,
 * the Eve channel routes, and the agent tools. Payloads import the pinned
 * SDK's public types rather than copying incompatible definitions.
 */

export const ENVELOPE_VERSION = 1;
export const NORMALIZATION_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Inbound normalized events                                           */
/* ------------------------------------------------------------------ */

export type PhotonEventFamily = "message" | "chat" | "group" | "poll" | "location" | "catchup";

/** Every documented inbound variant normalized to a stable internal union. */
export type PhotonNormalizedEvent =
  | { readonly family: "message"; readonly type: "received"; readonly message: Message }
  | { readonly family: "message"; readonly type: "edited"; readonly messageGuid: string; readonly content: Message["content"]; readonly editedAt: string }
  | { readonly family: "message"; readonly type: "read"; readonly messageGuid: string; readonly readAt: string }
  | { readonly family: "message"; readonly type: "unsent"; readonly messageGuid: string; readonly retractedAt: string }
  | { readonly family: "message"; readonly type: "reactionAdded"; readonly messageGuid: string; readonly reaction: MessageReaction; readonly targetPartIndex?: number }
  | { readonly family: "message"; readonly type: "reactionRemoved"; readonly messageGuid: string; readonly reaction: MessageReaction; readonly targetPartIndex?: number }
  | { readonly family: "message"; readonly type: "stickerPlaced"; readonly messageGuid: string; readonly sticker?: Message["placedStickers"][number]["sticker"]; readonly placement?: StickerPlacement; readonly targetPartIndex?: number }
  | { readonly family: "chat"; readonly type: "backgroundChanged" }
  | { readonly family: "chat"; readonly type: "backgroundRemoved" }
  | { readonly family: "chat"; readonly type: "markedRead" }
  | { readonly family: "chat"; readonly type: "archived" }
  | { readonly family: "chat"; readonly type: "unarchived" }
  | { readonly family: "group"; readonly type: "displayNameChanged"; readonly displayName: string }
  | { readonly family: "group"; readonly type: "participantAdded"; readonly participant: SingleServiceAddressInfo }
  | { readonly family: "group"; readonly type: "participantRemoved"; readonly participant: SingleServiceAddressInfo }
  | { readonly family: "group"; readonly type: "participantLeft"; readonly participant: SingleServiceAddressInfo }
  | { readonly family: "group"; readonly type: "iconChanged" }
  | { readonly family: "group"; readonly type: "iconRemoved" }
  | { readonly family: "poll"; readonly type: "created"; readonly pollMessageGuid: string; readonly delta: Extract<PollChangeDelta, { readonly type: "created" }> }
  | { readonly family: "poll"; readonly type: "optionAdded"; readonly pollMessageGuid: string; readonly delta: Extract<PollChangeDelta, { readonly type: "optionAdded" }> }
  | { readonly family: "poll"; readonly type: "voted"; readonly pollMessageGuid: string; readonly delta: Extract<PollChangeDelta, { readonly type: "voted" }> }
  | { readonly family: "poll"; readonly type: "unvoted"; readonly pollMessageGuid: string; readonly delta: Extract<PollChangeDelta, { readonly type: "unvoted" }> }
  | { readonly family: "location"; readonly type: "updated"; readonly location: SharedFriendLocation; readonly sourceSequence: string }
  | { readonly family: "catchup"; readonly type: "complete"; readonly headSequence: string };

export type PhotonEventType = PhotonNormalizedEvent["type"];

/** The durable internal envelope written to the inbox for admitted events. */
export interface PhotonEventEnvelope {
  readonly version: typeof ENVELOPE_VERSION;
  /** Provider sequence stored losslessly as a decimal string. */
  readonly sequence: string;
  readonly chatGuid?: string;
  readonly isFromMe?: boolean;
  /** Provider timestamp (ISO) when supplied. */
  readonly occurredAt?: string;
  /** Bell receipt timestamp (ISO). */
  readonly receivedAt: string;
  readonly sourceKind: "live" | "catchup";
  /** Canonical acting handle when the event supplies one (`phone:`/`email:`). */
  readonly actor?: string;
  readonly event: PhotonNormalizedEvent;
}

/** Admission outcome decided by policy before dispatch. */
export type AdmissionDisposition = "admitted" | "state_only" | "denied" | "quarantined" | "tombstone";

export interface AdmissionDecision {
  readonly disposition: AdmissionDisposition;
  /** Machine-readable reason for diagnostics; never contains message bodies. */
  readonly reason: string;
  /** Event family should start/steer an agent turn. */
  readonly dispatchAction: "send" | "respond" | "state_apply" | "none";
  /** Canonical actor when verified; absent actor means state refresh only. */
  readonly actor?: CanonicalHandle;
  /** Conversation scope when determinable. */
  readonly scope?: "direct" | "group";
  /** Whether the event updates membership/audience state before dispatch. */
  readonly updatesMembership?: boolean;
}

/** What the envelope is classified as for recovery accounting. */
export type RecoveryClass = "old_history" | "duplicate" | "live" | "recovered_unresolved";

/* ------------------------------------------------------------------ */
/* Internal dispatch route contract                                    */
/* ------------------------------------------------------------------ */

/** POST /internal/photon/dispatch — bounded request body. */
export const dispatchRequestSchema = z.object({
  inboxId: z.object({
    sourceId: z.string().min(1).max(256),
    logEpoch: z.string().min(1).max(128),
    sequence: z.string().min(1).max(64),
  }).strict(),
  correlationId: z.string().min(8).max(128),
}).strict();
export type PhotonDispatchRequest = z.infer<typeof dispatchRequestSchema>;

/** POST /internal/photon/dispatch — the route's exact response contract. */
export const dispatchResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("dispatched"),
    sessionId: z.string().min(1),
    deliveryId: z.string().optional(),
  }).strict(),
  z.object({
    status: z.literal("duplicate"),
    sessionId: z.string().optional(),
    deliveryId: z.string().optional(),
  }).strict(),
  z.object({ status: z.literal("state_applied") }).strict(),
  z.object({ status: z.literal("rejected"), reason: z.string() }).strict(),
  z.object({ status: z.literal("retryable"), reason: z.string() }).strict(),
]);
export type PhotonDispatchResult = z.infer<typeof dispatchResultSchema>;

/** POST /internal/photon/events — bounded projector read request. */
export const eventsReadRequestSchema = z.object({
  sessionId: z.string().min(1).max(256),
  startIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type PhotonEventsReadRequest = z.infer<typeof eventsReadRequestSchema>;

export interface PhotonEventsReadResult {
  readonly events: readonly unknown[];
  readonly tailIndex: number;
  readonly stranded?: boolean;
}

/** POST /internal/photon/retire — bounded absolute-deadline retirement. */
export const retireRequestSchema = z.object({
  eveSessionId: z.string().min(1).max(256),
  reason: z.string().min(1).max(256),
}).strict();
export type PhotonRetireRequest = z.infer<typeof retireRequestSchema>;
export type PhotonRetireResult =
  | { readonly status: "retired" }
  | { readonly status: "already_retired" }
  | { readonly status: "retryable"; readonly reason: string };

/** GET /internal/photon/health — worker-readiness probe payload. */
export interface PhotonHealthReport {
  readonly ok: boolean;
  readonly worker?: {
    readonly alive: boolean;
    readonly leaseEpoch?: number;
    readonly leaseExpiresAt?: string;
    readonly streams?: Record<string, { readonly lastBeat?: string; readonly ok: boolean }>;
    readonly captureCursor?: string;
    readonly inboxLagSeconds?: number;
    readonly outboxPending?: number;
    readonly ambiguous?: number;
  };
}

/* ------------------------------------------------------------------ */
/* Outbound command catalog                                            */
/* ------------------------------------------------------------------ */

const nonEmpty = z.string().min(1).max(64_000);
const guid = z.string().min(1).max(512);
const address = z.string().min(3).max(320);
const utf16Offset = z.number().int().min(0).max(64_000);

export const replyTargetSchema = z.union([
  guid,
  z.object({ guid, partIndex: z.number().int().min(0).max(255) }).strict(),
]);
export type ReplyTargetInput = z.infer<typeof replyTargetSchema>;

export const textFormatSchema = z.object({
  start: utf16Offset,
  length: z.number().int().min(1).max(64_000),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
}).strict();
export const textEffectSchema = z.object({
  type: z.literal("effect"),
  start: utf16Offset,
  length: z.number().int().min(1).max(64_000),
  effect: z.enum(["big", "small", "shake", "nod", "explode", "ripple", "bloom", "jitter"]),
}).strict();
export const messageEffectSchema = z.enum(["slam", "loud", "gentle", "invisible"]);
export const screenEffectSchema = z.enum([
  "confetti", "fireworks", "balloons", "heart", "lasers", "celebration", "sparkles", "spotlight", "echo",
]);
export const effectSchema = z.union([messageEffectSchema, screenEffectSchema]);

export const backgroundPresetSchema = z.enum([
  "skyDusk", "skyHaze", "skySunset", "skyClear", "skySunrise", "skyDawn",
  "waterLight", "waterDark",
  "auroraGreen", "auroraPurple", "auroraPink",
  "colorMango", "colorIce", "colorPlum", "colorDeepSea", "colorGreenApple",
  "colorCherry", "colorBubblegum", "colorTangerine", "colorMagenta", "colorLime",
  "colorSilver", "colorCarbon", "colorStone",
]);

export const messagePartSchema = z.object({
  text: z.string().max(64_000).optional(),
  mentionedAddress: address.optional(),
  formatting: z.array(z.union([textFormatSchema, textEffectSchema])).optional(),
  attachmentGuid: guid.optional(),
  attachmentName: z.string().max(1024).optional(),
  bubbleIndex: z.number().int().min(0).max(255).optional(),
}).strict();
export type MessagePartInput = z.infer<typeof messagePartSchema>;

export const miniAppLayoutSchema = z.object({
  caption: z.string().max(1024).optional(),
  subcaption: z.string().max(1024).optional(),
  trailingCaption: z.string().max(1024).optional(),
  trailingSubcaption: z.string().max(1024).optional(),
  image: z.string().max(256).optional(),
  imageTitle: z.string().max(1024).optional(),
  imageSubtitle: z.string().max(1024).optional(),
  summary: z.string().max(2048).optional(),
}).strict();
export const customizedMiniAppSchema = z.object({
  appName: z.string().min(1).max(256),
  appStoreId: z.number().int().positive().optional(),
  extensionBundleId: z.string().min(1).max(256).refine((v) => !v.includes(":"), "bundle ID must not contain a colon"),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/, "team ID must be 10 uppercase alphanumeric characters"),
  url: z.url({ protocol: /^https?$/ }),
  layout: miniAppLayoutSchema,
  live: z.boolean().optional(),
}).strict();
export const miniAppCardSessionSchema = z.object({
  chatGuid: guid,
  messageGuid: guid,
  sessionId: z.string().min(1).max(512),
  targetMessageGuid: guid,
}).strict();

export const messageListFilterSchema = z.object({
  after: z.iso.datetime().optional(),
  before: z.iso.datetime().optional(),
  isFromMe: z.boolean().optional(),
  isRead: z.boolean().optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().max(4096).optional(),
}).strict();

export const stickerPlacementSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  scale: z.number().positive().max(10).optional(),
  rotation: z.number().optional(),
  width: z.number().positive().optional(),
}).strict();

export const settableReactionSchema = z.union([
  z.enum(["love", "like", "dislike", "laugh", "emphasize", "question"]),
  z.object({ customEmoji: z.string().min(1).max(64) }).strict(),
]);

/** Every provider operation reachable through the durable command path. */
export const commandArgsSchemas = {
  /* messages */
  "messages.sendText": z.object({
    chat: guid, text: nonEmpty,
    effect: effectSchema.optional(),
    enableDataDetection: z.boolean().optional(),
    enableLinkPreview: z.boolean().optional(),
    formatting: z.array(z.union([textFormatSchema, textEffectSchema])).optional(),
    replyTo: replyTargetSchema.optional(),
    subject: z.string().max(1024).optional(),
  }).strict(),
  "messages.sendAttachment": z.object({
    chat: guid, attachmentGuid: guid,
    effect: effectSchema.optional(),
    isAudioMessage: z.boolean().optional(),
    replyTo: replyTargetSchema.optional(),
  }).strict(),
  "messages.sendMultipart": z.object({
    chat: guid, parts: z.array(messagePartSchema).min(1).max(64),
    effect: effectSchema.optional(),
    replyTo: replyTargetSchema.optional(),
    subject: z.string().max(1024).optional(),
    enableDataDetection: z.boolean().optional(),
  }).strict(),
  "messages.sendCustomizedMiniApp": z.object({
    chat: guid, message: customizedMiniAppSchema,
  }).strict(),
  "messages.updateCustomizedMiniApp": z.object({
    session: miniAppCardSessionSchema, message: customizedMiniAppSchema,
  }).strict(),
  "messages.edit": z.object({
    chat: guid, messageGuid: guid, newText: nonEmpty,
    backwardCompatText: z.string().max(64_000).optional(),
    partIndex: z.number().int().min(0).max(255).optional(),
  }).strict(),
  "messages.unsend": z.object({
    chat: guid, messageGuid: guid,
    partIndex: z.number().int().min(0).max(255).optional(),
  }).strict(),
  "messages.setReaction": z.object({
    chat: guid, messageGuid: guid, reaction: settableReactionSchema, isSet: z.boolean(),
    partIndex: z.number().int().min(0).max(255).optional(),
  }).strict(),
  "messages.placeSticker": z.object({
    chat: guid, messageGuid: guid, stickerAttachmentGuid: guid,
    placement: stickerPlacementSchema,
    partIndex: z.number().int().min(0).max(255).optional(),
  }).strict(),
  "messages.notifySilenced": z.object({ chat: guid, messageGuid: guid }).strict(),
  "messages.get": z.object({ messageGuid: guid }).strict(),
  "messages.listInChat": z.object({ chat: guid, filter: messageListFilterSchema.optional() }).strict(),
  "messages.listRecent": z.object({ filter: messageListFilterSchema.optional() }).strict(),
  "messages.getEmbeddedMedia": z.object({ chat: guid, messageGuid: guid }).strict(),
  /* attachments */
  "attachments.upload": z.object({
    fileName: z.string().min(1).max(1024),
    artifactId: z.string().min(1).max(256),
    companionArtifactId: z.string().min(1).max(256).optional(),
  }).strict(),
  "attachments.get": z.object({ attachmentGuid: guid }).strict(),
  /* chats */
  "chats.create": z.object({
    addresses: z.array(address).min(1).max(100),
    message: z.string().max(64_000).optional(),
    subject: z.string().max(1024).optional(),
    effect: effectSchema.optional(),
  }).strict(),
  "chats.get": z.object({ chat: guid }).strict(),
  "chats.count": z.object({ includeArchived: z.boolean().optional() }).strict(),
  "chats.markRead": z.object({ chat: guid }).strict(),
  "chats.setTyping": z.object({ chat: guid, isTyping: z.boolean() }).strict(),
  "chats.shareContactInfo": z.object({ chat: guid }).strict(),
  "chats.hasBackground": z.object({ chat: guid }).strict(),
  "chats.setBackground": z.object({
    chat: guid,
    preset: backgroundPresetSchema.optional(),
    artifactId: z.string().min(1).max(256).optional(),
  }).strict().refine((v) => (v.preset === undefined) !== (v.artifactId === undefined), {
    message: "exactly one of preset or artifactId is required",
  }),
  "chats.removeBackground": z.object({ chat: guid }).strict(),
  /* groups */
  "groups.setDisplayName": z.object({ chat: guid, name: z.string().min(1).max(1024) }).strict(),
  "groups.addParticipants": z.object({ chat: guid, addresses: z.array(address).min(1).max(100) }).strict(),
  "groups.removeParticipants": z.object({ chat: guid, addresses: z.array(address).min(1).max(100) }).strict(),
  "groups.leave": z.object({ chat: guid }).strict(),
  "groups.setIcon": z.object({ chat: guid, artifactId: z.string().min(1).max(256) }).strict(),
  "groups.getIcon": z.object({ chat: guid }).strict(),
  "groups.removeIcon": z.object({ chat: guid }).strict(),
  /* polls */
  "polls.create": z.object({
    chat: guid, title: z.string().min(1).max(2048),
    choices: z.array(z.string().min(1).max(1024)).min(2).max(100),
  }).strict(),
  "polls.get": z.object({ pollMessageGuid: guid }).strict(),
  "polls.vote": z.object({ pollMessageGuid: guid, optionIdentifier: z.string().min(1).max(512) }).strict(),
  "polls.unvote": z.object({ pollMessageGuid: guid }).strict(),
  "polls.addOption": z.object({ pollMessageGuid: guid, text: z.string().min(1).max(1024) }).strict(),
  /* addresses */
  "addresses.get": z.object({ address }).strict(),
  "addresses.isIMessageAvailable": z.object({ address }).strict(),
  "addresses.isFocusSilenced": z.object({ address }).strict(),
  /* locations */
  "locations.request": z.object({ chat: guid, address }).strict(),
  "locations.list": z.object({}).strict(),
  "locations.get": z.object({ address }).strict(),
  /* Bell-scoped watch control (subscription layer, not a raw RPC passthrough) */
  "locations.watch": z.object({ address: address.optional(), action: z.enum(["start", "stop"]) }).strict(),
} as const;

export type PhotonCommandOp = keyof typeof commandArgsSchemas;
export type PhotonCommandArgs<Op extends PhotonCommandOp> = z.infer<(typeof commandArgsSchemas)[Op]>;

/** Whether the operation has a public `clientMessageId`/idempotency option. */
export const KEYED_OPERATIONS = new Set<PhotonCommandOp>([
  "messages.sendText", "messages.sendAttachment", "messages.sendMultipart",
  "messages.sendCustomizedMiniApp", "messages.updateCustomizedMiniApp",
  "messages.edit", "messages.unsend", "messages.setReaction",
  "messages.placeSticker", "messages.notifySilenced",
  "chats.create",
  "groups.setDisplayName", "groups.addParticipants", "groups.removeParticipants",
  "groups.leave", "groups.setIcon", "groups.removeIcon",
  "polls.create", "polls.vote", "polls.unvote", "polls.addOption",
  "locations.request",
]);

export const READ_OPERATIONS = new Set<PhotonCommandOp>([
  "messages.get", "messages.listInChat", "messages.listRecent", "messages.getEmbeddedMedia",
  "attachments.get",
  "chats.get", "chats.count", "chats.hasBackground",
  "groups.getIcon",
  "polls.get",
  "addresses.get", "addresses.isIMessageAvailable", "addresses.isFocusSilenced",
  "locations.list", "locations.get",
]);

export function isReadOperation(op: PhotonCommandOp): boolean {
  return READ_OPERATIONS.has(op);
}

export function validateCommandArgs<Op extends PhotonCommandOp>(
  op: Op,
  args: unknown,
): PhotonCommandArgs<Op> {
  return commandArgsSchemas[op].parse(args) as PhotonCommandArgs<Op>;
}

/* ------------------------------------------------------------------ */
/* Command result contract                                             */
/* ------------------------------------------------------------------ */

/**
 * The provider upload receipt for one staged artifact. `attachmentGuid` is
 * what message sends, sticker placements, and reaction attachments accept.
 */
export interface PhotonUploadResult {
  readonly attachmentGuid: string;
  readonly transferState: string;
  readonly totalBytes: number;
  readonly companion?: {
    readonly fileName: string;
    readonly mimeType: string;
    readonly totalBytes: number;
  };
}

/**
 * Provider bytes staged into the conversation-scoped artifact store. The
 * command receipt carries the artifact reference and media metadata —
 * never the bytes themselves.
 */
export interface StagedMediaResult {
  readonly artifactId: string;
  readonly mediaType: string;
  readonly byteSize: number;
}

/** A fetched group icon staged into the artifact store. */
export interface GroupIconResult {
  readonly artifactId: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

/** Mini-app card send/update: the card message plus its durable session. */
export interface MiniAppCommandResult {
  readonly message: MiniAppMessageResult;
  readonly miniAppCardSession: MiniAppCardSession;
}

/** Address-record lookup: absent addresses come back as a typed miss. */
export type AddressLookupResult =
  | { readonly found: true; readonly info: MultiServiceAddressInfo }
  | { readonly found: false; readonly address: string };

/** Friend-location lookup: absent locations come back as a typed miss. */
export type LocationLookupResult =
  | { readonly found: true; readonly location: SharedFriendLocation }
  | { readonly found: false; readonly address: string };

/**
 * The canonical executor→tool result contract. `executeOp(op)` emits the
 * shape declared here; `awaitCommandResult(op)` hands the same shape back
 * to the tool layer, so projections read `receipt.result` — never provider
 * fields off the receipt root. Values are JSON-round-tripped provider and
 * artifact projections; bytes never cross this boundary. Command-style
 * writes still acknowledge without a result body when the provider returns
 * none, so every entry also tolerates `undefined`.
 */
export interface PhotonCommandResultMap {
  "messages.sendText": Message;
  "messages.sendAttachment": Message;
  "messages.sendMultipart": Message;
  "messages.sendCustomizedMiniApp": MiniAppCommandResult;
  "messages.updateCustomizedMiniApp": MiniAppCommandResult;
  "messages.edit": Message;
  "messages.unsend": { readonly unsent: true };
  "messages.setReaction": Message;
  "messages.placeSticker": Message;
  "messages.notifySilenced": { readonly notified: true };
  "messages.get": Message;
  "messages.listInChat": MessageListPage;
  "messages.listRecent": MessageListPage;
  "messages.getEmbeddedMedia": StagedMediaResult;
  "attachments.upload": PhotonUploadResult;
  "attachments.get": AttachmentInfo;
  "chats.create": { readonly chat: Chat; readonly initialMessageGuid?: string };
  "chats.get": Chat;
  "chats.count": { readonly count: number };
  "chats.markRead": { readonly marked: true };
  "chats.setTyping": { readonly isTyping: boolean };
  "chats.shareContactInfo": { readonly shared: true };
  "chats.hasBackground": { readonly hasBackground: boolean };
  "chats.setBackground": { readonly set: true };
  "chats.removeBackground": { readonly removed: true };
  "groups.setDisplayName": Chat;
  "groups.addParticipants": Chat;
  "groups.removeParticipants": Chat;
  "groups.leave": { readonly left: true };
  "groups.setIcon": { readonly set: true };
  "groups.getIcon": GroupIconResult | { readonly icon: null };
  "groups.removeIcon": { readonly removed: true };
  "polls.create": Poll;
  "polls.get": Poll;
  "polls.vote": Poll;
  "polls.unvote": Poll;
  "polls.addOption": Poll;
  "addresses.get": AddressLookupResult;
  "addresses.isIMessageAvailable": { readonly address: string; readonly available: boolean };
  "addresses.isFocusSilenced": { readonly address: string; readonly silenced: boolean };
  "locations.request": LocationRequestReceipt;
  "locations.list": { readonly locations: readonly SharedFriendLocation[] };
  "locations.get": LocationLookupResult;
  "locations.watch": { readonly address: string | null; readonly watching: boolean };
}

/** The typed result body one operation's executor emits. */
export type PhotonCommandResult<Op extends PhotonCommandOp> = PhotonCommandResultMap[Op];

/* ------------------------------------------------------------------ */
/* Command ledger                                                      */
/* ------------------------------------------------------------------ */

export type CommandStatus =
  "queued" | "in_flight" | "acknowledged" | "ambiguous" | "failed" | "cancelled" | "expired";

export interface PhotonCommand<Op extends PhotonCommandOp = PhotonCommandOp> {
  readonly commandId: string;
  readonly operation: Op;
  readonly args: PhotonCommandArgs<Op>;
  readonly argsDigest: string;
  readonly initiatorPrincipal?: string;
  readonly audience?: "direct" | "group" | "system";
  readonly sourceId: string;
  readonly chatGuid: string;
  readonly target?: Record<string, unknown>;
  readonly providerKey?: string;
  readonly semanticKey: string;
  readonly dependsOn: readonly string[];
  readonly expiresAt?: string;
}

/** Outcome the command executor returns to the outbox state machine. */
export type CommandExecution<Op extends PhotonCommandOp = PhotonCommandOp> =
  | {
      readonly kind: "acknowledged";
      readonly result?: PhotonCommandResult<Op>;
      readonly providerReceipt?: unknown;
    }
  | { readonly kind: "ambiguous"; readonly reason: string; readonly providerReceipt?: unknown }
  | { readonly kind: "retryable"; readonly errorCode: string; readonly errorDetail?: string; readonly retryAfterMs?: number }
  | { readonly kind: "failed"; readonly errorCode: string; readonly errorDetail?: string };

/** Executor invoked by the worker's outbox loop for one claimed command. */
export type PhotonCommandExecutor<Op extends PhotonCommandOp = PhotonCommandOp> = (
  command: PhotonCommand,
  deps: PhotonCommandDeps,
) => Promise<CommandExecution<Op>>;

/** Narrow dependency surface the command executors are allowed to use. */
export interface PhotonCommandDeps {
  readonly client: {
    sendText(chat: string, text: string, options?: Record<string, unknown>): Promise<unknown>;
    raw: unknown;
  };
  readonly artifacts: {
    get(artifactId: string): Promise<{ data: Uint8Array; fileName?: string; mediaType: string } | undefined>;
    put(input: { chatGuid: string; attachmentGuid?: string; fileName?: string; mediaType: string; data: Uint8Array }): Promise<string>;
  };
  readonly config: { readonly projectId: string };
  readonly now: () => Date;
  readonly signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* Projection: Eve durable event -> outbound commands                  */
/* ------------------------------------------------------------------ */

/** Projected output kinds derived from retained Eve session events. */
export type ProjectedOutputKind =
  | "assistant_text" | "assistant_part" | "input_request" | "authorization"
  | "lifecycle_notice" | "typing" | "read_marker";

export interface ProjectedOutput {
  readonly kind: ProjectedOutputKind;
  readonly semanticKey: string;
  /** Command operation to enqueue, when this projection produces one. */
  readonly operation?: PhotonCommandOp;
  readonly args?: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
}

export type {
  AttachmentInfo,
  Chat,
  CatchUpEvent,
  GroupChange,
  LiveEvent,
  Message,
  MessageListPage,
  Poll,
  SharedFriendLocation,
};
