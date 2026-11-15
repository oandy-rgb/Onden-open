// Distributed sync (beta), step 2a: the bridge between the engine and the real tables. The only door for it; off unless
// ONDEN_DISTRIBUTED_SYNC=1 (Replica.open refuses otherwise, before any query). Doc: docs/architecture/distributed-sync.md §3.1, §9.
export { Replica, type ReplicaOptions, type HandleReport } from "./replica.js";
export { planGenesis, type GenesisPlan } from "./genesis.js";
export { captureLocalWrites, CAPTURED_EVENT_TYPES, type CaptureReport } from "./capture.js";
export { projectChange, type ProjectionReport } from "./project.js";
export { worldView, dbView, viewDifferences, tagSpaceId, tagDisplayTitles, type StateView } from "./view.js";
