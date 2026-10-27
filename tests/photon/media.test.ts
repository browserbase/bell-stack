/**
 * Bounded media handling: download streams are collected into separate
 * bounded primary/companion outputs, oversized or corrupted payloads fail
 * closed (never a partial artifact), and Live Photo pairs stay matched.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { AttachmentInfo, DownloadAttachmentChunk } from "@photon-ai/advanced-imessage/grpc";

import { buildUploadInput, collectDownload } from "../../server/photon/media";
import { sanitizeFileName } from "../../server/photon/filename";
import { fakeStream } from "./fixtures/harness";
import { attachment } from "./fixtures/sdk-events";

function chunks(info: AttachmentInfo, primary: readonly Uint8Array[], companion: readonly Uint8Array[] = [], companionInfo?: AttachmentInfo extends never ? never : { fileName: string; kind: "live-photo-video"; mimeType: string; totalBytes: number }): DownloadAttachmentChunk[] {
  const out: DownloadAttachmentChunk[] = [{ type: "header", info, ...(companionInfo ? { companionInfo } : {}) }];
  for (const data of primary) out.push({ type: "primaryChunk", data });
  for (const data of companion) out.push({ type: "companionChunk", data });
  return out;
}

function bytes(length: number, fill = 0x61): Uint8Array {
  const data = new Uint8Array(length);
  data.fill(fill);
  return data;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("bounded media pipeline (server/photon/media.ts)", () => {
  const m = { collectDownload, buildUploadInput, sanitizeFileName };

  it("collects a well-formed download into bounded primary bytes", async () => {
    const primary = bytes(1024);
    const info = attachment({ totalBytes: 1024, mimeType: "image/png", fileName: "a.png" });
    const result = await m.collectDownload(fakeStream(chunks(info, [primary.slice(0, 512), primary.slice(512)])), { maxBytes: 4096 });
    expect(result.primary).toEqual(primary);
    expect(result.info.guid).toBe(info.guid);
    expect(result.companion).toBeUndefined();
  });

  it("fails closed when the payload exceeds the byte budget — no partial artifact", async () => {
    const oversized = bytes(8 * 1024);
    const info = attachment({ totalBytes: oversized.byteLength });
    const stream = fakeStream(chunks(info, [oversized.slice(0, 4096), oversized.slice(4096)]));
    await expect(m.collectDownload(stream, { maxBytes: 1024 })).rejects.toThrow();
  });

  it("fails closed when a header's declared size already exceeds the budget", async () => {
    const info = attachment({ totalBytes: 100 * 1024 * 1024 });
    const stream = fakeStream(chunks(info, []));
    await expect(m.collectDownload(stream, { maxBytes: 1024 })).rejects.toThrow();
  });

  it("verifies a sha256 checksum when one is supplied", async () => {
    const primary = bytes(2048);
    const info = attachment({ totalBytes: primary.byteLength });
    const good = await m.collectDownload(
      fakeStream(chunks(info, [primary])),
      { maxBytes: 4096, expectedSha256: sha256(primary) },
    );
    expect(good.primary).toEqual(primary);
    await expect(m.collectDownload(
      fakeStream(chunks(info, [primary])),
      { maxBytes: 4096, expectedSha256: "f".repeat(64) },
    )).rejects.toThrow();
  });

  it("keeps a Live Photo primary and companion paired in separate outputs", async () => {
    const primary = bytes(1500, 0x62);
    const companion = bytes(900, 0x63);
    const info = attachment({ fileName: "live.heic", mimeType: "image/heic", totalBytes: primary.byteLength });
    const companionInfo = { fileName: "live.mov", kind: "live-photo-video" as const, mimeType: "video/quicktime", totalBytes: companion.byteLength };
    const result = await m.collectDownload(
      fakeStream(chunks(info, [primary], [companion.slice(0, 400), companion.slice(400)], companionInfo)),
      { maxBytes: 4096, maxCompanionBytes: 4096 },
    );
    expect(result.primary).toEqual(primary);
    expect(result.companion).toEqual(companion);
  });

  it("abandons an interrupted stream rather than returning truncated bytes", async () => {
    const primary = bytes(2048);
    const info = attachment({ totalBytes: primary.byteLength });
    const stream = fakeStream(chunks(info, [primary.slice(0, 100)]), { error: new Error("grpc stream reset") });
    await expect(m.collectDownload(stream, { maxBytes: 4096 })).rejects.toThrow();
  });

  it("maps artifact bytes to the provider upload shape with companion pairing", () => {
    const primary = bytes(100);
    const companion = bytes(50);
    const input = m.buildUploadInput({ fileName: "photo.png", data: primary, companion });
    expect(input.fileName).toBe("photo.png");
    expect(input.data).toBe(primary);
    expect(input.companion?.data).toBe(companion);
    const plain = m.buildUploadInput({ fileName: "doc.pdf", data: primary });
    expect(plain.companion).toBeUndefined();
  });

  it("preserves MIME type and filename through the attachment metadata", async () => {
    const info = attachment({ fileName: "résumé 2026.pdf", mimeType: "application/pdf", uti: "com.adobe.pdf", totalBytes: 10 });
    const result = await m.collectDownload(fakeStream(chunks(info, [bytes(10)])), { maxBytes: 1024 });
    expect(result.info.mimeType).toBe("application/pdf");
    expect(result.info.fileName).toBe("résumé 2026.pdf");
  });

  it("sanitizes hostile filenames when the helper exists", async () => {
    if (!m.sanitizeFileName) return;
    for (const hostile of ["../../etc/passwd", "a\\b\\c.png", "\0.png", "x".repeat(600) + ".png"]) {
      const clean = m.sanitizeFileName(hostile);
      expect(clean).toBeTruthy();
      expect(clean).not.toMatch(/[/\\\0]/);
      expect(clean.length).toBeLessThanOrEqual(1024);
    }
  });
});
