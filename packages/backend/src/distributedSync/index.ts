// Distributed sync (beta). The only door to the engine: nothing else in the server imports it.
// Off unless ONDEN_DISTRIBUTED_SYNC=1; off means no node can be opened, so no table is read or written,
// no route, job or hook exists (it is not in modules/index.ts MODULES until the interface step: doc §9).
import { config } from "../config.js";
import { CodedStatusError } from "../statusError.js";
import { SyncNode, type NodeOptions } from "./node.js";
import type { SyncDb } from "./types.js";

export class DistributedSyncOff extends CodedStatusError {
  constructor() { super(409, "distributed_sync_off", "distributed sync is off on this server"); }
}

export const distributedSyncEnabled = (): boolean => config.is("ONDEN_DISTRIBUTED_SYNC", "1");

export async function openSyncNode(db: SyncDb, opts: NodeOptions): Promise<SyncNode> {
  if (!distributedSyncEnabled()) throw new DistributedSyncOff();
  return SyncNode.open(db, opts);
}

export { SyncNode } from "./node.js";
export { materialize, spaceDigest, roleIn, canRead } from "./materialize.js";
export type * from "./types.js";
