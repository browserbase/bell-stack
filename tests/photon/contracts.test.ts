/**
 * Contract tests for the frozen Photon foundation: canonical identity,
 * handle normalization, deterministic keys, and strict environment parsing.
 * These exercise the real functions — no mocks — because every other
 * workstream builds on these exact shapes.
 */
import { describe, expect, it } from "vitest";

import {
  E164_PATTERN,
  IMESSAGE_TOKEN_URL,
  PhotonConfigError,
  loadPhotonConfig,
  photonEnabled,
  photonTokenUrl,
} from "../../server/photon/config";
import {
  IDENTITY_VERSION,
  PHOTON_AUTHENTICATOR,
  PHOTON_ISSUER,
  bindingIdFor,
  conversationKey,
  dispatchKeyFor,
  eveAddressFor,
  handleKey,
  isPhotonAuth,
  normalizeHandle,
  photonPrincipalId,
  photonSessionAuth,
  providerKeyFor,
  semanticKeyFor,
  sha256Hex,
  sourceIdFor,
  type CanonicalHandle,
} from "../../server/photon/identity";

const phone = (value = "+12025550123"): CanonicalHandle => ({ kind: "phone", value });
const email = (value = "operator@example.com"): CanonicalHandle => ({ kind: "email", value });

describe("normalizeHandle", () => {
  it("accepts only strict E.164 phone handles", () => {
    expect(normalizeHandle("+12025550123")).toEqual(phone());
    expect(normalizeHandle("  +442071234567  ")).toEqual(phone("+442071234567"));
    for (const junk of [
      "2025550123", "0012025550123", "+1 202 555 0123", "+1202555012x",
      "+0123", "+", "tel:+12025550123", "+1-202-555-0123",
    ]) {
      expect(normalizeHandle(junk), junk).toBeNull();
    }
    // + followed by up to 15 digits, never starting with 0.
    expect(normalizeHandle(`+1${"2".repeat(14)}`)).not.toBeNull();
    expect(normalizeHandle(`+1${"2".repeat(15)}`)).toBeNull();
  });

  it("canonicalizes email handles to lowercase", () => {
    expect(normalizeHandle("Operator@Example.COM")).toEqual(email());
    expect(normalizeHandle("  user+tag@sub.domain.example  ")).toEqual(email("user+tag@sub.domain.example"));
  });

  it("returns null for junk, empty, and absent handles", () => {
    for (const junk of [null, undefined, "", "   ", "not-a-handle", "@", "a@", "a@b", "a@@b.com"]) {
      expect(normalizeHandle(junk), String(junk)).toBeNull();
    }
  });

  it("never merges phone and email handle kinds", () => {
    const sameDigits = "+12025550123";
    const asEmail = "12025550123@example.com";
    const p = normalizeHandle(sameDigits)!;
    const e = normalizeHandle(asEmail)!;
    expect(handleKey(p)).not.toBe(handleKey(e));
    expect(photonPrincipalId("proj", p)).not.toBe(photonPrincipalId("proj", e));
  });
});

describe("photonPrincipalId", () => {
  it("is deterministic for the same versioned tuple", () => {
    const id = photonPrincipalId("proj-1", phone());
    expect(id).toBe(photonPrincipalId("proj-1", phone()));
    expect(id).toMatch(/^photon:[0-9a-f]{64}$/);
    expect(id).toBe(`photon:${sha256Hex(JSON.stringify([IDENTITY_VERSION, "proj-1", "phone", "+12025550123"]))}`);
  });

  it("differs across project, handle kind, and handle value", () => {
    const base = photonPrincipalId("proj-1", phone());
    expect(photonPrincipalId("proj-2", phone())).not.toBe(base);
    expect(photonPrincipalId("proj-1", phone("+12025550199"))).not.toBe(base);
    // A phone number and an email containing the same digits are distinct owners.
    expect(photonPrincipalId("proj-1", email())).not.toBe(base);
  });

  it("excludes the receiving line so one verified handle keeps one wallet owner", () => {
    // The principal tuple has no line component by construction; two source
    // bindings for different lines in one project hash to the same principal.
    const id = photonPrincipalId("proj-1", phone());
    expect(id).toBe(`photon:${sha256Hex(JSON.stringify(["v1", "proj-1", "phone", "+12025550123"]))}`);
  });
});

describe("photonSessionAuth / isPhotonAuth", () => {
  it("stamps the photon authenticator, issuer, subject and principal", () => {
    const auth = photonSessionAuth("proj-1", phone());
    expect(auth.authenticator).toBe(PHOTON_AUTHENTICATOR);
    expect(auth.issuer).toBe(PHOTON_ISSUER);
    expect(auth.principalType).toBe("user");
    expect(auth.principalId).toBe(photonPrincipalId("proj-1", phone()));
    expect(auth.subject).toBe("phone:+12025550123");
    expect(isPhotonAuth(auth)).toBe(true);
    expect(isPhotonAuth({ authenticator: "linq-message", issuer: "linq" })).toBe(false);
    expect(isPhotonAuth({ authenticator: PHOTON_AUTHENTICATOR, issuer: "other" })).toBe(false);
    expect(isPhotonAuth(null)).toBe(false);
  });
});

describe("source / conversation / dispatch identity", () => {
  it("produces stable source and binding identifiers", () => {
    const sourceId = sourceIdFor("proj-1", "inst-1", "+12025550100");
    expect(sourceId).toBe(sourceIdFor("proj-1", "inst-1", "+12025550100"));
    expect(sourceId).toMatch(/^photon-src:[0-9a-f]{64}$/);
    expect(sourceIdFor("proj-1", "inst-2", "+12025550100")).not.toBe(sourceId);

    const bindingId = bindingIdFor(sourceId, "chat-guid-1", 1);
    expect(bindingId).toBe(bindingIdFor(sourceId, "chat-guid-1", 1));
    expect(bindingIdFor(sourceId, "chat-guid-1", 2)).not.toBe(bindingId);
    expect(eveAddressFor(bindingId)).toBe(`photon:${bindingId}`);
    expect(conversationKey(sourceId, "chat-guid-1", 1))
      .toBe(JSON.stringify(["v1", sourceId, "chat-guid-1", 1]));
  });

  it("keeps dispatch keys deterministic and within Eve's 256-character limit", () => {
    const sourceId = sourceIdFor("proj-1", "inst-1", "+12025550100");
    const key = dispatchKeyFor(sourceId, "epoch-1", "42", "send");
    expect(key).toBe(dispatchKeyFor(sourceId, "epoch-1", "42", "send"));
    expect(key.length).toBeLessThanOrEqual(256);
    // A poll vote and its poll produce different keys for the same sequence.
    expect(dispatchKeyFor(sourceId, "epoch-1", "42", "send")).not.toBe(dispatchKeyFor(sourceId, "epoch-1", "42", "respond"));
    // Absurdly long inputs hash down instead of exceeding the limit.
    const longKey = dispatchKeyFor("s".repeat(400), "e".repeat(200), "9".repeat(200), "send");
    expect(longKey.length).toBeLessThanOrEqual(256);
    expect(longKey).toBe(dispatchKeyFor("s".repeat(400), "e".repeat(200), "9".repeat(200), "send"));
  });

  it("produces distinct semantic output keys that never collapse identical text", () => {
    const base = { sessionId: "s1", turnId: "t1", outputKind: "assistant_text" as const };
    const first = semanticKeyFor(base);
    expect(first).toBe(semanticKeyFor(base));
    // Two intentional identical replies in different tasks remain distinct.
    expect(semanticKeyFor({ ...base, turnId: "t2" })).not.toBe(first);
    expect(semanticKeyFor({ ...base, partId: "p1" })).not.toBe(first);
    expect(semanticKeyFor({ ...base, toolCallId: "tc-1" })).not.toBe(first);
    const long = semanticKeyFor({ ...base, commandId: "c".repeat(600) });
    expect(long.length).toBeLessThanOrEqual(512);
    expect(long).toBe(semanticKeyFor({ ...base, commandId: "c".repeat(600) }));
  });

  it("derives provider retry keys per command attempt", () => {
    expect(providerKeyFor("cmd-1", 0)).toBe("bell:cmd-1:0");
    expect(providerKeyFor("cmd-1", 1)).toBe("bell:cmd-1:1");
    expect(providerKeyFor("cmd-2", 0)).not.toBe(providerKeyFor("cmd-1", 0));
  });
});

describe("loadPhotonConfig", () => {
  const enabled: NodeJS.ProcessEnv = { NODE_ENV: "test", BELL_PHOTON_ENABLED: "1" };
  const full: NodeJS.ProcessEnv = {
    ...enabled,
    IMESSAGE_PROJECT_ID: "proj-1",
    IMESSAGE_PROJECT_SECRET: "secret",
    BELL_PHOTON_PHONE_NUMBER: "+12025550100",
    BELL_PHOTON_ALLOWED_SENDERS: "+12025550123",
    BELL_PHOTON_ALLOWED_EMAIL_SENDERS: "operator@example.com",
    BELL_PHOTON_ALLOWED_GROUPS: "iMessage;+;chat001",
    BELL_PHOTON_INTERNAL_SECRET: "a".repeat(32),
    BELL_PHOTON_INTERNAL_ORIGIN: "http://127.0.0.1:4274",
    DATABASE_URL: "postgres://db.invalid/bell",
  };

  it("returns null whenever the channel is disabled", () => {
    for (const value of [undefined, "", "0", "false", "no", "TRUE-but-not"]) {
      expect(photonEnabled({ ...enabled, BELL_PHOTON_ENABLED: value }), String(value)).toBe(false);
      expect(loadPhotonConfig({ ...enabled, BELL_PHOTON_ENABLED: value })).toBeNull();
    }
    for (const value of ["1", "true", "yes"]) {
      expect(photonEnabled({ ...enabled, BELL_PHOTON_ENABLED: value }), value).toBe(true);
    }
  });

  it("parses a complete environment into a typed config", () => {
    const config = loadPhotonConfig(full);
    expect(config).not.toBeNull();
    expect(config!.projectId).toBe("proj-1");
    expect(config!.phoneNumber).toBe("+12025550100");
    expect(config!.allowedSenders).toEqual(["+12025550123"]);
    expect(config!.allowedEmailSenders).toEqual(["operator@example.com"]);
    expect(config!.allowedGroups).toEqual(["iMessage;+;chat001"]);
    expect(config!.internalOrigin).toBe("http://127.0.0.1:4274");
    expect(config!.worker.maxArtifactBytes).toBe(24 * 1024 * 1024);
  });

  it.each([
    "IMESSAGE_PROJECT_ID",
    "IMESSAGE_PROJECT_SECRET",
    "BELL_PHOTON_PHONE_NUMBER",
    "BELL_PHOTON_ALLOWED_SENDERS",
    "BELL_PHOTON_INTERNAL_SECRET",
    "BELL_PHOTON_INTERNAL_ORIGIN",
    "DATABASE_URL",
  ])("fails closed naming the missing variable %s", (name) => {
    const env = { ...full, [name]: undefined };
    try {
      loadPhotonConfig(env);
      expect.unreachable(`loadPhotonConfig accepted missing ${name}`);
    } catch (error) {
      expect(error).toBeInstanceOf(PhotonConfigError);
      expect((error as PhotonConfigError).setting).toBe(name);
      expect((error as Error).message).toContain(name);
    }
  });

  it("requires a nonempty E.164 sender allowlist and dedicated line", () => {
    for (const [name, value] of [
      ["BELL_PHOTON_PHONE_NUMBER", "2025550100"],
      ["BELL_PHOTON_PHONE_NUMBER", "tel:+12025550100"],
      ["BELL_PHOTON_ALLOWED_SENDERS", ""],
      ["BELL_PHOTON_ALLOWED_SENDERS", "+12025550123,bad-number"],
      ["BELL_PHOTON_ALLOWED_EMAIL_SENDERS", "not-an-email"],
    ] as const) {
      expect(() => loadPhotonConfig({ ...full, [name]: value }), `${name}=${value}`)
        .toThrowError(PhotonConfigError);
    }
    // Email senders remain optional; an empty value denies email-origin input.
    expect(loadPhotonConfig({ ...full, BELL_PHOTON_ALLOWED_EMAIL_SENDERS: "" })!.allowedEmailSenders).toEqual([]);
  });

  it("deduplicates allowlists and trims entries", () => {
    const config = loadPhotonConfig({
      ...full,
      BELL_PHOTON_ALLOWED_SENDERS: " +12025550123 , +12025550123 ,+12025550124 ",
      BELL_PHOTON_ALLOWED_GROUPS: " g1 , g1, g2 ",
    });
    expect(config!.allowedSenders).toEqual(["+12025550123", "+12025550124"]);
    expect(config!.allowedGroups).toEqual(["g1", "g2"]);
  });

  it("requires an internal secret of at least 32 bytes, never a provider token reuse", () => {
    expect(() => loadPhotonConfig({ ...full, BELL_PHOTON_INTERNAL_SECRET: "short" }))
      .toThrowError(/BELL_PHOTON_INTERNAL_SECRET/);
    expect(loadPhotonConfig({ ...full, BELL_PHOTON_INTERNAL_SECRET: "x".repeat(32) })!.internalSecret).toBe("x".repeat(32));
  });

  it("accepts only bare http(s) origins for the private dispatch origin", () => {
    for (const origin of [
      "not-a-url",
      "ftp://127.0.0.1",
      "http://127.0.0.1:4274/path",
      "http://127.0.0.1:4274/?q=1",
      "http://user:pass@127.0.0.1:4274",
      "http://127.0.0.1:4274#frag",
    ]) {
      expect(() => loadPhotonConfig({ ...full, BELL_PHOTON_INTERNAL_ORIGIN: origin }), origin)
        .toThrowError(PhotonConfigError);
    }
    expect(loadPhotonConfig({ ...full, BELL_PHOTON_INTERNAL_ORIGIN: "http://localhost:4274/" })!.internalOrigin)
      .toBe("http://localhost:4274");
  });

  it("bounds worker tuning knobs", () => {
    expect(() => loadPhotonConfig({ ...full, BELL_PHOTON_LEASE_MS: "100" })).toThrowError(/BELL_PHOTON_LEASE_MS/);
    expect(() => loadPhotonConfig({ ...full, BELL_PHOTON_LEASE_MS: "999999" })).toThrowError(/BELL_PHOTON_LEASE_MS/);
    expect(() => loadPhotonConfig({ ...full, BELL_PHOTON_MAX_ARTIFACT_BYTES: "10" })).toThrowError(/BELL_PHOTON_MAX_ARTIFACT_BYTES/);
    expect(() => loadPhotonConfig({ ...full, BELL_PHOTON_COMMAND_BATCH: "500" })).toThrowError(/BELL_PHOTON_COMMAND_BATCH/);
    const tuned = loadPhotonConfig({ ...full, BELL_PHOTON_LEASE_MS: "60000", BELL_PHOTON_COMMAND_BATCH: "40" });
    expect(tuned!.worker.leaseMs).toBe(60_000);
    expect(tuned!.worker.commandBatchSize).toBe(40);
  });
});

describe("photonTokenUrl", () => {
  it("interpolates only a well-formed project id", () => {
    expect(photonTokenUrl("proj-1_ABC")).toBe(IMESSAGE_TOKEN_URL.replace("{projectId}", "proj-1_ABC"));
    for (const bad of ["", "a/b", "../x", "a?b", "p".repeat(129), "space id"]) {
      expect(() => photonTokenUrl(bad), bad).toThrowError(PhotonConfigError);
    }
  });
});

describe("E164_PATTERN", () => {
  it("matches the documented strict pattern", () => {
    expect(E164_PATTERN.test("+12025550123")).toBe(true);
    expect(E164_PATTERN.test("+1202555012")).toBe(true);
    expect(E164_PATTERN.test("+02025550123")).toBe(false);
    expect(E164_PATTERN.test("+1234567890123456")).toBe(false);
  });
});
