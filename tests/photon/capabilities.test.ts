/**
 * Capability contract: every provider operation reachable through the durable
 * command path validates its arguments with the shared zod schemas. Covers the
 * PRD §10 inventory — the 50-method SDK surface is exposed as 44 enqueueable
 * command ops; the remaining six are streaming/lifecycle methods consumed by
 * the transport worker, never queued as commands.
 */
import { describe, expect, it } from "vitest";

import {
  KEYED_OPERATIONS,
  READ_OPERATIONS,
  commandArgsSchemas,
  isReadOperation,
  validateCommandArgs,
  type PhotonCommandOp,
} from "../../server/photon/contracts";

const GUID = "iMessage;-;+12025550123";
const MSG = "msg-guid-0001";
const ATT = "att-guid-0001";
const POLL = "poll-msg-guid-0001";
const ADDR = "+12025550123";
const ART = "art:abc123";

/** The complete command catalog, grouped like the SDK resource surface. */
const EXPECTED_OPERATIONS = [
  /* messages — M01..M10 mutations + M11..M14 reads (M15 subscribes, worker-only) */
  "messages.sendText", "messages.sendAttachment", "messages.sendMultipart",
  "messages.sendCustomizedMiniApp", "messages.updateCustomizedMiniApp",
  "messages.edit", "messages.unsend", "messages.setReaction",
  "messages.placeSticker", "messages.notifySilenced",
  "messages.get", "messages.listInChat", "messages.listRecent", "messages.getEmbeddedMedia",
  /* attachments — A01 upload + A02 read (A03 downloadStream is a worker stream) */
  "attachments.upload", "attachments.get",
  /* chats — C01..C09 (C10 subscribes, worker-only) */
  "chats.create", "chats.get", "chats.count", "chats.markRead", "chats.setTyping",
  "chats.shareContactInfo", "chats.hasBackground", "chats.setBackground", "chats.removeBackground",
  /* groups — G01..G07 (G08 subscribes, worker-only) */
  "groups.setDisplayName", "groups.addParticipants", "groups.removeParticipants",
  "groups.leave", "groups.setIcon", "groups.getIcon", "groups.removeIcon",
  /* polls — P01..P05 (P06 subscribes, worker-only) */
  "polls.create", "polls.get", "polls.vote", "polls.unvote", "polls.addOption",
  /* addresses — D01..D03 */
  "addresses.get", "addresses.isIMessageAvailable", "addresses.isFocusSilenced",
  /* locations — L01..L03 + Bell-scoped watch control for L04 */
  "locations.request", "locations.list", "locations.get", "locations.watch",
].sort() as readonly PhotonCommandOp[];

const MINI_APP = {
  appName: "Bell Cards",
  extensionBundleId: "com.bell.cards.extension",
  teamId: "ABCDE12345",
  url: "https://bell.example/cards/1",
  layout: { caption: "Your card is ready" },
} as const;

const MINI_APP_SESSION = {
  chatGuid: GUID,
  messageGuid: MSG,
  sessionId: "session-uuid-1",
  targetMessageGuid: "target-guid-1",
} as const;

/** One positive argument fixture per operation. */
const POSITIVE: Record<PhotonCommandOp, unknown> = {
  "messages.sendText": { chat: GUID, text: "On it — opening Best Buy now." },
  "messages.sendAttachment": { chat: GUID, attachmentGuid: ATT },
  "messages.sendMultipart": { chat: GUID, parts: [{ text: "first bubble" }, { attachmentGuid: ATT }] },
  "messages.sendCustomizedMiniApp": { chat: GUID, message: MINI_APP },
  "messages.updateCustomizedMiniApp": { session: MINI_APP_SESSION, message: MINI_APP },
  "messages.edit": { chat: GUID, messageGuid: MSG, newText: "corrected text" },
  "messages.unsend": { chat: GUID, messageGuid: MSG },
  "messages.setReaction": { chat: GUID, messageGuid: MSG, reaction: "love", isSet: true },
  "messages.placeSticker": { chat: GUID, messageGuid: MSG, stickerAttachmentGuid: ATT, placement: { x: 0.5, y: 0.5 } },
  "messages.notifySilenced": { chat: GUID, messageGuid: MSG },
  "messages.get": { messageGuid: MSG },
  "messages.listInChat": { chat: GUID },
  "messages.listRecent": {},
  "messages.getEmbeddedMedia": { chat: GUID, messageGuid: MSG },
  "attachments.upload": { fileName: "photo.png", artifactId: ART },
  "attachments.get": { attachmentGuid: ATT },
  "chats.create": { addresses: [ADDR] },
  "chats.get": { chat: GUID },
  "chats.count": {},
  "chats.markRead": { chat: GUID },
  "chats.setTyping": { chat: GUID, isTyping: true },
  "chats.shareContactInfo": { chat: GUID },
  "chats.hasBackground": { chat: GUID },
  "chats.setBackground": { chat: GUID, preset: "skyDusk" },
  "chats.removeBackground": { chat: GUID },
  "groups.setDisplayName": { chat: GUID, name: "Weekend crew" },
  "groups.addParticipants": { chat: GUID, addresses: [ADDR] },
  "groups.removeParticipants": { chat: GUID, addresses: [ADDR] },
  "groups.leave": { chat: GUID },
  "groups.setIcon": { chat: GUID, artifactId: ART },
  "groups.getIcon": { chat: GUID },
  "groups.removeIcon": { chat: GUID },
  "polls.create": { chat: GUID, title: "Dinner tonight?", choices: ["Sushi", "Pizza"] },
  "polls.get": { pollMessageGuid: POLL },
  "polls.vote": { pollMessageGuid: POLL, optionIdentifier: "opt-aaaa" },
  "polls.unvote": { pollMessageGuid: POLL },
  "polls.addOption": { pollMessageGuid: POLL, text: "Tacos" },
  "addresses.get": { address: ADDR },
  "addresses.isIMessageAvailable": { address: ADDR },
  "addresses.isFocusSilenced": { address: ADDR },
  "locations.request": { chat: GUID, address: ADDR },
  "locations.list": {},
  "locations.get": { address: ADDR },
  "locations.watch": { action: "start" },
};

describe("command catalog completeness", () => {
  it("covers exactly the 44 enqueueable ops from the 50-method inventory", () => {
    const keys = Object.keys(commandArgsSchemas).sort();
    // Snapshot the entire key list so a silently dropped or invented op fails.
    expect(keys).toEqual(EXPECTED_OPERATIONS);
    expect(keys).toHaveLength(44);
  });

  it("classifies every op as keyed, read, or unkeyed mutation without overlap", () => {
    for (const op of EXPECTED_OPERATIONS) {
      const keyed = KEYED_OPERATIONS.has(op);
      const read = READ_OPERATIONS.has(op);
      expect(keyed && read, `${op} cannot be both keyed and read`).toBe(false);
    }
    // PRD §10: 15 read methods are all represented as commands.
    expect(READ_OPERATIONS.size).toBe(15);
    expect(KEYED_OPERATIONS.size).toBe(22);
    expect(isReadOperation("messages.get")).toBe(true);
    expect(isReadOperation("messages.sendText")).toBe(false);
  });

  it.each(EXPECTED_OPERATIONS)("accepts a valid argument payload for %s", (op) => {
    expect(() => validateCommandArgs(op, POSITIVE[op])).not.toThrow();
  });
});

describe("text and message validation", () => {
  it("rejects empty and whitespace-broken text", () => {
    expect(() => validateCommandArgs("messages.sendText", { chat: GUID, text: "" })).toThrow();
    expect(() => validateCommandArgs("messages.sendText", { chat: GUID })).toThrow();
  });

  it("accepts non-ASCII text and every documented effect", () => {
    expect(validateCommandArgs("messages.sendText", { chat: GUID, text: "Réponds 🥖 テスト" }).text)
      .toBe("Réponds 🥖 テスト");
    for (const effect of ["slam", "loud", "gentle", "invisible",
      "confetti", "fireworks", "balloons", "heart", "lasers", "celebration", "sparkles", "spotlight", "echo"]) {
      expect(() => validateCommandArgs("messages.sendText", { chat: GUID, text: "x", effect }), effect).not.toThrow();
    }
    expect(() => validateCommandArgs("messages.sendText", { chat: GUID, text: "x", effect: "confetti-explosion" }))
      .toThrow();
  });

  it("validates all eight text effects inside formatting ranges", () => {
    for (const effect of ["big", "small", "shake", "nod", "explode", "ripple", "bloom", "jitter"]) {
      const args = { chat: GUID, text: "hello", formatting: [{ type: "effect", start: 0, length: 5, effect }] };
      expect(() => validateCommandArgs("messages.sendText", args), effect).not.toThrow();
    }
    expect(() => validateCommandArgs("messages.sendText", {
      chat: GUID, text: "hello", formatting: [{ type: "effect", start: 0, length: 5, effect: "firework" }],
    })).toThrow();
  });

  it("enforces UTF-16 offset bounds and positive range lengths", () => {
    const formatting = [{ type: "bold", start: -1, length: 5 }];
    expect(() => validateCommandArgs("messages.sendText", { chat: GUID, text: "x", formatting })).toThrow();
    expect(() => validateCommandArgs("messages.sendText", {
      chat: GUID, text: "x", formatting: [{ type: "bold", start: 0, length: 0 }],
    })).toThrow();
  });

  it("accepts reply targets as guid or {guid,partIndex} with partIndex bounds", () => {
    for (const replyTo of [MSG, { guid: MSG, partIndex: 0 }, { guid: MSG, partIndex: 2 }]) {
      expect(() => validateCommandArgs("messages.sendText", { chat: GUID, text: "x", replyTo })).not.toThrow();
    }
    // Object form requires partIndex — a bare {guid} object is not a valid reply target.
    expect(() => validateCommandArgs("messages.sendText", { chat: GUID, text: "x", replyTo: { guid: MSG } })).toThrow();
    expect(() => validateCommandArgs("messages.sendText", { chat: GUID, text: "x", replyTo: { guid: MSG, partIndex: -1 } })).toThrow();
    expect(() => validateCommandArgs("messages.sendText", { chat: GUID, text: "x", replyTo: { guid: MSG, partIndex: 256 } })).toThrow();
  });

  it("bounds edit/unsend/reaction/sticker partIndex to a byte", () => {
    for (const op of ["messages.edit", "messages.unsend", "messages.setReaction", "messages.placeSticker"] as const) {
      const base = { chat: GUID, messageGuid: MSG, partIndex: 300 };
      expect(() => validateCommandArgs(op, { ...base, ...(op === "messages.edit" ? { newText: "t" } : {}),
        ...(op === "messages.setReaction" ? { reaction: "like", isSet: true } : {}),
        ...(op === "messages.placeSticker" ? { stickerAttachmentGuid: ATT, placement: { x: 0.1, y: 0.1 } } : {}),
      } as never), op).toThrow();
    }
    expect(validateCommandArgs("messages.edit", { chat: GUID, messageGuid: MSG, newText: "t", partIndex: 0 }).partIndex).toBe(0);
  });

  it("limits reactions to six tapbacks or a custom emoji", () => {
    for (const reaction of ["love", "like", "dislike", "laugh", "emphasize", "question"]) {
      expect(() => validateCommandArgs("messages.setReaction", { chat: GUID, messageGuid: MSG, reaction, isSet: false }), String(reaction)).not.toThrow();
    }
    expect(() => validateCommandArgs("messages.setReaction", { chat: GUID, messageGuid: MSG, reaction: { customEmoji: "🎃" }, isSet: true })).not.toThrow();
    expect(() => validateCommandArgs("messages.setReaction", { chat: GUID, messageGuid: MSG, reaction: "thumbsup", isSet: true })).toThrow();
    expect(() => validateCommandArgs("messages.setReaction", { chat: GUID, messageGuid: MSG, reaction: { customEmoji: "" }, isSet: true })).toThrow();
  });

  it("requires normalized sticker placement coordinates", () => {
    const base = { chat: GUID, messageGuid: MSG, stickerAttachmentGuid: ATT };
    expect(() => validateCommandArgs("messages.placeSticker", { ...base, placement: { x: -0.1, y: 0.5 } })).toThrow();
    expect(() => validateCommandArgs("messages.placeSticker", { ...base, placement: { x: 0.5, y: 1.1 } })).toThrow();
    expect(() => validateCommandArgs("messages.placeSticker", { ...base, placement: { x: 0.5, y: 0.5, scale: 1.5, rotation: 0.4, width: 120 } })).not.toThrow();
  });

  it("requires nonempty multipart parts without collapsing ordering", () => {
    expect(() => validateCommandArgs("messages.sendMultipart", { chat: GUID, parts: [] })).toThrow();
    expect(() => validateCommandArgs("messages.sendMultipart", { chat: GUID, parts: new Array(65).fill({ text: "x" }) })).toThrow();
    expect(validateCommandArgs("messages.sendMultipart", {
      chat: GUID, parts: [{ text: "a", bubbleIndex: 0 }, { text: "@dana", mentionedAddress: ADDR }, { attachmentGuid: ATT }],
    }).parts).toHaveLength(3);
  });

  it("scopes history reads to the documented filter surface", () => {
    expect(validateCommandArgs("messages.listInChat", { chat: GUID, filter: { pageSize: 100, isFromMe: false } }).filter!.pageSize).toBe(100);
    expect(() => validateCommandArgs("messages.listInChat", { chat: GUID, filter: { pageSize: 0 } })).toThrow();
    expect(() => validateCommandArgs("messages.listInChat", { chat: GUID, filter: { pageSize: 101 } })).toThrow();
    // listRecent has no chatGuid — the SDK type forbids it; strict schema rejects it too.
    expect(() => validateCommandArgs("messages.listRecent", { filter: { chatGuid: GUID } })).toThrow();
  });
});

describe("mini-app card validation", () => {
  it("enforces the 10-character uppercase team id and colon-free bundle id", () => {
    for (const teamId of ["abcde12345", "ABCDE1234", "ABCDE123456", "ABCDE1234-", "ABCDE 1234"]) {
      expect(() => validateCommandArgs("messages.sendCustomizedMiniApp", { chat: GUID, message: { ...MINI_APP, teamId } }), teamId).toThrow();
    }
    expect(() => validateCommandArgs("messages.sendCustomizedMiniApp", {
      chat: GUID, message: { ...MINI_APP, extensionBundleId: "com.bell:bad" },
    })).toThrow();
  });

  it("requires an absolute http(s) card url", () => {
    for (const url of ["not-a-url", "ftp://x", "javascript:alert(1)", "bell.example/cards"]) {
      expect(() => validateCommandArgs("messages.sendCustomizedMiniApp", { chat: GUID, message: { ...MINI_APP, url } }), url).toThrow();
    }
    expect(validateCommandArgs("messages.sendCustomizedMiniApp", { chat: GUID, message: { ...MINI_APP, url: "http://127.0.0.1:4320/c" } }).message.url)
      .toBe("http://127.0.0.1:4320/c");
  });

  it("accepts appStoreId only as a positive integer and layout as structured slots", () => {
    expect(() => validateCommandArgs("messages.sendCustomizedMiniApp", { chat: GUID, message: { ...MINI_APP, appStoreId: -1 } })).toThrow();
    expect(() => validateCommandArgs("messages.sendCustomizedMiniApp", { chat: GUID, message: { ...MINI_APP, appStoreId: 1.5 } })).toThrow();
    expect(() => validateCommandArgs("messages.sendCustomizedMiniApp", { chat: GUID, message: { ...MINI_APP, appStoreId: 6448314669 } })).not.toThrow();
    expect(() => validateCommandArgs("messages.sendCustomizedMiniApp", { chat: GUID, message: { ...MINI_APP, replyTo: MSG } })).toThrow();
  });

  it("rejects an incomplete card session for updates", () => {
    for (const session of [{}, { chatGuid: GUID }, { ...MINI_APP_SESSION, sessionId: "" }]) {
      expect(() => validateCommandArgs("messages.updateCustomizedMiniApp", { session, message: MINI_APP })).toThrow();
    }
  });
});

describe("attachment, chat, group validation", () => {
  it("requires artifact references instead of raw bytes or paths", () => {
    expect(() => validateCommandArgs("attachments.upload", { fileName: "x.png", data: "AAAA" })).toThrow();
    expect(() => validateCommandArgs("attachments.upload", { fileName: "", artifactId: ART })).toThrow();
    expect(() => validateCommandArgs("attachments.upload", { fileName: "../etc/passwd" })).toThrow();
    expect(validateCommandArgs("attachments.upload", { fileName: "p.png", artifactId: ART, companionArtifactId: `${ART}-c` }).companionArtifactId)
      .toBe("art:abc123-c");
  });

  it("requires exactly one of preset or artifactId for setBackground", () => {
    expect(() => validateCommandArgs("chats.setBackground", { chat: GUID })).toThrow(/exactly one/);
    expect(() => validateCommandArgs("chats.setBackground", { chat: GUID, preset: "skyDusk", artifactId: ART })).toThrow(/exactly one/);
    for (const preset of ["skyDusk", "skyHaze", "skySunset", "skyClear", "skySunrise", "skyDawn",
      "waterLight", "waterDark", "auroraGreen", "auroraPurple", "auroraPink",
      "colorMango", "colorIce", "colorPlum", "colorDeepSea", "colorGreenApple", "colorCherry",
      "colorBubblegum", "colorTangerine", "colorMagenta", "colorLime", "colorSilver", "colorCarbon", "colorStone"]) {
      expect(() => validateCommandArgs("chats.setBackground", { chat: GUID, preset }), preset).not.toThrow();
    }
    expect(() => validateCommandArgs("chats.setBackground", { chat: GUID, preset: "rainbow" })).toThrow();
  });

  it("bounds chat create addresses and rejects empty name/address lists", () => {
    expect(() => validateCommandArgs("chats.create", { addresses: [] })).toThrow();
    expect(() => validateCommandArgs("chats.create", { addresses: new Array(101).fill(ADDR) })).toThrow();
    expect(() => validateCommandArgs("chats.create", { addresses: ["ab"] })).toThrow();
    expect(() => validateCommandArgs("groups.setDisplayName", { chat: GUID, name: "" })).toThrow();
    expect(() => validateCommandArgs("groups.addParticipants", { chat: GUID, addresses: [] })).toThrow();
    expect(() => validateCommandArgs("groups.setIcon", { chat: GUID })).toThrow();
  });
});

describe("poll, address, and location validation", () => {
  it("requires a nonempty title and two to one hundred nonempty choices", () => {
    expect(() => validateCommandArgs("polls.create", { chat: GUID, title: "", choices: ["a", "b"] })).toThrow();
    expect(() => validateCommandArgs("polls.create", { chat: GUID, title: "t", choices: ["only"] })).toThrow();
    expect(() => validateCommandArgs("polls.create", { chat: GUID, title: "t", choices: ["a", ""] })).toThrow();
    expect(() => validateCommandArgs("polls.create", { chat: GUID, title: "t", choices: new Array(101).fill("x") })).toThrow();
    expect(validateCommandArgs("polls.create", { chat: GUID, title: "t", choices: new Array(100).fill("x") }).choices).toHaveLength(100);
  });

  it("votes by optionIdentifier — never by label or position", () => {
    expect(() => validateCommandArgs("polls.vote", { pollMessageGuid: POLL, optionIdentifier: "" })).toThrow();
    expect(() => validateCommandArgs("polls.vote", { pollMessageGuid: POLL, option: 0 })).toThrow();
    expect(() => validateCommandArgs("polls.vote", { pollMessageGuid: POLL, optionIdentifier: "Sushi 🍣" })).not.toThrow();
    expect(() => validateCommandArgs("polls.addOption", { pollMessageGuid: POLL, text: "" })).toThrow();
  });

  it("applies E.164-ish address bounds across address and location ops", () => {
    for (const op of ["addresses.get", "addresses.isIMessageAvailable", "addresses.isFocusSilenced", "locations.get"] as const) {
      expect(() => validateCommandArgs(op, { address: "x" }), op).toThrow();
      expect(() => validateCommandArgs(op, { address: `+${"1".repeat(400)}` }), op).toThrow();
    }
    expect(() => validateCommandArgs("locations.request", { chat: GUID, address: "x" })).toThrow();
  });

  it("keeps locations.watch a scoped start/stop control, not a raw stream", () => {
    expect(validateCommandArgs("locations.watch", { action: "start" })).toEqual({ action: "start" });
    expect(validateCommandArgs("locations.watch", { action: "stop", address: ADDR }).action).toBe("stop");
    expect(() => validateCommandArgs("locations.watch", { action: "pause" })).toThrow();
    expect(() => validateCommandArgs("locations.watch", {})).toThrow();
  });
});
