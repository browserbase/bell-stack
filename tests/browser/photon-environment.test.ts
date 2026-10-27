/**
 * Photon channel environment contract. The Advanced gRPC channel parses only
 * `BELL_PHOTON_*`/`IMESSAGE_*`/`DATABASE_URL` settings and fails closed with
 * the variable named when the environment cannot produce a safe configuration.
 */
import { describe, expect, it } from "vitest";

import {
  PhotonConfigError,
  loadPhotonConfig,
  photonEnabled,
  photonTokenUrl,
} from "../../server/photon/config";

const VALID: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  BELL_PHOTON_ENABLED: "1",
  IMESSAGE_PROJECT_ID: "proj-live",
  IMESSAGE_PROJECT_SECRET: "project-secret-value",
  BELL_PHOTON_PHONE_NUMBER: "+12025550100",
  BELL_PHOTON_ALLOWED_SENDERS: "+12025550123,+12025550124",
  BELL_PHOTON_ALLOWED_EMAIL_SENDERS: "operator@example.com",
  BELL_PHOTON_ALLOWED_GROUPS: "iMessage;+;chat000000000000000001",
  BELL_PHOTON_INTERNAL_SECRET: "internal-secret-32-bytes-minimum!!",
  BELL_PHOTON_INTERNAL_ORIGIN: "http://127.0.0.1:4274",
  DATABASE_URL: "postgres://db.internal:5432/bell",
  BELL_PUBLIC_URL: "https://bell.example",
};

describe("Photon channel environment", () => {
  it("parses every BELL_PHOTON_* and IMESSAGE_* setting when enabled", () => {
    const config = loadPhotonConfig(VALID);
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      projectId: "proj-live",
      projectSecret: "project-secret-value",
      phoneNumber: "+12025550100",
      allowedSenders: ["+12025550123", "+12025550124"],
      allowedEmailSenders: ["operator@example.com"],
      allowedGroups: ["iMessage;+;chat000000000000000001"],
      internalOrigin: "http://127.0.0.1:4274",
      databaseUrl: "postgres://db.internal:5432/bell",
      publicUrl: "https://bell.example",
    });
  });

  it("ignores unrelated provider credentials and receiving numbers", () => {
    const env = { ...VALID };
    expect(loadPhotonConfig(env)).not.toBeNull();
    // Stray retired variables are ignored, never consulted for identity.
    const withUnrelatedProvider = { ...VALID, LEGACY_API_KEY: "dead", LEGACY_WEBHOOK_SECRET: "dead", BELL_LEGACY_PHONE_NUMBER: "+1999" };
    const config = loadPhotonConfig(withUnrelatedProvider);
    expect(config!.phoneNumber).toBe("+12025550100");
    expect(config).toEqual(loadPhotonConfig(env));
  });

  it("returns null when disabled so builds run without provider credentials", () => {
    expect(loadPhotonConfig({ ...VALID, BELL_PHOTON_ENABLED: "false" })).toBeNull();
    expect(loadPhotonConfig({ NODE_ENV: "test" })).toBeNull();
    expect(photonEnabled(VALID)).toBe(true);
  });

  it("requires the dedicated receiving number in strict E.164", () => {
    expect(() => loadPhotonConfig({ ...VALID, BELL_PHOTON_PHONE_NUMBER: "12025550100" }))
      .toThrowError(PhotonConfigError);
    expect(() => loadPhotonConfig({ ...VALID, BELL_PHOTON_PHONE_NUMBER: "" }))
      .toThrowError(/BELL_PHOTON_PHONE_NUMBER/);
  });

  it("requires a nonempty E.164 sender allowlist for private mode", () => {
    expect(() => loadPhotonConfig({ ...VALID, BELL_PHOTON_ALLOWED_SENDERS: "" }))
      .toThrowError(/BELL_PHOTON_ALLOWED_SENDERS/);
    expect(() => loadPhotonConfig({ ...VALID, BELL_PHOTON_ALLOWED_SENDERS: "+12025550123,not-e164" }))
      .toThrowError(PhotonConfigError);
  });

  it("parses the explicit group allowlist — empty keeps group ingress closed", () => {
    expect(loadPhotonConfig({ ...VALID, BELL_PHOTON_ALLOWED_GROUPS: "" })!.allowedGroups).toEqual([]);
    expect(loadPhotonConfig({ ...VALID, BELL_PHOTON_ALLOWED_GROUPS: " g1 , g2 " })!.allowedGroups)
      .toEqual(["g1", "g2"]);
  });

  it("rejects a short internal secret and a non-bare private origin", () => {
    expect(() => loadPhotonConfig({ ...VALID, BELL_PHOTON_INTERNAL_SECRET: "too-short" }))
      .toThrowError(/BELL_PHOTON_INTERNAL_SECRET/);
    expect(loadPhotonConfig({ ...VALID, BELL_PHOTON_INTERNAL_SECRET: "s".repeat(32) })).not.toBeNull();
    expect(() => loadPhotonConfig({ ...VALID, BELL_PHOTON_INTERNAL_ORIGIN: "http://127.0.0.1:4274/eve/v1" }))
      .toThrowError(PhotonConfigError);
    expect(() => loadPhotonConfig({ ...VALID, BELL_PHOTON_INTERNAL_ORIGIN: "https://public.example:443" }))
      .not.toThrow();
  });

  it("builds the Stable token URL from the project id only", () => {
    expect(photonTokenUrl("proj-live"))
      .toBe("https://spectrum.photon.codes/projects/proj-live/imessage/tokens");
    expect(() => photonTokenUrl("../escape")).toThrowError(PhotonConfigError);
  });
});
