import type { PhotonConfig } from "../../server/photon/config.js";
import { createPhotonStore, type PhotonStore } from "../../server/photon/store.js";

const pools = new Map<string, PhotonStore>();

/**
 * One process-wide channel store per database, shared by every consumer in
 * this process — tool reads/writes, browser-runtime conversation lookups,
 * and channel bookkeeping all go through the same connection pool that
 * fronts the durable tables the transport worker drains. The map never
 * evicts: a `databaseUrl` rotation leaks the old pool for the process's
 * life, which is acceptable because config rotation happens at restart —
 * not something a long-lived pool should chase.
 */
export function getPhotonStore(config: Pick<PhotonConfig, "databaseUrl">): PhotonStore {
  let store = pools.get(config.databaseUrl);
  if (!store) {
    store = createPhotonStore(config.databaseUrl);
    store.pool.on("error", () => {
      console.error("Photon channel store connection failed.");
    });
    pools.set(config.databaseUrl, store);
  }
  return store;
}
