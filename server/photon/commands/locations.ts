import { IMessageError } from "@photon-ai/advanced-imessage/grpc";

import type { PhotonCommandExecutor, PhotonCommandOp } from "../contracts.js";
import { CommandValidationError, commandProviderKey, executeOp } from "./shared.js";

/**
 * addresses.* and locations.* executors. Location request and watch are
 * explicit-consent operations: both require a verified principal in direct
 * audience because they disclose the managed line's own position or start a
 * live subscription.
 */

export interface LocationWatchControl {
  setLocationWatch(address: string | undefined, start: boolean): Promise<boolean>;
}

export function locationExecutors(
  watches: LocationWatchControl,
): Partial<Record<PhotonCommandOp, PhotonCommandExecutor>> {
  const requireDirectPrincipal = (audience: string | undefined, principal: string | undefined): void => {
    if (audience !== "direct" || !principal)
      throw new CommandValidationError(
        "consent_required",
        "Location request/watch requires a verified principal in a direct conversation.",
      );
  };

  return {
    "addresses.get": executeOp("addresses.get", async (client, args) => {
      try {
        const info = await client.addresses.get(args.address);
        return { result: { found: true, info } };
      } catch (error) {
        if (error instanceof IMessageError && error.code === "addressNotFound")
          return { result: { found: false, address: args.address } };
        throw error;
      }
    }),

    "addresses.isIMessageAvailable": executeOp("addresses.isIMessageAvailable", async (client, args) => {
      const available = await client.addresses.isIMessageAvailable(args.address);
      return { result: { address: args.address, available } };
    }),

    "addresses.isFocusSilenced": executeOp("addresses.isFocusSilenced", async (client, args) => {
      const silenced = await client.addresses.isFocusSilenced(args.address);
      return { result: { address: args.address, silenced } };
    }),

    "locations.request": executeOp("locations.request", async (client, args, command) => {
      requireDirectPrincipal(command.audience, command.initiatorPrincipal);
      const receipt = await client.locations.request(args.chat, args.address, {
        clientMessageId: commandProviderKey(command),
      });
      return { result: receipt, receipt };
    }),

    "locations.list": executeOp("locations.list", async (client) => {
      const locations = await client.locations.list();
      return { result: { locations } };
    }),

    "locations.get": executeOp("locations.get", async (client, args) => {
      try {
        const location = await client.locations.get(args.address);
        return { result: { found: true, location } };
      } catch (error) {
        if (error instanceof IMessageError && error.code === "sharedFriendLocationNotFound")
          return { result: { found: false, address: args.address } };
        throw error;
      }
    }),

    // Bell-scoped watch control: starts/stops our subscription only. Stopping
    // never touches the person's Apple-side Find My sharing.
    "locations.watch": executeOp("locations.watch", async (_client, args, command) => {
      requireDirectPrincipal(command.audience, command.initiatorPrincipal);
      const changed = await watches.setLocationWatch(args.address, args.action === "start");
      if (args.action === "start" && !changed)
        throw new CommandValidationError("watch_limit", "Too many active location watches.");
      return { result: { address: args.address ?? null, watching: args.action === "start" } };
    }),
  };
}
