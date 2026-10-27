import type {
  AdvancedIMessage,
  AttachmentInfo,
  Message,
  UploadAttachmentResult,
} from "@photon-ai/advanced-imessage/grpc";

import { sha256Hex } from "./identity.js";
import type { PhotonStore } from "./store.js";

/**
 * Scoped artifact IO: bounded attachment downloads, validated uploads with
 * Live Photo companion pairing, and model-safe content parts. A failed or
 * interrupted stream never produces a partial artifact.
 */

export class MediaError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "MediaError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Conservative outbound media allowlist: documented image/video/audio types
 * plus PDF, vCard and plain text. Anything else fails closed — untrusted
 * inbound payloads never choose server-side media types.
 */
const UPLOAD_ALLOWED_PREFIXES = ["image/", "video/", "audio/"];
const UPLOAD_ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "text/plain",
  "text/vcard",
  "text/x-vcard",
]);

export function assertUploadMediaType(mediaType: string): void {
  const normalized = mediaType.trim().toLowerCase();
  if (UPLOAD_ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return;
  if (UPLOAD_ALLOWED_TYPES.has(normalized)) return;
  throw new MediaError("media_type_not_allowed", `Media type "${mediaType}" is not in the outbound allowlist.`);
}

/** vCard payloads must actually be vCards — shape checked, never executed. */
function assertValidVCard(fileName: string, data: Uint8Array): void {
  const text = Buffer.from(data.subarray(0, 4096)).toString("utf8");
  if (!text.includes("BEGIN:VCARD") || !text.includes("END:VCARD"))
    throw new MediaError("invalid_vcard", `File "${fileName}" is not a well-formed vCard.`);
}

function isVCard(fileName: string | undefined, mediaType: string): boolean {
  const type = mediaType.toLowerCase();
  return type === "text/vcard" || type === "text/x-vcard" || !!fileName?.toLowerCase().endsWith(".vcf");
}

/** Maximum combined primary+companion bytes for one unary upload frame. */
const MAX_UPLOAD_FRAME_BYTES = 90 * 1024 * 1024;
const DOWNLOAD_ATTEMPTS = 3;

export interface DownloadedArtifact {
  readonly artifactId: string;
  readonly companionArtifactId?: string;
  readonly info: AttachmentInfo;
  readonly byteSize: number;
  readonly sha256: string;
}

/**
 * Streams one attachment into a bounded artifact. The first frame carries
 * header metadata; primary and optional companion chunks accumulate
 * separately and fail closed past `maxBytes`. Only a fully consumed stream
 * produces artifacts — retries restart the whole stream (there is no
 * resume-offset parameter), and partial downloads are always discarded.
 */
export async function downloadArtifact(
  client: AdvancedIMessage,
  store: PhotonStore,
  sourceId: string,
  chatGuid: string,
  attachmentGuid: string,
  maxBytes: number,
): Promise<DownloadedArtifact> {
  const result = await downloadArtifactData(
    client, store, sourceId, chatGuid, attachmentGuid, maxBytes,
  );
  // Bytes stay inside the store; callers get the artifact handle only.
  return {
    artifactId: result.artifactId,
    companionArtifactId: result.companionArtifactId,
    info: result.info,
    byteSize: result.byteSize,
    sha256: result.sha256,
  };
}

/**
 * Bounded download for model staging: identical bounds/retries to
 * {@link downloadArtifact} but also returns the staged bytes.
 */
export async function downloadArtifactData(
  client: AdvancedIMessage,
  store: PhotonStore,
  sourceId: string,
  chatGuid: string,
  attachmentGuid: string,
  maxBytes: number,
): Promise<DownloadedArtifact & { data: Uint8Array }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await downloadOnce(client, store, sourceId, chatGuid, attachmentGuid, maxBytes);
    } catch (error) {
      lastError = error;
      if (error instanceof MediaError && !error.retryable) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new MediaError("download_failed", "Attachment download failed.");
}

interface DownloadResult extends DownloadedArtifact {
  readonly data: Uint8Array;
}

async function downloadOnce(
  client: AdvancedIMessage,
  store: PhotonStore,
  sourceId: string,
  chatGuid: string,
  attachmentGuid: string,
  maxBytes: number,
): Promise<DownloadResult> {
  const stream = client.attachments.downloadStream(attachmentGuid);
  let info: AttachmentInfo | undefined;
  let companionInfo: { fileName: string; mimeType: string; totalBytes: number } | undefined;
  const primary: Buffer[] = [];
  const companion: Buffer[] = [];
  let primaryBytes = 0;
  let companionBytes = 0;
  try {
    for await (const chunk of stream) {
      if (chunk.type === "header") {
        if (info) throw new MediaError("download_protocol_error", "Duplicate download header frame.");
        info = chunk.info;
        companionInfo = chunk.companionInfo;
      } else if (chunk.type === "primaryChunk") {
        primaryBytes += chunk.data.byteLength;
        if (primaryBytes > maxBytes)
          throw new MediaError("attachment_too_large", `Attachment ${attachmentGuid} exceeds the ${maxBytes} byte bound.`);
        primary.push(Buffer.from(chunk.data));
      } else if (chunk.type === "companionChunk") {
        companionBytes += chunk.data.byteLength;
        if (companionBytes > maxBytes)
          throw new MediaError("companion_too_large", `Attachment companion ${attachmentGuid} exceeds the ${maxBytes} byte bound.`);
        companion.push(Buffer.from(chunk.data));
      }
    }
  } catch (error) {
    await stream.close().catch(() => undefined);
    if (error instanceof MediaError) throw error;
    throw new MediaError(
      "download_interrupted",
      `Attachment ${attachmentGuid} download was interrupted: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  if (!info)
    throw new MediaError("download_protocol_error", "Download stream ended before its header frame.", true);

  const data = Buffer.concat(primary);
  const sha256 = sha256Hex(data.toString("base64"));
  const artifactId = await store.putArtifact({
    sourceId, chatGuid, attachmentGuid,
    fileName: info.fileName, mediaType: info.mimeType, data,
  });
  let companionArtifactId: string | undefined;
  if (companion.length > 0) {
    companionArtifactId = await store.putArtifact({
      sourceId, chatGuid, attachmentGuid,
      fileName: companionInfo?.fileName, mediaType: companionInfo?.mimeType ?? "video/quicktime",
      data: Buffer.concat(companion),
    });
  }
  await store.upsertResource(sourceId, "attachment", attachmentGuid, {
    info, artifactId, companionArtifactId: companionArtifactId ?? null,
    sha256, byteSize: data.byteLength, chatGuid,
  });
  return { artifactId, companionArtifactId, info, byteSize: data.byteLength, sha256, data };
}

export interface UploadedArtifact {
  readonly attachmentGuid: string;
  readonly transferState: string;
  readonly totalBytes: number;
  readonly companion?: { fileName: string; mimeType: string; totalBytes: number };
}

/**
 * Reads validated artifact bytes and uploads them through the provider.
 * A companion artifact pairs a Live Photo still (image/*) with its motion
 * video (video/*); only the primary GUID is sent later.
 */
export async function uploadArtifact(
  client: AdvancedIMessage,
  store: PhotonStore,
  sourceId: string,
  args: { artifactId: string; companionArtifactId?: string; fileName: string },
): Promise<UploadedArtifact> {
  const primary = await store.getArtifact(args.artifactId);
  if (!primary) throw new MediaError("artifact_not_found", `Artifact ${args.artifactId} does not exist.`);
  if (primary.sourceId !== sourceId)
    throw new MediaError("artifact_scope", "Artifact belongs to a different source.");
  assertUploadMediaType(primary.mediaType);
  if (isVCard(args.fileName, primary.mediaType)) assertValidVCard(args.fileName, primary.data);

  let totalBytes = primary.data.byteLength;
  let companionInput: { data: Uint8Array } | undefined;
  if (args.companionArtifactId) {
    const companion = await store.getArtifact(args.companionArtifactId);
    if (!companion) throw new MediaError("artifact_not_found", `Companion artifact ${args.companionArtifactId} does not exist.`);
    if (!primary.mediaType.toLowerCase().startsWith("image/"))
      throw new MediaError("invalid_live_photo", "A Live Photo companion requires an image primary artifact.");
    if (!companion.mediaType.toLowerCase().startsWith("video/"))
      throw new MediaError("invalid_live_photo", "A Live Photo companion artifact must be video.");
    totalBytes += companion.data.byteLength;
    companionInput = { data: Buffer.from(companion.data) };
  }
  if (totalBytes > MAX_UPLOAD_FRAME_BYTES)
    throw new MediaError("upload_too_large", `Combined upload of ${totalBytes} bytes exceeds the unary upload bound.`);

  const result: UploadAttachmentResult = await client.attachments.upload({
    fileName: args.fileName,
    data: Buffer.from(primary.data),
    companion: companionInput,
  });
  const uploaded: UploadedArtifact = {
    attachmentGuid: result.attachment.guid,
    transferState: result.attachment.transferState,
    totalBytes: result.attachment.totalBytes,
    companion: result.companion,
  };
  await store.upsertResource(sourceId, "attachment", result.attachment.guid, {
    info: result.attachment, sourceArtifactId: args.artifactId,
    companionArtifactId: args.companionArtifactId ?? null,
    uploadedAt: new Date().toISOString(),
  });
  return uploaded;
}

/* ------------------------------------------------------------------ */
/* Model-safe content parts                                             */
/* ------------------------------------------------------------------ */

/** AI-SDK-compatible content parts built from an inbound message. */
export type ModelContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: Uint8Array; readonly mediaType: string; readonly filename?: string };

/** Media types staged for the model; anything else becomes a placeholder. */
const MODEL_MEDIA_PREFIXES = ["image/", "audio/", "video/", "text/"];
const MODEL_MEDIA_TYPES = new Set(["application/pdf"]);

/** Attachments per message staged inline for the model before degrading. */
const MAX_INLINE_ATTACHMENTS = 4;

function modelConsumable(mediaType: string): boolean {
  const type = mediaType.toLowerCase();
  return MODEL_MEDIA_PREFIXES.some((prefix) => type.startsWith(prefix)) || MODEL_MEDIA_TYPES.has(type);
}

/**
 * Projects inbound message content into model-safe parts: text as text,
 * each consumable attachment as bounded downloaded file bytes, and an
 * explicit placeholder for anything oversized, pending, failed or
 * undownloadable. Native content stays typed data — placeholders describe
 * media; they never carry executable instructions.
 */
export async function messageToFileParts(
  client: AdvancedIMessage,
  store: PhotonStore,
  sourceId: string,
  message: Message,
  maxBytes: number,
): Promise<ModelContentPart[]> {
  const parts: ModelContentPart[] = [];
  const chatGuid = message.chatGuids[0] ?? "";
  const content = message.content;
  if (content.text !== undefined && content.text.length > 0)
    parts.push({ type: "text", text: content.text });

  const attachments = content.attachments.slice(0, MAX_INLINE_ATTACHMENTS);
  for (const attachment of attachments) {
    const label = attachment.fileName || attachment.guid;
    const meta = `${attachment.mimeType}, ${attachment.totalBytes} bytes`;
    if (attachment.transferState !== "finished") {
      parts.push({
        type: "text",
        text: `[attachment ${label} (${meta}) not ready: ${attachment.transferState}]`,
      });
      continue;
    }
    if (!modelConsumable(attachment.mimeType)) {
      parts.push({ type: "text", text: `[attachment ${label} (${meta}) has a type the model cannot read]` });
      continue;
    }
    try {
      const downloaded = await downloadArtifactData(
        client, store, sourceId, chatGuid, attachment.guid, maxBytes,
      );
      parts.push({
        type: "file",
        data: downloaded.data,
        mediaType: attachment.mimeType,
        filename: attachment.fileName,
      });
    } catch (error) {
      parts.push({
        type: "text",
        text: `[attachment ${label} (${meta}) could not be downloaded: ${error instanceof Error ? error.message : String(error)}]`,
      });
    }
  }
  if (content.attachments.length > attachments.length)
    parts.push({
      type: "text",
      text: `[${content.attachments.length - attachments.length} more attachment(s) omitted]`,
    });
  if (message.isAudioMessage && !parts.some((part) => part.type === "file"))
    parts.push({ type: "text", text: "[voice note]" });
  if (parts.length === 0) parts.push({ type: "text", text: "[non-text iMessage content]" });
  return parts;
}
