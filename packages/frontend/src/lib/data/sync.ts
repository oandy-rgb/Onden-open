// Three groups for everything outside the data layer (A2, D6):
//   dataSync  — keeping the on-device copy in step with the server: the sync
//               engine (syncEngine.ts: boot, refresh, sync, lazy bodies,
//               reconnect) and the write queue it drains;
//   localCopy — reads of the on-device copy itself (localDb): a local
//               attribute, local search, the database file for backup;
//   recovery  — writes that were not confirmed and wait for the person
//               (FailedWriteRecovery).
// Only lib/data imports lib/localDb (eslint no-restricted-imports). The
// getters read their modules' exports when used, so a test that fakes part of
// a module still loads.
import * as queue from "./writeQueue";
import * as lost from "./writeRecovery";
import * as status from "./syncStatus";
import * as store from "./storeOps";
import * as membership from "./membershipReconcile";
import * as engine from "./syncEngine";
import * as connectivity from "./connectivity";
import * as local from "../localDb";

export const dataSync = {
  /** Run the connection lifecycle on the window — boot, online/offline with
   *  the reconnect retry, the later-flip refresh, unload flush, access
   *  revoked (connectivity.ts). Returns the disposer; useAppData attaches. */
  get attachConnectivity() { return connectivity.attachConnectivity; },
  // The engine steps (syncEngine.ts) the lifecycle orders.
  /** First load: cached paint, bootstrap, first sync. */
  get boot() { return engine.boot; },
  /** Fetch the drawings this device has no copy of (offline, folder export). */
  get downloadDrawings() { return engine.downloadDrawingsForOffline; },
  /** Browser back online; false = still unreachable, retry later. */
  get reconnect() { return engine.reconnect; },
  get wentOffline() { return engine.wentOffline; },
  /** Removed from the workspace: drop the in-memory and on-device copy. */
  get forgetWorkspace() { return engine.forgetWorkspace; },
  /** Relay pagehide/hidden to the local database so its snapshot lands. */
  get installUnloadFlush() { return local.installUnloadFlush; },
  /** Re-read the whole workspace (slim when big) and the canvas list. */
  get refresh() { return engine.refresh; },
  /** Pull event deltas and reconcile membership; ok=false keeps the gate. */
  get sync() { return engine.sync; },
  /** Load one note's full body (slim sessions) into the store. */
  get hydrateNode() { return engine.hydrateNode; },
  get hydrateFullBootstrap() { return engine.hydrateFullBootstrap; },
  /** Max full bodies kept in memory during a slim session. */
  get HYDRATED_BODY_CAP() { return engine.HYDRATED_BODY_CAP; },
  /** Fill the on-device copy with bodies never opened (big workspaces). */
  get downloadBodiesForOffline() { return engine.downloadBodiesForOffline; },
  /** SSE membership tick: gate now, reconcile once the burst settles. */
  get membershipChanged() { return engine.membershipChanged; },
  /** The live stream reopened: catch up (locks only if permissions changed). */
  get liveStreamReconnected() { return engine.liveStreamReconnected; },
  get markSyncDirty() { return engine.markSyncDirty; },
  get generatePreview() { return engine.generatePreview; },
  // The write queue and the delta plumbing.
  /** Send every queued write, in order (single-flight). */
  get flushQueue() { return queue.flushPendingWrites; },
  /** Whether a write to `pathPrefix` is still queued. */
  get hasPending() { return queue.hasPendingWrite; },
  get replayRejectionRevision() { return queue.getReplayRejectionRevision; },
  /** The window event a queued write that finally failed is announced on. */
  get QUEUE_FAILED_EVENT() { return queue.OFFLINE_QUEUE_FAILED_EVENT; },
  get refreshPendingCount() { return status.refreshPendingCount; },
  get isEmptyDelta() { return store.isEmptyDelta; },
  get reconcileMembership() { return membership.reconcileMembership; },
};

export const localCopy = {
  /** A note's body as this device last stored it (null: never stored). */
  get body() { return local.getStoredBody; },
  /** One attribute value as this device last saw it. */
  get attribute() { return local.getNodeAttribute; },
  get attributeRecord() { return local.getNodeAttributeRecord; },
  /** Keep server values this device lacks (a drawing read on open). */
  get fillAttributes() { return local.fillNodeAttributes; },
  /** Full-text search over the on-device copy. */
  get search() { return local.searchNodes; },
  /** The local database as a file (backup), and restoring one. */
  get exportFile() { return local.exportDatabase; },
  get importFile() { return local.importDatabase; },
  /** Write the pending snapshot to disk now. */
  get flush() { return local.flushLocalDbSync; },
};

export const recovery = {
  /** The writes not confirmed by the server, for the person to retry or drop. */
  get list() { return lost.getRecoveryWrites; },
  get subscribe() { return lost.subscribeRecovery; },
  get refresh() { return lost.refreshRecoveryWrites; },
  get remember() { return lost.rememberUnconfirmedWrite; },
  get remove() { return lost.removeRecoveryWrite; },
  get setKey() { return lost.setRecoveryWriteKey; },
  /** Queue a recovered write again. */
  get requeue() { return queue.queueWrite; },
};
