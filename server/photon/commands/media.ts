import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";

import type { PhotonCommandExecutor, PhotonCommandOp } from "../contracts.js";
import type { PhotonDb } from "../store.js";
import { downloadArtifact, messageToFileParts, uploadArtifact } from "../media.js";
import { executeOp } from "./shared.js";

/**
 * attachments.* executors and the model-staging re-exports used by dispatch
 * when it prepares inbound media for Eve. Uploads are retry-safe despite
 * carrying no provider key: a duplicated attempt only orphans an unused
 * provider-side GUID, which the reconcile hook proves safe to repeat.
 */

export { downloadArtifact, messageToFileParts };

export function mediaExecutors(
  store: PhotonDb,
): Partial<Record<PhotonCommandOp, PhotonCommandExecutor>> {
  return {
    "attachments.upload": executeOp("attachments.upload", async (client, args, command) => {
      const uploaded = await uploadArtifact(client, store, command.sourceId, {
        artifactId: args.artifactId,
        companionArtifactId: args.companionArtifactId,
        fileName: args.fileName,
      });
      return {
        result: uploaded,
        receipt: { attachmentGuid: uploaded.attachmentGuid },
      };
    }, // A retried upload cannot duplicate a visible send — only an orphan GUID.
      () => Promise.resolve(false)),

    "attachments.get": executeOp("attachments.get", async (client, args, command) => {
      const info = await client.attachments.get(args.attachmentGuid);
      await store.upsertResource(command.sourceId, "attachment", info.guid, { info });
      return { result: info };
    }),
  };
}

/** Bounded download typed for the command layer's raw client. */
export function downloadForModel(
  client: unknown,
  store: PhotonDb,
  sourceId: string,
  chatGuid: string,
  attachmentGuid: string,
  maxBytes: number,
) {
  return downloadArtifact(client as AdvancedIMessage, store, sourceId, chatGuid, attachmentGuid, maxBytes);
}
