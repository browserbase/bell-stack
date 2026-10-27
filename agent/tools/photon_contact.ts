import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import {
  enqueuePhotonCommand,
  photonScope,
  resolveAttachmentGuid,
  sanitizeFileName,
  uploadModelFile,
} from "../lib/photon-tools";

const VCARD_MAX_BYTES = 64 * 1024;

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("shareSelfCard") }).strict(),
  z
    .object({
      action: z.literal("sendVCard"),
      vcard: z.string().min(16).max(VCARD_MAX_BYTES),
    })
    .strict(),
]);

/**
 * Minimal structural validation for a vCard payload: BEGIN/END wrappers, a
 * 3.0 or 4.0 VERSION, and a formatted-name (FN) property. The provider and
 * recipient clients handle the rest of the grammar.
 */
function assertValidVCard(vcard: string): void {
  const trimmed = vcard.trim();
  if (Buffer.byteLength(trimmed, "utf8") > VCARD_MAX_BYTES)
    throw new Error("The vCard exceeds the 64 KiB limit.");
  if (!/^BEGIN:VCARD[\r\n]/i.test(trimmed) || !/[\r\n]END:VCARD\s*$/i.test(trimmed))
    throw new Error("The vCard must be wrapped in BEGIN:VCARD and END:VCARD.");
  if (!/[\r\n]VERSION:(3\.0|4\.0)[\r\n]/i.test(trimmed))
    throw new Error("The vCard must declare VERSION:3.0 or VERSION:4.0.");
  if (!/[\r\n]FN[;:]/i.test(trimmed))
    throw new Error("The vCard must include an FN (formatted name) property.");
}

/** Best-effort display filename derived from the card's FN property. */
function vcardFileName(vcard: string): string {
  const match = /[\r\n]FN[^:]*:([^\r\n]+)/i.exec(vcard);
  const name = match?.[1]?.trim();
  return sanitizeFileName(name ? `${name}.vcf` : undefined, "contact.vcf");
}

export default defineTool({
  description:
    "Share contact cards in the current iMessage conversation. shareSelfCard sends the account's own native card — its fields are chosen by the account configuration, not by this tool, so never promise specific content; only send it when the user asked for contact details. sendVCard uploads a caller-supplied vCard string (BEGIN:VCARD…END:VCARD with VERSION:3.0 or 4.0 and an FN property, up to 64 KiB) as a .vcf attachment through the durable upload+send chain — use it for arbitrary contacts the user provided. shareSelfCard returns {status:'queued', commandId}; sendVCard waits for the bounded upload first and returns 'queued', 'pending', or the upload's failure status — retry a 'pending' result rather than resending blindly.",
  inputSchema,
  async execute(input, ctx) {
    const scope = await photonScope(ctx);
    switch (input.action) {
      case "shareSelfCard": {
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "chats.shareContactInfo",
          {},
        );
        return { status: "queued", commandId, deduplicated };
      }
      case "sendVCard": {
        assertValidVCard(input.vcard);
        const staged = await uploadModelFile(scope, {
          data: Buffer.from(input.vcard.trim(), "utf8"),
          mediaType: "text/vcard",
          fileName: vcardFileName(input.vcard),
        });
        const resolved = await resolveAttachmentGuid(
          scope,
          { artifactId: staged.artifactId },
          ctx.abortSignal,
        );
        if (!resolved.resolved) {
          const receipt = resolved.receipt;
          return {
            status: receipt.status,
            commandId: receipt.commandId,
            stage: "upload",
            detail:
              receipt.status === "pending" || receipt.status === "ambiguous"
                ? "The contact-card upload is still in flight. Retry once it is acknowledged."
                : "The contact-card upload did not complete.",
          };
        }
        const { commandId, deduplicated } = await enqueuePhotonCommand(
          scope,
          "messages.sendAttachment",
          { attachmentGuid: resolved.attachmentGuid },
          { dependsOn: resolved.dependsOn },
        );
        return { status: "queued", commandId, deduplicated };
      }
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
