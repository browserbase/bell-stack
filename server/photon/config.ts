import { z } from "zod";

export const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
export const IMESSAGE_TOKEN_URL =
  "https://spectrum.photon.codes/projects/{projectId}/imessage/tokens";
export const PHOTON_DISPATCH_PATH = "/internal/photon/dispatch";
export const PHOTON_EVENTS_PATH = "/internal/photon/events";
export const PHOTON_HEALTH_PATH = "/internal/photon/health";
export const PHOTON_RETIRE_PATH = "/internal/photon/retire";

export class PhotonConfigError extends Error {
  readonly setting: string;
  constructor(setting: string, message: string) {
    super(`${setting}: ${message}`);
    this.name = "PhotonConfigError";
    this.setting = setting;
  }
}

export interface PhotonConfig {
  /** Stable Cloud project identifier (IMESSAGE_PROJECT_ID). */
  readonly projectId: string;
  /** Stable Cloud project credential, server-only (IMESSAGE_PROJECT_SECRET). */
  readonly projectSecret: string;
  /** Exact configured dedicated receiving number in E.164. */
  readonly phoneNumber: string;
  /** Nonempty E.164 allowlist for private-operator mode. */
  readonly allowedSenders: readonly string[];
  /** Separately configured iMessage email handles; empty denies email-origin input. */
  readonly allowedEmailSenders: readonly string[];
  /** Explicit admitted group chat GUIDs; empty keeps group ingress closed. */
  readonly allowedGroups: readonly string[];
  /** Internal dispatch authentication secret (never a provider bearer token). */
  readonly internalSecret: string;
  /** Fixed private/loopback Eve origin for the internal routes. */
  readonly internalOrigin: string;
  /** PostgreSQL connection for the channel store. */
  readonly databaseUrl: string;
  /** Public origin for authorized handoff and OAuth callbacks. */
  readonly publicUrl?: string;
  /** Worker tuning, bounded and with safe defaults. */
  readonly worker: {
    readonly leaseMs: number;
    readonly heartbeatStaleMs: number;
    readonly commandBatchSize: number;
    readonly dispatchBatchSize: number;
    readonly commandPollMs: number;
    readonly dispatchPollMs: number;
    readonly projectionPollMs: number;
    readonly reconciliationMs: number;
    readonly shutdownMs: number;
    readonly maxArtifactBytes: number;
  };
}

export function photonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.BELL_PHOTON_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new PhotonConfigError(name, "is required when BELL_PHOTON_ENABLED is set.");
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function e164List(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = env[name]?.trim() ?? "";
  if (!raw) return [];
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  for (const value of values) {
    if (!E164_PATTERN.test(value))
      throw new PhotonConfigError(name, `"${value}" is not a valid E.164 number.`);
  }
  return [...new Set(values)];
}

function stringList(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = env[name]?.trim() ?? "";
  if (!raw) return [];
  return [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
}

const emailListSchema = z.array(z.email());
function emailList(env: NodeJS.ProcessEnv, name: string): string[] {
  const values = stringList(env, name);
  const parsed = emailListSchema.safeParse(values.map((value) => value.toLowerCase()));
  if (!parsed.success)
    throw new PhotonConfigError(name, "contains a handle that is not a valid email address.");
  return parsed.data;
}

function boundedMs(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new PhotonConfigError(name, `must be a number between ${min} and ${max} (ms).`);
  return Math.floor(value);
}

function boundedBytes(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1024 || value > 100 * 1024 * 1024)
    throw new PhotonConfigError(name, "must be a byte size between 1024 and 104857600.");
  return Math.floor(value);
}

function privateOrigin(env: NodeJS.ProcessEnv, name: string): string {
  const raw = required(env, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PhotonConfigError(name, "must be an absolute http(s) origin.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new PhotonConfigError(name, "must use the http or https protocol.");
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password)
    throw new PhotonConfigError(name, "must be a bare origin without path, query, or credentials.");
  return url.origin;
}

/**
 * Parses the Photon environment contract. Returns `null` when the channel is
 * disabled so builds and tests can run without provider credentials. Throws
 * PhotonConfigError for malformed configuration so startup fails closed.
 */
export function loadPhotonConfig(env: NodeJS.ProcessEnv = process.env): PhotonConfig | null {
  if (!photonEnabled(env)) return null;
  const phoneNumber = required(env, "BELL_PHOTON_PHONE_NUMBER");
  if (!E164_PATTERN.test(phoneNumber))
    throw new PhotonConfigError("BELL_PHOTON_PHONE_NUMBER", "must be the dedicated line in E.164 format.");
  const allowedSenders = e164List(env, "BELL_PHOTON_ALLOWED_SENDERS");
  if (allowedSenders.length === 0)
    throw new PhotonConfigError("BELL_PHOTON_ALLOWED_SENDERS", "must contain at least one E.164 sender.");
  const internalSecret = required(env, "BELL_PHOTON_INTERNAL_SECRET");
  if (Buffer.byteLength(internalSecret) < 32)
    throw new PhotonConfigError("BELL_PHOTON_INTERNAL_SECRET", "must be at least 32 bytes and high entropy.");
  return {
    projectId: required(env, "IMESSAGE_PROJECT_ID"),
    projectSecret: required(env, "IMESSAGE_PROJECT_SECRET"),
    phoneNumber,
    allowedSenders,
    allowedEmailSenders: emailList(env, "BELL_PHOTON_ALLOWED_EMAIL_SENDERS"),
    allowedGroups: stringList(env, "BELL_PHOTON_ALLOWED_GROUPS"),
    internalSecret,
    internalOrigin: privateOrigin(env, "BELL_PHOTON_INTERNAL_ORIGIN"),
    databaseUrl: required(env, "DATABASE_URL"),
    publicUrl: optional(env, "BELL_PUBLIC_URL"),
    worker: {
      leaseMs: boundedMs(env, "BELL_PHOTON_LEASE_MS", 30_000, 5_000, 120_000),
      heartbeatStaleMs: boundedMs(env, "BELL_PHOTON_HEARTBEAT_STALE_MS", 90_000, 15_000, 600_000),
      commandBatchSize: Math.min(50, Math.max(1, boundedMs(env, "BELL_PHOTON_COMMAND_BATCH", 8, 1, 50))),
      dispatchBatchSize: Math.min(50, Math.max(1, boundedMs(env, "BELL_PHOTON_DISPATCH_BATCH", 8, 1, 50))),
      commandPollMs: boundedMs(env, "BELL_PHOTON_COMMAND_POLL_MS", 500, 50, 30_000),
      dispatchPollMs: boundedMs(env, "BELL_PHOTON_DISPATCH_POLL_MS", 500, 50, 30_000),
      projectionPollMs: boundedMs(env, "BELL_PHOTON_PROJECTION_POLL_MS", 1_000, 100, 60_000),
      reconciliationMs: boundedMs(env, "BELL_PHOTON_RECONCILIATION_MS", 300_000, 30_000, 3_600_000),
      shutdownMs: boundedMs(env, "BELL_PHOTON_SHUTDOWN_MS", 15_000, 1_000, 120_000),
      maxArtifactBytes: boundedBytes(env, "BELL_PHOTON_MAX_ARTIFACT_BYTES", 24 * 1024 * 1024),
    },
  };
}

export function photonTokenUrl(projectId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId))
    throw new PhotonConfigError("IMESSAGE_PROJECT_ID", "has an unexpected shape.");
  return IMESSAGE_TOKEN_URL.replace("{projectId}", encodeURIComponent(projectId));
}
