import { adoptsLegacyNativeStore, getAccountStorageScope } from "./accountStorage";
import type { WorkspaceSettings } from "./workspaceMirror";
// ───────────────────────────────────────────────────────────────────────────
// localDb — thin main-thread RPC client over the sql.js worker.
//
// The entire sql.js instance (init, every query, export, and the periodic
// IndexedDB save) lives in localDbWorker.ts so that opening or searching a
// large local vault never blocks the UI thread. This module is just a typed
// postMessage bridge: it keeps the SAME async public API the rest of the app
// already awaits, so callers (useAppData, useOverviewSearch, settings) are
// unchanged. Before this split sql.js ran inline on the main thread and only
// db.export() was idle-deferred, so bootstrap hydration and search janked.
// ───────────────────────────────────────────────────────────────────────────
import type { Bootstrap, ContentNode, NodeEdge, NodeTask, NodeAttribute, NotePointer, Workspace, Canvas, CanvasMeta, CanvasData, Tag } from "./api";
import type { CanvasMembershipKey } from "./canvasMemberships";
import { setLocalCopyUnavailable } from "./localCopyStatus";
import type { LocalDbRequest, LocalDbResponse } from "./localDbWorker";
import { LocalDbError } from "./localDbErrors";
import { noteClientTooOld } from "./buildVersion";
import { getLocalCopyState, setLocalCopy } from "./localCopyState";
import type { Snippet } from "@onden/markdown/snippet";
import type { WriteTarget } from "./pendingWriteTargets";
import { onPageHide } from "./pageHide";
import { isTemporarySession } from "./temporarySession";
import type { AttributeDelta, CanvasMembership, SyncDelta as WireSyncDelta } from "@onden/contract";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

/** A call that takes this long means the worker is gone or hung (a 100 MB
 *  export on a phone is seconds, not a minute). Opening the copy reads the
 *  whole snapshot, so it gets longer. */
export const LOCAL_DB_CALL_TIMEOUT_MS = 60_000;
export const LOCAL_DB_INIT_TIMEOUT_MS = 120_000;

/** Throw the worker away: every call waiting on it fails now, and the next
 *  call starts a fresh one. The page shows "local copy unavailable" until one
 *  answers. */
function resetWorker(reason: Error): void {
  const dead = worker;
  worker = null;
  dead?.terminate();
  for (const [id, slot] of pending) {
    pending.delete(id);
    clearTimeout(slot.timer);
    slot.reject(reason);
  }
  if (getLocalCopyState() !== "none") setLocalCopy("restarting");
}

/** Not an answer to a call: the worker reporting on itself. */
export type LocalDbEvent = { event: "snapshot-save"; ok: boolean };

function getWorker(): Worker {
  if (!worker) {
    const fresh = new Worker(new URL("./localDbWorker.ts", import.meta.url), { type: "module" });
    worker = fresh;
    fresh.onmessage = (ev: MessageEvent<LocalDbResponse | LocalDbEvent>) => {
      if (worker !== fresh) return;
      if (getLocalCopyState() === "restarting") setLocalCopy("ok"); // it answers: the replay worked
      const msg = ev.data;
      if ("event" in msg) { setLocalCopyUnavailable(!msg.ok); return; }
      const slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      clearTimeout(slot.timer);
      if (msg.ok) slot.resolve(msg.result);
      else {
        slot.reject(msg.code ? new LocalDbError(msg.code, msg.error) : new Error(msg.error));
        // A copy written by a newer build is not this page's to use or change: run from server data and offer the reload.
        if (msg.code === "local_copy_too_new") queueMicrotask(() => { useMemoryOnlyLocalCopy(); noteClientTooOld(); });
      }
    };
    // A worker-level failure (e.g. wasm load) or a message that cannot be read:
    // fail the calls in flight so callers' fallbacks fire instead of hanging,
    // and start over with a new worker on the next call.
    fresh.onerror = (ev) => { if (worker === fresh) resetWorker(new Error(ev.message || "localDb worker error")); };
    fresh.onmessageerror = () => { if (worker === fresh) resetWorker(new Error("localDb worker message error")); };
  }
  return worker;
}

function call<T>(op: string, args: unknown[] = [], timeoutMs = LOCAL_DB_CALL_TIMEOUT_MS): Promise<T> {
  if (getLocalCopyState() === "none") return Promise.reject(new LocalDbError("local_copy_unavailable", "This device has no local copy"));
  return callWorker<T>(op, args, timeoutMs);
}

function callWorker<T>(op: string, args: unknown[], timeoutMs: number): Promise<T> {
  const id = nextId++;
  const req: LocalDbRequest = { id, op, args, storageScope: getAccountStorageScope(), adoptLegacy: adoptsLegacyNativeStore(), ...(isTemporarySession() ? { temporary: true } : {}) };
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resetWorker(new Error(`localDb ${op} timed out`)), timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    try { getWorker().postMessage(req); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); }
  });
}

/** Take in the queue other tabs and the installed app wrote (see the worker). */
export async function catchUpWithOtherTabs(): Promise<void> {
  await call<void>("catchUpWithOtherTabs");
}

/** Open the local copy. Success also ends "none": a later open may work. */
export async function initLocalDb(): Promise<void> {
  await callWorker<void>("initLocalDb", [], LOCAL_DB_INIT_TIMEOUT_MS);
  setLocalCopy("ok");
}

/** The copy could not be opened: run from server data only (see LocalCopyState).
 *  Writes go straight to the server (getPendingWrites() is empty: there is no
 *  queue to be behind), and nothing is kept for offline. */
export function useMemoryOnlyLocalCopy(): void {
  const dead = worker;
  worker = null;
  dead?.terminate();
  for (const [id, slot] of pending) {
    pending.delete(id);
    clearTimeout(slot.timer);
    slot.reject(new LocalDbError("local_copy_unavailable", "This device has no local copy"));
  }
  setLocalCopy("none");
}

/** Tests: drop the worker and what waits on it (localCopyState has its own reset). */
export function _resetLocalDbForTests(): void {
  worker?.terminate();
  worker = null;
  for (const slot of pending.values()) clearTimeout(slot.timer);
  pending.clear();
}

/** Drop everything this account holds locally for the workspace (access revoked). */
export async function wipeWorkspaceMirror(): Promise<void> {
  await call<void>("wipeWorkspaceMirror");
}

export async function loadBootstrap(): Promise<Bootstrap | null> {
  return call<Bootstrap | null>("loadBootstrap");
}

/** The cached workspace for the first paint: loadBootstrap without edges,
 *  pointers, tasks, suggestions, graph positions and the notes' attrs maps
 *  (those come back empty). Read them with loadBootstrapRelations and
 *  loadAttributePage, then merge (data/bootRest). */
export async function loadBootstrapList(): Promise<Bootstrap | null> {
  return call<Bootstrap | null>("loadBootstrapList");
}

/** What loadBootstrapList left out besides attrs: the workspace's edges,
 *  pointers, tasks, suggestions and graph positions, in one request. */
export async function loadBootstrapRelations(): Promise<Pick<Bootstrap, "edges" | "pointers" | "tasks" | "suggestions" | "graph_positions">> {
  return call<Pick<Bootstrap, "edges" | "pointers" | "tasks" | "suggestions" | "graph_positions">>("loadBootstrapRelations");
}

/** One page of attribute rows (drawings excluded) for the notes' attrs maps:
 *  pass 0, then the previous page's `next`; `next` is null on the last page.
 *  Each page is a separate request, so others run between pages. */
export async function loadAttributePage(after: number, limit: number): Promise<{ rows: Array<{ node_id: string; key: string; value: string }>; next: number | null }> {
  return call("loadAttributePage", [after, limit]);
}

/** Receive remote content while preserving still-pending note text on readable
 * nodes and reconstructing absent notes from durable create input. Revoked
 * cached metadata/relations are removed. Returns the projection the UI must use.
 * Cache persistence is scheduled;
 * this is not a new durable-write acknowledgement. */
export async function persistBootstrap(data: Bootstrap): Promise<Bootstrap> {
  // No copy: nothing is queued locally, so the server's data is the projection.
  if (getLocalCopyState() === "none") return data;
  return call<Bootstrap>("persistBootstrap", [data]);
}

/** Offline copy for large workspaces (bodies stay out of the in-memory store).
 *  One page of notes whose body this device has not downloaded, most recently
 *  updated first. Pass "" to start, then the previous page's `next`; `next` is
 *  null on the last page. */
export async function missingBodyIds(cursor: string, limit: number): Promise<{ ids: string[]; next: string | null }> {
  return call<{ ids: string[]; next: string | null }>("missingBodyIds", [cursor, limit]);
}

/** Save downloaded bodies locally; never replaces newer text or queued notes.
 *  Resolves to how many were stored. */
export async function storeDownloadedBodies(bodies: Array<{ id: string; markdown: string }>): Promise<number> {
  return call<number>("storeDownloadedBodies", [bodies]);
}

/** The body this device holds for a note, or null if it was never downloaded. */
export async function getStoredBody(id: string): Promise<string | null> {
  return call<string | null>("getStoredBody", [id]);
}

/** Drop a note's stored body after the server refused it (kept while local edits are queued). */
export async function forgetBody(id: string): Promise<boolean> {
  return call<boolean>("forgetBody", [id]);
}

/** Same pending-text contract as persistBootstrap, including remote deletes. */
export async function applySync(delta: SyncDelta): Promise<AppliedSyncDelta> {
  return call<AppliedSyncDelta>("applySync", [delta]);
}

/** Receive a freshly authorized single-node read, using the same pending-text
 * projection as bootstrap and sync. Local optimistic writes use upsertNode. */
export async function persistRemoteNode(node: ContentNode): Promise<ContentNode> {
  if (getLocalCopyState() === "none") return node; // nothing to persist: the server's row is the projection (as persistBootstrap)
  return call<ContentNode>("persistRemoteNode", [node]);
}

// ── Attribute mutation helpers (used by useAppData's offline write-through) ─

export async function upsertAttribute(
  nodeId: string, key: string, value: string, valueType = "text",
  isInheritable = false, source = "ui",
): Promise<void> {
  await call<void>("upsertAttribute", [nodeId, key, value, valueType, isInheritable, source]);
}

export async function removeAttribute(nodeId: string, key: string): Promise<void> {
  await call<void>("removeAttribute", [nodeId, key]);
}

/** Read one mirrored attribute value — offline cold-start fallback for ink
 *  hosts whose primary read is a network GET. Returns null when unmirrored. */
export async function getNodeAttribute(nodeId: string, key: string): Promise<string | null> {
  return call<string | null>("getNodeAttribute", [nodeId, key]);
}

export async function getNodeAttributeRecord(nodeId: string, key: string): Promise<NodeAttribute | null> {
  return call<NodeAttribute | null>("getNodeAttributeRecord", [nodeId, key]);
}

/** Advance ONLY the sync cursor — for deltas whose 500-event window carried
 *  nothing the frontend projects (governance/audit events). */
export async function setLastEventId(id: number | string): Promise<void> {
  await call<void>("setLastEventId", [id]);
}

export async function getLastEventId(): Promise<number> {
  if (getLocalCopyState() === "none") return 0; // no copy, no cursor
  return call<number>("getLastEventId");
}

/** The membership epoch the client last reconciled to (Step B). The client runs
 *  membership reconciliation ONLY when the server's epoch exceeds this. */
export async function setMembershipEpoch(epoch: number): Promise<void> {
  await call<void>("setMembershipEpoch", [epoch]);
}

export async function getMembershipEpoch(): Promise<number> {
  return call<number>("getMembershipEpoch");
}

/** Keep a copy of server attribute values of a note this device holds but
 *  lacks those values of (a drawing read on open); existing copies win. */
export async function fillNodeAttributes(nodeId: string, rows: Array<{ key: string; value: string; value_type?: string; is_inheritable?: boolean; source?: string }>): Promise<void> {
  await call<void>("fillNodeAttributes", [nodeId, rows]);
}

/** Keep copies of server attribute values (several notes); existing copies
 *  win, notes this device does not hold are skipped. Resolves to rows kept. */
export async function fillAttributeRows(rows: Array<{ node_id: string; key: string; value: string; value_type?: string; is_inheritable?: boolean; source?: string }>): Promise<number> {
  return call<number>("fillAttributeRows", [rows]);
}

/** The offline drawing download's to-do list: drawings held notes lack, and
 *  copies that differ from the server's and may be replaced. */
export async function planDrawings(index: Array<{ node_id: string; key: string; size: number; hash?: string }>): Promise<{ missing: string[]; stale: Array<{ node_id: string; key: string; localHash: string }> }> {
  return call("planDrawings", [index]);
}

/** Replace stale copies with the server's value, each only while it still has
 *  the planned hash and no attribute write of its note is queued. */
export async function replaceStaleAttributeRows(rows: Array<{ node_id: string; key: string; value: string; value_type?: string; is_inheritable?: boolean; source?: string; expected_hash: string }>): Promise<number> {
  return call<number>("replaceStaleAttributeRows", [rows]);
}

/** When the mirror last stored a whole bootstrap (ms since epoch), 0 if never. */
export async function getLastFullRefresh(): Promise<number> {
  return call<number>("getLastFullRefresh");
}

/** The COMPLETE local membership set (node ids ∪ task ids) for the CVR /
 *  reconciliation diff — task nodes are in readableNodeIdSet() but live in the
 *  local tasks table, so a nodes-only set mis-diffs them. */
export async function getAllMembershipIds(): Promise<string[]> {
  return call<string[]>("getAllMembershipIds");
}

/** The node ids the client currently holds (its CVR / "known" set). Sent on
 *  sync so the backend can emit deletes for any that LEFT the read set via a
 *  permission change (those carry no node-targeted event — HIGH gap #2). */
export async function getAllNodeIds(): Promise<string[]> {
  return call<string[]>("getAllNodeIds");
}

export async function upsertNode(n: ContentNode): Promise<void> {
  await call<void>("upsertNode", [n]);
}

export async function removeNode(id: string): Promise<void> {
  await call<void>("removeNode", [id]);
}

export async function upsertEdge(e: NodeEdge): Promise<void> {
  await call<void>("upsertEdge", [e]);
}

export async function removeEdge(id: string): Promise<void> {
  await call<void>("removeEdge", [id]);
}

export async function upsertWorkspace(workspace: Workspace, settings: WorkspaceSettings): Promise<void> {
  await call<void>("upsertWorkspace", [workspace, settings]);
}

export async function upsertTask(t: NodeTask): Promise<void> {
  await call<void>("upsertTask", [t]);
}

export async function removeTask(id: string): Promise<void> {
  await call<void>("removeTask", [id]);
}

// Canvas offline mirror (survives cold reload before the queue drains; canvases
// never travel through /api/sync, so this is fed by the GET /api/canvases[/:id]
// reads + the optimistic canvas writes). `data` optional: omit for a list-row
// meta upsert (keeps any existing layout), pass it to overwrite the layout.
export async function upsertCanvas(c: { id: string; title: string; created_at?: string | null; updated_at?: string | null; data?: CanvasData | null }): Promise<void> {
  await call<void>("upsertCanvas", [c]);
}

export async function removeCanvas(id: string): Promise<void> {
  await call<void>("removeCanvas", [id]);
}

export async function loadCanvases(): Promise<CanvasMeta[]> {
  return call<CanvasMeta[]>("loadCanvases");
}

export async function loadCanvas(id: string): Promise<Canvas | null> {
  return call<Canvas | null>("loadCanvas", [id]);
}

/** Make the mirror hold, for these notes on canvas `canvasId`, exactly the
 *  rows of `present` (a note of `nodeIds` absent from it is off the board).
 *  Resolves once the mirror took it (saved with the next snapshot). */
export async function putCanvasMemberships(canvasId: string, nodeIds: string[], present: CanvasMembership[]): Promise<void> {
  await call<void>("putCanvasMemberships", [canvasId, nodeIds, present]);
}

/** One note's hand-placed global-graph position in the mirror; null removes it. */
export async function putGraphPosition(nodeId: string, position: { x: number; y: number } | null): Promise<void> {
  await call<void>("putGraphPosition", [nodeId, position]);
}

/** `targets`: what the write acts on, recorded when queued; absent on rows
 *  queued by older builds — read them through writeTargets(), never the path. */
export type PendingWrite = { id: number; method: string; path: string; body: string | null; idem_key: string | null; attempts: number; targets?: WriteTarget[] };
export type RejectedWrite = PendingWrite & { rejection: string };
export type RejectedRequest = Pick<PendingWrite, "method" | "path" | "body"> & { idem_key: string };

/** Preserve a directly refused request without ever making it replayable.
 * Resolves after disk commit. Reusing a key requires the exact same request. */
export async function storeRejectedWrite(request: RejectedRequest, reason: string): Promise<RejectedWrite> {
  return call<RejectedWrite>("storeRejectedWrite", [request, reason]);
}

export async function addPendingWrite(method: string, path: string, body: string | null, idemKey?: string | null): Promise<void> {
  await call<void>("addPendingWrite", [method, path, body, idemKey]);
}

export async function getPendingWrites(): Promise<PendingWrite[]> {
  if (getLocalCopyState() === "none") return [];
  return call<PendingWrite[]>("getPendingWrites");
}

export async function getOldestPendingWriteAt(): Promise<string | null> {
  return call<string | null>("getOldestPendingWriteAt");
}

export async function clearPendingWrite(id: number): Promise<void> {
  await call<void>("clearPendingWrite", [id]);
}

/** Retain the exact request outside automatic replay. Resolves after the
 * rejected state is durable; on failure the original pending row remains.
 * The request must still match, including across a local backup replacement. */
export async function rejectPendingWrite(write: PendingWrite, reason: string): Promise<RejectedWrite> {
  return call<RejectedWrite>("rejectPendingWrite", [write, reason]);
}

export async function getRejectedWrites(): Promise<RejectedWrite[]> {
  return call<RejectedWrite[]>("getRejectedWrites");
}

/** User-requested removal of a rejected local input; no server request.
 * Failed persistence retains the recovery entry. */
export async function dismissRejectedWrite(write: RejectedWrite): Promise<void> {
  return call<void>("dismissRejectedWrite", [write]);
}

export async function bumpPendingWriteAttempt(id: number): Promise<number> {
  return call<number>("bumpPendingWriteAttempt", [id]);
}

export async function searchNodes(query: string): Promise<Array<{ id: string; snippet: Snippet | null }>> {
  return call<Array<{ id: string; snippet: Snippet | null }>>("searchNodes", [query]);
}

export async function exportDatabase(): Promise<File> {
  // The worker returns raw bytes (cheap to transfer); wrap them in a File here
  // so the download/import surfaces keep the same return type as before.
  const buf = await call<ArrayBuffer>("exportDatabase");
  return new File([buf], "onden.sqlite3", { type: "application/x-sqlite3" });
}

/** Replace the local snapshot after validation and durable storage. Rejects
 * unrelated/different-workspace backups and keeps the current DB on failure.
 * This does not restore server history, media files or browser preferences. */
export async function importDatabase(data: ArrayBuffer): Promise<void> {
  await call<void>("importDatabase", [data]);
}

// ── Close-path durability barrier ───────────────────────────────────────────
// The persist scheduler debounces the sql.js snapshot by 2s and runs it inside
// the worker. The scheduler's own pagehide/beforeunload flush is dead weight in
// the worker (no `window`), so a tab closed within that 2s window dropped the
// batch permanently. `installUnloadFlush()` wires the MAIN thread's real unload
// signals — pagehide and visibilitychange→hidden (the reliable mobile/bfcache
// hooks) — to a `flushLocalDbSync` RPC, which makes the worker export + write to
// IndexedDB IMMEDIATELY instead of after the debounce. This is the only channel
// on the close path that actually lands on disk. Queued writes and deletes are
// already on disk by then (the worker's journal, lib/localDbJournal), so the
// flush writes the snapshot only when mirror changes are pending.

/** Tell the worker to flush the pending snapshot to IndexedDB right now (cancels
 *  the debounce). Best-effort: it returns a promise but the unload path can't
 *  truly block on the round-trip — firing it the instant the page hides is what
 *  gives the IndexedDB write a chance to commit before teardown. */
export async function flushLocalDbSync(): Promise<void> {
  await call<void>("flushLocalDbSync");
}

/** Save the local copy again now, after "could not be saved" (storage full).
 *  Rejects while it still fails; success clears the notice by itself. */
export async function retryLocalSnapshotSave(): Promise<void> {
  await call<void>("retrySnapshotSave");
}

let unloadFlushInstalled = false;

/** Wire pagehide / visibilitychange→hidden to flushLocalDbSync. Idempotent (safe
 *  to call from every mount). Returns a disposer that removes the listeners. */
export function installUnloadFlush(): () => void {
  if (typeof window === "undefined" || unloadFlushInstalled) return () => {};
  unloadFlushInstalled = true;
  const flush = () => { void flushLocalDbSync().catch(() => {}); };
  // Both leaving signals relay to the worker's synchronous-intent flush.
  const stop = onPageHide(flush);
  return () => {
    stop();
    unloadFlushInstalled = false;
  };
}

export type { AttributeDelta };

/** What the app receives and applies for one sync: the server's SyncDelta (@onden/contract) with the few fields the app
 *  reads more loosely or through its own types. Everything not overridden here is the server's shape as it is. */
export type SyncDelta = Omit<WireSyncDelta, "last_event_id" | "head_event_id" | "resync_required" | "tags" | "nodes" | "pointers" | "canvas_memberships" | "site_config" | "chrome"> & {
  // PostgreSQL bigint ids arrive over JSON as decimal strings in production.
  last_event_id: number | string;
  /** Where the server's event log ends; a cursor beyond it means the server went back. Absent from an older server. */
  head_event_id?: string;
  /** Fail-closed escape hatch: the server couldn't compute a complete membership diff (the held set exceeded the diff
   *  cap). The client must drop its mirror and re-bootstrap to re-establish a correct baseline. */
  resync_required?: boolean;
  /** Complete currently visible tag catalog; omitted keeps the cached catalog, [] clears it. */
  tags?: Tag[];
  nodes: { upsert: ContentNode[]; delete: string[] };
  /** Sidebar pointers; `replace_for` works like edges. Older servers omit it. */
  pointers?: { upsert: NotePointer[]; delete: string[]; replace_for?: string[] };
  /** `delete`: the explicit removals applySync turns `replace_for` into, so its result carries explicit removals only. */
  canvas_memberships?: { upsert: CanvasMembership[]; delete?: CanvasMembershipKey[]; replace_for?: string[] };
  /** The site config and chrome, the reader's view as the bootstrap ships them; present only after they changed. */
  site_config?: Bootstrap["site_config"];
  chrome?: Bootstrap["chrome"];
};

/** Worker result, never a server permission or wire channel. Apply remote
 * deletes (including dependent cleanup) before these reconstructed own inputs. */
export type AppliedSyncDelta = SyncDelta & {
  pendingCreations?: ContentNode[];
  /** Notes whose server text the delta carried but a queued write of this device kept on top: once that write is
   *  gone, the server's row (the merge of both) is what to show (syncEngine.releaseHeldNotes). */
  heldText?: string[];
};
