import { createGrpcClient, type AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { z } from "zod";

import { photonTokenUrl, type PhotonConfig } from "./config.js";
import { sourceIdFor } from "./identity.js";

/**
 * Managed credential discovery and gRPC client lifecycle for the pinned
 * Advanced iMessage SDK. Project credentials mint short-lived managed line
 * credentials; the project secret is never used as a line bearer token.
 */

export class PhotonProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "PhotonProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface LineCredentials {
  /** Provider instance / account scope for the enrolled source. */
  readonly instanceId: string;
  /** Actual dedicated phone number in E.164. */
  readonly phoneNumber: string;
  /** gRPC endpoint for this instance, e.g. `<instance>.imsg.photon.codes:443`. */
  readonly endpoint: string;
  /** Bearer token for this instance only. */
  readonly token: string;
  /** When the managed credentials expire (ms since epoch). */
  readonly expiresAt: number;
}

const tokenResponseSchema = z.object({
  auth: z.record(z.string(), z.string()).optional(),
  numbers: z.record(z.string(), z.array(z.string())).optional(),
  token: z.string().optional(),
  expiresIn: z.number().int().positive().max(365 * 24 * 60 * 60),
}).strict();

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Fetches managed line credentials from the Stable cloud token endpoint and
 * selects the instance that serves the configured dedicated line. Fails
 * closed when only an incompatible shared assignment is available — a
 * discovered shared number is never substituted for the configured line.
 */
export async function discoverLineCredentials(
  config: PhotonConfig,
  fetcher: typeof fetch = fetch,
): Promise<LineCredentials> {
  const url = photonTokenUrl(config.projectId);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Basic ${Buffer.from(`${config.projectId}:${config.projectSecret}`, "utf8").toString("base64")}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
  } catch (error) {
    throw new PhotonProviderError(
      "token_request_failed",
      `Managed iMessage credential request failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  if (!response.ok) {
    throw new PhotonProviderError(
      response.status === 401 || response.status === 403 ? "token_unauthorized" : "token_rejected",
      `Managed iMessage credential request rejected with status ${response.status}.`,
      RETRYABLE_STATUS.has(response.status),
    );
  }
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new PhotonProviderError("token_response_invalid", "Managed iMessage credential response had an unexpected shape.");
  }
  const body = parsed.data;
  if (!body.auth || !body.numbers) {
    throw new PhotonProviderError(
      "dedicated_line_required",
      "The project returned a shared-line credential. A dedicated line is required for this channel.",
    );
  }
  const matches = Object.entries(body.numbers).filter(
    ([instanceId, numbers]) => numbers.includes(config.phoneNumber) && typeof body.auth?.[instanceId] === "string",
  );
  if (matches.length !== 1) {
    throw new PhotonProviderError(
      "configured_line_unavailable",
      `No discovered instance serves the configured dedicated line ${config.phoneNumber}; found ${matches.length} candidates.`,
    );
  }
  const [instanceId] = matches[0];
  return {
    instanceId,
    phoneNumber: config.phoneNumber,
    endpoint: `${instanceId}.imsg.photon.codes:443`,
    token: body.auth[instanceId],
    expiresAt: Date.now() + body.expiresIn * 1_000,
  };
}

export interface PhotonConnection {
  readonly client: AdvancedIMessage;
  readonly credentials: LineCredentials;
  /** Stable enrolled-source identity for this credential set. */
  readonly sourceId: string;
}

/**
 * Opens the gRPC client for one credential set. The token getter is a live
 * closure so the SDK's per-RPC token reads always see the freshest managed
 * credential; the worker replaces the whole connection on renewal instead.
 */
export function connectPhoton(
  credentials: LineCredentials,
  config: PhotonConfig,
  tokenRef: { current: string } = { current: credentials.token },
): PhotonConnection {
  const client = createGrpcClient({
    address: credentials.endpoint,
    token: async () => tokenRef.current,
    tls: true,
    // Bell assigns explicit idempotency keys; a random per-call header would
    // duplicate visible sends on application-level retries.
    autoIdempotency: false,
    retry: { maxAttempts: 3, initialDelay: 250, maxDelay: 5_000 },
    timeout: 20_000,
    channelOptions: {
      "grpc.max_send_message_length": 100 * 1024 * 1024,
      "grpc.max_receive_message_length": 100 * 1024 * 1024,
      "grpc.keepalive_time_ms": 20_000,
      "grpc.keepalive_timeout_ms": 10_000,
    },
  });
  return {
    client,
    credentials,
    sourceId: sourceIdFor(config.projectId, credentials.instanceId, credentials.phoneNumber),
  };
}
