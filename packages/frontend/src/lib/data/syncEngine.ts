// The sync engine (depth audit D6): everything that keeps the on-device copy
// and the store in step with the server — boot (cached paint, slim/full
// bootstrap), refresh, sync() with the membership reconcile, lazy note bodies
// (hydrateNode + the in-memory LRU), the offline body download, reconnect and
// the user-folder export. It used to live in lib/useAppData; connectivity.ts
// now orders these steps over the window's lifecycle. Callers outside lib/data
// reach it through `dataSync` (sync.ts).
//
// Ordering and fail-closed rules are documented where they are enforced
// below (GAP-249 boot cursor, the membership dirty-latch, slim mode ⑤, the
// display gate). Behaviour is unchanged from useAppData.

import { announceDrawingChangesOf } from "../drawingChanges";
import { applyAnchorsOfDelta, replaceAllAnchors, replaceAllBindings, applyServerFeatures, restoreBlockAnchorsEnabled } from "../blockAnchorStore";
import { applyPatch, isUuid, type TextPatch } from "@onden/markdown";
import { api, ApiError, nodeNeedsBody, readWithDeadline, noWorkspaceData, type Bootstrap, type ContentNode } from "../api";
import { SLIM_MODE_NODE_THRESHOLD } from "../slimMode";
import { initLocalDb, getNodeAttribute, useMemoryOnlyLocalCopy, wipeWorkspaceMirror, loadBootstrapList, loadBootstrapRelations, loadAttributePage, persistBootstrap, persistRemoteNode, getStoredBody, forgetBody, missingBodyIds, storeDownloadedBodies, applySync, getLastEventId, setLastEventId, getMembershipEpoch, setMembershipEpoch, getAllMembershipIds, getLastFullRefresh, fillAttributeRows, planDrawings, replaceStaleAttributeRows, exportDatabase, importDatabase, getPendingWrites, type SyncDelta } from "../localDb";
import { getStoragePref, getStoredDirHandle, requestDirPermission, readDbFromDir, writeDbToDir } from "../fileSystemStorage";
import {
  getAppState, setAppState,
  setData, setOnline, setBootstrapped, setMembershipGated, setAccessRevoked, getNode } from "../appStore";
import { forgetVerifiedAccount } from "../accountStorage";
import { canvasList } from "../canvasList";
import { targetsEntity, withoutPendingCreates, type TargetedWrite } from "../pendingWriteTargets";
import { noteMembershipEpoch } from "../spaces";
import { bindDomainLifecycle, canvasWriter } from "./domainWriters";
import { isBodyInUse } from "./draftActions";
import { sendWrite } from "./onlineWrite";
import { flushPendingWrites, getReplayRejectionRevision, hasPendingWrite } from "./writeQueue";
import { refreshPendingCount } from "./syncStatus";
import { setIncomingProblem } from "./incomingStatus";
import { applySyncDelta, isEmptyDelta } from "./storeOps";
import { reconcileMembership, type MembershipDigest, type MembershipPage, type MembershipProjection } from "./membershipReconcile";
import { webCryptoSha256 } from "./membershipDigest";
import { mergeAttributeRows, mergeBootstrapRelations } from "./bootRest";
import { projectBootstrapForPaint, reconcilePersistedBootstrap } from "./bootPaint";
import { isServerUnreachable } from "./writeErrors";
import { bindDeviceStatus } from "./deviceStatus";
import { isBrowserOnline, prefersSavedData } from "../browserNetwork";
import { getLocalCopyState } from "../localCopyState";
import { BOOTSTRAP_HEADER_VALUE, decodeBootstrapWire } from "./bootstrapWire";
import { assertBootstrapShape, assertSyncDeltaShape } from "./wireShape";

// ── User-folder export (fs-access) ───────────────────────────────────────────

let dirHandle: FileSystemDirectoryHandle | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleUserFolderSync(): void {
  if (!dirHandle) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (!dirHandle) return;
    // The folder copy is the person's own file: it gets every drawing, not
    // only those opened here (a lean bootstrap leaves them out).
    void downloadDrawingsForOffline({ force: true })
      .then(() => exportDatabase()).then((file) => writeDbToDir(dirHandle!, file)).catch(() => null);
  }, 2000);
}

// ── Module-level lifecycle actions (stable identities) ───────────────────────

/** The write queue as it was when a bootstrap was requested: what
 *  pruneCanvasMirror needs, with the server's time of the read, to tell a
 *  deleted board from a new one. */
async function canvasListMark(): Promise<{ queued: readonly TargetedWrite[] | null }> {
  return { queued: await getPendingWrites().catch(() => null) };
}

/** The canvas list is the canvas nodes in the store (lib/canvasList, D75).
 *  Once a bootstrap has landed, drop the offline layout of any board that is no
 *  longer one of them, so a board deleted on another device leaves this
 *  device's mirror too (canvasWriter.pruneMirror). Without the queue as it was,
 *  an in-flight create could look deleted: skip. */
function pruneCanvasMirror({ queued }: { queued: readonly TargetedWrite[] | null }, listedAt: string | undefined): void {
  // `listedAt` is the SERVER's time of the read (server_time): a board's
  // created_at is the server's clock, and this device's can be minutes ahead.
  // An older server sends none: leave the mirror as it is.
  if (!queued || !listedAt) return;
  void canvasWriter.pruneMirror(canvasList(getAppState().data.nodes), listedAt, queued).catch(() => null);
}

/** GET a bootstrap in its lean shape (backend services/sync/bootstrap.ts: no
 *  attrs maps, no drawings; the compact encoding is decoded by
 *  bootstrapWire), with each node's attrs map rebuilt from the typed
 *  `attributes` rows. An older server answers in the old shape, used
 *  as it is. */
async function fetchBootstrap(path: string): Promise<Bootstrap> {
  const epochAtRequest = await getMembershipEpoch().catch(() => undefined);
  const data = decodeBootstrapWire(await api<Bootstrap>(path, { headers: { "X-Onden-Bootstrap": BOOTSTRAP_HEADER_VALUE } }));
  assertBootstrapShape(data); // before anything below touches memory or the local copy
  const carried = data.nodes?.map((n) => n.id);
  replaceAllAnchors(data.note_anchors, carried);
  replaceAllBindings(data.note_link_bindings, carried);
  applyServerFeatures(data.features);
  // New notes may have come with it, without their drawings.
  drawingsComplete = false;
  const bootstrap = data.attrs_omitted === true ? withAttrsFromRows(data) : data;
  if (epochAtRequest !== undefined) membershipEpochAtRequest.set(bootstrap, epochAtRequest);
  return bootstrap;
}

/** The membership epoch the mirror had reconciled to when each bootstrap was requested. A bootstrap lists
 *  the notes readable at its own moment; if a sync reconciled membership while it downloaded, landing it
 *  puts back a note that was revoked meanwhile, or drops one that was granted. */
const membershipEpochAtRequest = new WeakMap<Bootstrap, number>();

/** A bootstrap that landed needs the readable set checked again: the mirror's
 *  epoch moved while it downloaded (`atRequest` → `now`), unless the payload
 *  itself lists the readable set of that same epoch (`listedAt`, its own
 *  snapshot) — a cold device's first reconcile only caught up to what the
 *  payload already had. Checking again then raised the fail-closed gate a
 *  moment after load, under the person's typing (it ended IME compositions). */
export function bootstrapMembershipStale(atRequest: number | undefined, now: number, listedAt: number | undefined): boolean {
  return atRequest !== undefined && atRequest !== now && listedAt !== now;
}

async function membershipMovedSince(bootstrap: Bootstrap): Promise<boolean> {
  const atRequest = membershipEpochAtRequest.get(bootstrap);
  if (atRequest === undefined) return false;
  const now = await getMembershipEpoch().catch(() => atRequest);
  return bootstrapMembershipStale(atRequest, now, bootstrap.membership_epoch);
}

function withAttrsFromRows(data: Bootstrap): Bootstrap {
  const byNode = new Map<string, Record<string, string>>();
  for (const row of data.attributes ?? []) {
    const attrs = byNode.get(row.node_id);
    if (attrs) attrs[row.key] = row.value; else byNode.set(row.node_id, { [row.key]: row.value });
  }
  return { ...data, nodes: data.nodes.map((node) => ({ ...node, attrs: byNode.get(node.id) ?? {} })) };
}

// A whole bootstrap from the server replaces the store, edges and attrs
// included, so the mirror's rest (loadLocalRest) read before it is stale.
let wholeBootstrapGeneration = 0;
function setWholeBootstrap(data: Bootstrap): void {
  wholeBootstrapGeneration++;
  setData(data);
}

const ATTRIBUTE_PAGE_ROWS = 10_000;

/** Warm boot, second phase: the edges, tasks, attrs … loadBootstrapList left
 *  out, read from the mirror in separate requests (so sync's requests run
 *  between them) and merged as each arrives (bootRest: the store wins). Skipped
 *  once a whole server bootstrap has replaced the store (that one carries them).
 *  A failed read is retried; if it keeps failing the lists show without their
 *  relations until the next full refresh, and the console says so. */
async function loadLocalRest(generation: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (generation !== wholeBootstrapGeneration) return;
    try {
      const relations = await loadBootstrapRelations();
      if (generation !== wholeBootstrapGeneration) return;
      setData((prev) => mergeBootstrapRelations(prev, relations));
      for (let after = 0; ;) {
        const page = await loadAttributePage(after, ATTRIBUTE_PAGE_ROWS);
        if (generation !== wholeBootstrapGeneration) return;
        setData((prev) => mergeAttributeRows(prev, page.rows));
        if (page.next === null) return;
        after = page.next;
      }
    } catch (error) {
      if (attempt === 2) console.warn("[onden] the cached edges and attributes could not be read", error);
      else await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

/** Cold boot: show `next` now, with the queued note text applied from one read
 *  of the queue, then have the worker write the mirror. Resolves with the
 *  worker's projection once it is persisted (a failure rejects, as
 *  persistBootstrap does; the paint stays). The store is reconciled with that
 *  projection only where the queue changed in between (bootPaint). `onPaint`
 *  runs right after the paint.
 *
 *  The queue is read before the worker is asked to write: the worker answers
 *  one request at a time, so a read posted behind the write waited for the
 *  whole write (seconds at 20k notes on a phone) and the paint with it. */
async function paintThenPersist(next: Bootstrap, onPaint: () => void): Promise<Bootstrap> {
  const pending = next.nodes_omitted === true ? [] : await getPendingWrites().catch(() => null);
  // Unreadable queue: wait for the worker's own projection rather than show
  // text without the user's pending edits.
  if (!pending) { const applied = await persistBootstrap(next); setWholeBootstrap(applied); onPaint(); return applied; }
  const painted = projectBootstrapForPaint(next, pending);
  setWholeBootstrap(painted);
  onPaint();
  const applied = await persistBootstrap(next);
  setData((prev) => reconcilePersistedBootstrap(prev, painted, applied));
  return applied;
}

// A bootstrap is downloaded without any lock and can take seconds on a phone,
// while sync() applies newer deltas. Landing it is therefore one step at a
// time and never alongside a sync(): it waits for the sync in flight, sync()
// waits for it, and a bootstrap older than the mirror's cursor rewinds the
// cursor to its own position (the worker) and triggers a sync that replays the
// difference. `bootstrapLanding` is set only while it is actually landing, so
// the two waits cannot meet in a cycle.
let bootstrapLanding: Promise<void> | null = null;
/** The sync() in flight is still waiting for boot's cursor (bootCursorReady): it writes nothing yet, and boot's
 *  own retry download must not wait for it, or each waits for the other. */
let syncWaitingForBoot = false;
let landingTail: Promise<unknown> = Promise.resolve();

/** Persist `next` and swap it into the store. `insideSync`: called by sync()
 *  itself (resync_required), which already is the only writer. */
async function landBootstrap(next: Bootstrap, { insideSync = false } = {}): Promise<Bootstrap> {
  const land = async () => {
    const before = await getLastEventId();
    const applied = await persistBootstrap(next);
    setWholeBootstrap(applied);
    return { applied, rewound: await getLastEventId() < before, outdatedMembership: await membershipMovedSince(next) };
  };
  if (insideSync) return (await land()).applied; // sync() checks membership itself afterwards
  const turn = landingTail.catch(() => {}).then(async () => {
    while (syncInFlight && !syncWaitingForBoot) await syncInFlight.catch(() => {});
    let release!: () => void;
    bootstrapLanding = new Promise<void>((resolve) => { release = resolve; });
    try { return await land(); }
    finally { bootstrapLanding = null; release(); }
  });
  landingTail = turn;
  const { applied, rewound, outdatedMembership } = await turn;
  // The saved epoch alone would let the replay skip the reconcile: check the readable set once more.
  if (outdatedMembership) reconciledRejectionRevision = null;
  if (rewound || outdatedMembership) void sync();
  return applied;
}

// The browser's 'offline' events so far (wentOffline). A reply to a request
// sent before one of them says nothing about now: landing a moment after the
// event (an idle full bootstrap, measured 2026-10-31) it flipped the app back
// online while the browser was offline. The 'online' event's reconnect is what
// goes online again.
let offlineEvents = 0;

/** Online, because the server answered a request sent when `offlineEvents`
 *  was `since` — unless the browser has gone offline since. */
function answeredOnline(since: number): void {
  if (since === offlineEvents) setOnline(true);
}

export async function refresh(): Promise<void> {
  await refreshWhole({ insideSync: false });
}

/** refresh(), saying whether the whole bootstrap landed. Only a server that
 *  cannot be reached means offline: any other failure (the local copy, a
 *  refusal) leaves the connection state alone and is logged. */
async function refreshWhole(landing: { insideSync: boolean } = { insideSync: false }): Promise<boolean> {
  const since = offlineEvents;
  try {
    // ⑤ scale: a big workspace must refresh SLIM too — a full /api/bootstrap
    // here would re-pull every body into the heap (and, since bodies!=='none'
    // disables the LRU, leave them resident), defeating slim mode on every
    // reconnect / online-transition. Gate on the current node count, which the
    // slim bootstrap itself confirms.
    const big = (getAppState().data?.nodes.length ?? 0) >= SLIM_MODE_NODE_THRESHOLD;
    const mark = await canvasListMark();
    const next = big
      ? await fetchBootstrap("/api/bootstrap?bodies=none")
      : await fetchBootstrap("/api/bootstrap");
    await landBootstrap(next, landing);
    answeredOnline(since);
    pruneCanvasMirror(mark, next.server_time);
    await canvasWriter.refreshOpenCanvas();
    return true;
  } catch (error) {
    if (getAppState().accessRevoked) return false;
    if (isServerUnreachable(error)) setOnline(false);
    else console.warn("[onden] the refresh failed", error);
    return false;
  } finally {
    setBootstrapped(true);
  }
}

// ── Reopen: deltas, not the whole bootstrap ──────────────────────────────────
//
// A device with a mirror and an event cursor is brought current by the sync
// deltas. It used to re-download the whole bootstrap on every reopen anyway —
// the slim one above 2,000 notes (3 MB at 5k, 10 MB at 20k, on a phone on 4G),
// the full one below — and again after every reconnect. Now the whole
// bootstrap comes at most once a day (FULL_REFRESH_MAX_AGE_MS, timed by the
// mirror's own record of its last snapshot) or when the server asks
// (resync_required); in between, only the ?nodes=none payload: the parts the
// delta does not carry (graph positions, suggestions, recent events, catalog,
// site config, chrome, the actor's flags), plus a full copy of the boards a
// note is on, which the delta otherwise keeps current (D98).

/** The longest a mirror goes without a whole bootstrap. */
export const FULL_REFRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** True when this mirror has not stored a whole bootstrap in the last day
 *  (or never, or its clock says one is from the future). */
async function fullRefreshDue(): Promise<boolean> {
  let at = 0;
  try { at = await getLastFullRefresh(); } catch { return true; }
  const age = Date.now() - at;
  return !(at > 0 && age >= -FULL_REFRESH_MAX_AGE_MS && age < FULL_REFRESH_MAX_AGE_MS);
}

/** The bootstrap fields a ?nodes=none payload refreshes; everything per-node
 *  stays as the store has it. */
function mergeBootstrapMeta(prev: Bootstrap, meta: Bootstrap): Bootstrap {
  return {
    ...prev,
    workspace: meta.workspace,
    suggestions: meta.suggestions,
    events: meta.events,
    actor_role: meta.actor_role,
    actor_is_owner: meta.actor_is_owner,
    can_review: meta.can_review,
    ...(meta.tags !== undefined ? { tags: meta.tags } : {}),
    site_config: meta.site_config,
    chrome: meta.chrome,
    timezone: meta.timezone,
    canvas_memberships: meta.canvas_memberships,
    graph_positions: meta.graph_positions,
  };
}

/** Refresh what the sync delta does not carry (?nodes=none). An older server
 *  answers with the whole bootstrap instead (no nodes_omitted): left unused,
 *  as its capped full payload would replace a large mirror. Throws when the
 *  server cannot be reached. */
export async function refreshMeta(): Promise<void> {
  const mark = await canvasListMark();
  const meta = await api<Bootstrap>("/api/bootstrap?nodes=none");
  assertBootstrapShape(meta);
  if (meta.nodes_omitted !== true) return;
  applyServerFeatures(meta.features);
  await persistBootstrap(meta);
  setData((prev) => mergeBootstrapMeta(prev, meta));
  pruneCanvasMirror(mark, meta.server_time);
}

/** After a reconnect: the daily whole refresh when due, else the meta one. */
export async function refreshIfStale(): Promise<void> {
  if (await fullRefreshDue()) return refresh();
  await refreshMeta().catch(() => null);
}

/** A reopen's background refresh, once the gate is down: the whole bootstrap
 *  when the daily one is due (slim for a large workspace, which stays slim),
 *  else the meta one. Failures are quiet: the deltas already brought the
 *  mirror current, and the next reopen or reconnect tries again. */
async function refreshOnReopen(big: boolean): Promise<void> {
  if (!await fullRefreshDue()) return refreshMeta();
  if (!big) { await hydrateFullBootstrap(); return; }
  const mark = await canvasListMark();
  const next = await fetchBootstrap("/api/bootstrap?bodies=none");
  await landBootstrap(next);
  pruneCanvasMirror(mark, next.server_time);
}

// Fetch the FULL bootstrap (all node bodies) and swap it into the store,
// then persist the offline cache. Throws on failure so the inline caller's
// try/catch (which decides the no-shell fallback) can react; the deferred
// idle caller wraps it in its own catch (offline mid-idle is benign — the
// slim shell and lazy hydrateNode keep working).
export async function hydrateFullBootstrap(): Promise<string | undefined> {
  const since = offlineEvents;
  const next = await fetchBootstrap("/api/bootstrap");
  await landBootstrap(next);
  answeredOnline(since);
  return next.server_time;
}

/** Max full bodies kept in memory during a slim session (④ LRU). */
export const HYDRATED_BODY_CAP = 150;

// Run on the next idle slice (or after a short timeout where the browser has
// no idle callback). Used to defer the full-bootstrap hydration after a slim
// first paint so the slim memory/latency win actually lands — the shell stays
// interactive and slim while bodies stream in lazily (hydrateNode on open),
// and the heavy full payload only arrives once the main thread is quiet.
function onIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === "function") ric(fn, { timeout: 3000 });
  else setTimeout(fn, 1200);
}


// Lazy-body door: swap ONE node's full row (markdown + enriched fields)
// into the store. Used when a slim-bootstrap row is opened in the editor
// before the full payload has landed. Best-effort — a note this device never
// stored stays on the loading guard while offline.
//
// LRU (④): in a slim session every opened note accumulates its full body
// in memory forever — cap it. Eviction returns a row to its slim shape
// (markdown "" + body_len kept) so nodeNeedsBody stays TRUE and a re-open
// re-hydrates; it NEVER runs once the full bootstrap landed
// (bodies !== "none"), because a full-mode row carries no body_len and an
// emptied body would read as the real one — the wipe hazard.
const hydratedLru = new Map<string, number>();
let hydrateSeq = 0;
// Notes whose delta text was kept behind a queued write of this device (AppliedSyncDelta.heldText). Once nothing
// is queued for the note any more, the server's row, which merged both edits, is read again: no later delta carries it.
const heldBehindQueue = new Set<string>();

async function releaseHeldNotes(): Promise<void> {
  for (const id of [...heldBehindQueue]) {
    if (await hasPendingWrite((write) => targetsEntity(write, "node", id))) continue;
    heldBehindQueue.delete(id);
    await hydrateNode(id);
  }
}

export async function hydrateNode(id: string): Promise<void> {
  // Local first: show the body this device already stored (downloaded for
  // offline use or opened before) at once, then confirm with the server. A
  // newer server body replaces it — the editor adopts it while it has no unsaved
  // input (draftActions.applyRemoteNode); otherwise the save merges from the
  // shown text. Offline, the stored body is all there is.
  const before = getNode(id)?.markdown;
  const stored = await getStoredBody(id).catch(() => null);
  if (stored !== null) adoptBody(id, (row) => nodeNeedsBody(row), { markdown: stored });
  let full: ContentNode;
  try {
    full = await persistRemoteNode(await api<ContentNode>(`/api/nodes/${id}`));
  } catch (error) {
    // A refusal (no access, gone) is the server's answer: take back a local copy
    // shown from this device, in memory and in the offline mirror, rather than
    // keep displaying a note the server no longer serves. A 401 is the session,
    // not the note: the sign-in gate handles it and the copy stays.
    if (stored !== null && error instanceof ApiError && [403, 404, 410].includes(error.status)) {
      adoptBody(id, (row) => row.markdown === stored, { markdown: "" }, (stored.length || 1));
      void forgetBody(id).catch(() => null);
    }
    return; // offline / unreachable: keep the stored body (or the slim row)
  }
  // Only replace a row nothing else changed since this read began (its text is
  // still what it was, or the stored body shown above): a save made meanwhile
  // is newer than a response that may have been read before it.
  adoptBody(id, (row) => row.markdown === before || (stored !== null && row.markdown === stored), full);
}

/** Put a body (or a full server row) into the store for one note, keeping the
 *  LRU of in-memory bodies (④). `when` is checked against the CURRENT row inside
 *  the update, so a row that changed since the read is left alone. `slimLength`
 *  turns the row back into a slim one (markdown "" + that body_len). */
function adoptBody(id: string, when: (row: ContentNode) => boolean, fields: Partial<ContentNode>, slimLength?: number): void {
  hydratedLru.set(id, ++hydrateSeq);
  // Eviction set computed OUTSIDE the updater — state updaters must stay
  // pure (React may re-invoke them), and the LRU map mutation is a side
  // effect.
  let evict: Set<string> | null = null;
  if (hydratedLru.size > HYDRATED_BODY_CAP) {
    const oldest = [...hydratedLru.entries()]
      .sort((a, b) => a[1] - b[1])
      .filter(([nid]) => nid !== id && !isBodyInUse(nid))
      .slice(0, hydratedLru.size - HYDRATED_BODY_CAP)
      .map(([nid]) => nid);
    for (const nid of oldest) hydratedLru.delete(nid);
    if (oldest.length > 0) evict = new Set(oldest);
  }
  setData((prev) => {
    let nodes = prev.nodes.map((n) => {
      if (n.id !== id || !when(n)) return n;
      return slimLength !== undefined
        ? { ...n, ...fields, body_len: slimLength }
        : { ...n, ...fields, body_len: fields.markdown?.length ?? 0 };
    });
    if (evict && prev.bodies === "none") {
      nodes = nodes.map((n) =>
        evict.has(n.id) && (n.body_len ?? 0) > 0 ? { ...n, markdown: "" } : n,
      );
    }
    return { ...prev, nodes };
  });
}

// Offline copy for large workspaces: a slim session keeps only opened bodies in
// memory, so notes never opened would be unreadable offline. While online and
// idle, download the missing bodies — most recently updated first — in batches
// into the LOCAL DATABASE only
// (storeDownloadedBodies never replaces newer text or queued notes); opening a
// note offline then reads it there (hydrateNode → getStoredBody). One pass at a
// time; it stops when offline or when nothing is missing, and resumes on the
// next boot/reconnect. A failed batch ends the pass quietly — this is a cache
// fill, not a save, so there is nothing for the user to retry.
const BODY_BATCH = 200;
let bodyDownload: Promise<void> | null = null;
export function downloadBodiesForOffline(): Promise<void> {
  if (bodyDownload) return bodyDownload;
  bodyDownload = (async () => {
    let cursor = "";
    for (;;) {
      if (!getAppState().online) return;
      const page = await missingBodyIds(cursor, BODY_BATCH);
      // The server refuses a batch with a non-UUID id (400): leave such a
      // (legacy, local-only) row out rather than stall the download on it.
      const ids = page.ids.filter((id) => isUuid(id));
      if (page.ids.length === 0) return;
      if (ids.length === 0) { if (page.next === null) return; cursor = page.next; continue; }
      const res = await readWithDeadline((signal) => api<{ bodies: Array<{ id: string; markdown: string }> }>("/api/sync/bodies", {
        method: "POST", body: JSON.stringify({ ids }), signal,
      }));
      await storeDownloadedBodies(res.bodies);
      if (page.next === null) return;
      cursor = page.next;
      await new Promise<void>((resolve) => onIdle(resolve));
    }
  })().catch(() => {}).finally(() => { bodyDownload = null; });
  return bodyDownload;
}

// Offline copy of drawings. A lean bootstrap leaves drawing values out
// (backend services/sync/bootstrap.ts), so the notes never opened here would
// have none offline. When idle, online, visible and not on Save-Data, fetch
// what this device lacks: the index of readable notes holding one, with each
// value's hash (GET /api/sync/drawings), then the values in small batches
// (POST). A missing copy is stored without replacing anything; a copy whose
// hash differs from the server's (a missed delta, a migration with no event)
// is replaced only while it is unchanged and its note has no queued attribute
// write — the person's own strokes always win (localDbPersist
// planDrawingDownload). It stops when offline or hidden and resumes on the
// next boot or reconnect. Not a save: a failure ends the pass quietly.
// `force` (a backup or the folder export) also runs hidden or on Save-Data,
// and reports what it could not fetch so the export can say so.
const DRAWING_BATCH_IDS = 10;
const DRAWING_BATCH_BYTES = 512 * 1024;
type DrawingIndexRow = { node_id: string; key: string; size: number; hash?: string };
/** `missing`: drawings still not on this device (null = unknown: the server's
 *  list was never read). */
export type DrawingDownloadResult = { complete: boolean; missing: number | null };
let drawingDownload: { forced: boolean; done: Promise<DrawingDownloadResult> } | null = null;
let drawingsComplete = false;
let lastDrawingIndex: DrawingIndexRow[] | null = null;
function backgroundFetchAllowed(force: boolean): boolean {
  if (!getAppState().online) return false;
  if (!isBrowserOnline()) return false;
  if (force) return true;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  return !prefersSavedData();
}
type DrawingRow = Parameters<typeof fillAttributeRows>[0][number];
type DrawingReply = Omit<DrawingRow, "value"> & ({ value: string } | { value_patch: TextPatch });

/** The drawings of `ids`, whole. A drawing this device already holds an older
 *  copy of is asked for as a change from that copy (`have`: its hash); the
 *  reply is then a patch, applied here to the copy (the same applyPatch the
 *  server's patch was made for, which checks the copy's hash). A patch that
 *  does not fit the copy as it is now is not used: those ids are asked again
 *  without `have`, and come whole. */
async function fetchDrawings(ids: string[], stale: Array<{ node_id: string; key: string; localHash: string }>): Promise<DrawingRow[]> {
  const asked = new Set(ids);
  const have = Object.fromEntries(stale.filter((s) => asked.has(s.node_id)).map((s) => [`${s.node_id}:${s.key}`, s.localHash]));
  const post = (body: object) => readWithDeadline((signal) => api<{ drawings: DrawingReply[] }>("/api/sync/drawings", { method: "POST", body: JSON.stringify(body), signal }));
  const reply = (await post(Object.keys(have).length ? { ids, have } : { ids })).drawings;
  const rows: DrawingRow[] = [];
  const again = new Set<string>();
  for (const row of reply) {
    if ("value" in row) { rows.push(row); continue; }
    const { value_patch, ...rest } = row;
    try {
      const local = await getNodeAttribute(row.node_id, row.key);
      if (local === null) throw new Error("no local copy");
      rows.push({ ...rest, value: applyPatch(local, value_patch) });
    } catch { again.add(row.node_id); }
  }
  if (again.size) rows.push(...(await post({ ids: [...again] })).drawings.filter((row): row is DrawingRow => "value" in row));
  return rows;
}

async function stillMissing(): Promise<number | null> {
  if (!lastDrawingIndex) return null;
  try { return (await planDrawings(lastDrawingIndex)).missing.length; } catch { return null; }
}
export async function downloadDrawingsForOffline({ force = false }: { force?: boolean } = {}): Promise<DrawingDownloadResult> {
  if (drawingsComplete) return { complete: true, missing: 0 };
  const running = drawingDownload;
  if (running) {
    // A background pass may stop early (hidden, Save-Data): a forced caller
    // waits for it, then makes sure with a pass of its own.
    const result = await running.done;
    if (!force || running.forced || result.complete) return result;
    return downloadDrawingsForOffline({ force });
  }
  if (!backgroundFetchAllowed(force)) return { complete: false, missing: force ? await stillMissing() : null };
  const done = (async (): Promise<DrawingDownloadResult> => {
    const index = await readWithDeadline((signal) => api<{ drawings: DrawingIndexRow[] }>("/api/sync/drawings", { signal }));
    lastDrawingIndex = index.drawings;
    const plan = await planDrawings(index.drawings);
    const expected = new Map(plan.stale.map((s) => [`${s.node_id}\u0000${s.key}`, s.localHash]));
    const size = new Map<string, number>();
    const sizeOf = new Map(index.drawings.map((d) => [`${d.node_id}\u0000${d.key}`, d.size]));
    for (const id of plan.missing) size.set(id, index.drawings.filter((d) => d.node_id === id).reduce((n, d) => n + d.size, 0));
    for (const s of plan.stale) size.set(s.node_id, (size.get(s.node_id) ?? 0) + (sizeOf.get(`${s.node_id}\u0000${s.key}`) ?? 0));
    const batches: string[][] = [];
    let batch: string[] = [], bytes = 0;
    for (const [id, n] of size) {
      if (batch.length && (batch.length >= DRAWING_BATCH_IDS || bytes + n > DRAWING_BATCH_BYTES)) { batches.push(batch); batch = []; bytes = 0; }
      batch.push(id); bytes += n;
    }
    if (batch.length) batches.push(batch);
    for (const ids of batches) {
      if (!force) await new Promise<void>((resolve) => onIdle(resolve));
      if (!backgroundFetchAllowed(force)) return { complete: false, missing: await stillMissing() };
      const res = await fetchDrawings(ids, plan.stale);
      const replace = res.flatMap((row) => {
        const hash = expected.get(`${row.node_id}\u0000${row.key}`);
        return hash ? [{ ...row, expected_hash: hash }] : [];
      });
      await fillAttributeRows(res.filter((row) => !expected.has(`${row.node_id}\u0000${row.key}`)));
      if (replace.length) await replaceStaleAttributeRows(replace);
    }
    drawingsComplete = true;
    return { complete: true, missing: 0 };
  })().catch(async () => ({ complete: false, missing: await stillMissing() }))
    .finally(() => { drawingDownload = null; });
  drawingDownload = { forced: force, done };
  return done;
}

// Init, online transitions and SSE share a sync pass. The write queue owns
// its own submission/replay serialization and optional cross-tab Web Lock.
let syncInFlight: Promise<{ ok: boolean }> | null = null;
// GAP-249: a fresh device takes its event cursor from the boot bootstrap. A
// sync started earlier (the SSE stream connects while that bootstrap is still
// loading) would read cursor 0 and replay the whole history, so on a device
// with no cursor yet, sync waits until boot has persisted its bootstrap or
// finished without one.
let bootCursorReady: Promise<void> = Promise.resolve();
// The latest boot() run (never rejects); only __resetSyncEngineForTests waits on it.
let bootInFlight: Promise<void> = Promise.resolve();
let releaseBootCursor: () => void = () => {};

// Membership dirty-latch (membership-and-permission-epoch.md "blind SSE + dirty-
// latch gate"). sync() is single-flight; a membership-change SSE that fires
// WHILE a sync is in flight would otherwise be coalesced into that in-flight
// pass — which reconciles the OLD epoch it captured and then LOWERS the gate,
// fail-open against the just-changed (possibly revoked) membership. The latch
// records "a fresh membership signal arrived mid-flight" so the finally re-runs
// sync() once more (re-raising the gate) to reconcile the NEW epoch.
let syncDirty = false;
// Cold-start safety net: the FIRST membership reconcile of a session runs
// unconditionally (a FULL diff), even if the epoch matches the persisted cursor.
// A cached mirror can be stale in ways the epoch alone won't flag — a bump missed
// while offline, or a row left by a merge bootstrap — so we re-diff once per
// session to delete anything no longer readable. A preserved replay refusal
// also invalidates the local set: a rejected creation produces no server event
// or epoch change, yet its optimistic node must be checked against the server.
// Capture the revision at check START so a later refusal cannot be acknowledged
// by an already-running check that never included that local node.
let reconciledRejectionRevision: number | null = null;
// This session's mirror was empty and a whole server bootstrap has just filled
// it: nothing it holds can be older than the answer the server gave moments ago
// (the bootstrap is read-policy filtered), so the first check need not hide the
// workspace up front. It still runs and raises the gate itself the moment the
// digest says the sets differ (a revocation in between). Consumed by the first
// check; any retry is fail-closed again.
let mirrorFilledThisSession = false;

function hasUncheckedReplayRefusal(): boolean {
  const revision = getReplayRejectionRevision();
  return revision > 0 && revision !== reconciledRejectionRevision;
}

// A membership-reconciliation delta carries ONLY node rows (revoked deletes or
// newly-readable upserts) and must NOT move the event cursor — so it reuses the
// CURRENT last_event_id. (applySync persists last_event_id; passing the current
// value keeps it unchanged while the node rows are applied to the mirror.)
function membershipDelta(lastEventId: number, nodes: SyncDelta["nodes"]): SyncDelta {
  return {
    last_event_id: lastEventId,
    nodes,
    edges: { upsert: [], delete: [] },
    tasks: { upsert: [], delete: [] },
    attributes: { upsert: [], delete: [] },
    workspace: null,
  };
}

/** Ids per membership page (the server's GET /sync/membership cap). */
const MEMBERSHIP_PAGE_LIMIT = 5000;

// The warm boot's digest request is started before the cached copy is read
// (boot), because it needs nothing from it: it asks for the server's readable
// set, not ours. The first reconcile of the session takes it when it answers
// the epoch sync reports; any other case (no answer, other epoch, too old) asks
// again as before. It only ever lets the reconcile skip pages when the sets are
// equal, so an old snapshot can cost a paged diff but never keeps a stale row.
const DIGEST_PREFETCH_MAX_AGE_MS = 30_000;
let digestPrefetch: { at: number; result: Promise<MembershipDigest | null> } | null = null;

function startDigestPrefetch(): void {
  if (!webCryptoSha256() || !isBrowserOnline()) return;
  const result = readWithDeadline(signal => api<MembershipDigest>("/api/sync/membership/digest", { signal })).catch(() => null);
  digestPrefetch = { at: Date.now(), result };
}

/** The prefetched digest if it is the answer for `expected` (once), else null. */
async function takeDigestPrefetch(expected: number): Promise<MembershipDigest | null> {
  const taken = digestPrefetch;
  digestPrefetch = null;
  if (!taken || Date.now() - taken.at > DIGEST_PREFETCH_MAX_AGE_MS) return null;
  const digest = await taken.result;
  return digest && !digest.retry_required && digest.epoch === expected && typeof digest.digest === "string" ? digest : null;
}

// Reconcile on a changed epoch or the first sync of this session. Return the
// event position sync must still scan; sync owns the final display-gate release.
/** One delta, three places it lands: the local copy (worker), the screen's data, and the paragraph anchors held in
 *  memory (a deleted or revoked note's anchors go with it). */
async function applyAndShow(delta: SyncDelta): Promise<Awaited<ReturnType<typeof applySync>>> {
  const applied = await applySync(delta);
  applyAnchorsOfDelta(delta);
  setData((prev) => applySyncDelta(prev, applied));
  announceDrawingChangesOf(delta);
  return applied;
}

async function maybeReconcileMembership(serverEpoch: number | undefined): Promise<string | undefined> {
  if (serverEpoch === undefined) return;
  // Offline: skip the reconcile entirely. A cold-start reconcile can still be
  // in-flight when the network drops (its /api/sync POST already succeeded);
  // raising the gate here and then failing the membership fetch would strand it
  // up ("Updating permissions…") and block offline capture. There's nothing to
  // reconcile against offline — membership re-checks on reconnect (handleOnline
  // → sync). Pairs with handleOffline lowering any gate already raised. Keyed on
  // navigator.onLine (the real browser network state) so it tracks the actual
  // offline transition, not the app's slower `online` flag.
  if (!isBrowserOnline()) return;
  const localEpoch = await getMembershipEpoch();
  const rejectionRevision = getReplayRejectionRevision();
  // Only an EXACT match is "unchanged". A regression (serverEpoch < localEpoch —
  // e.g. the server restored a backup, rewinding the epoch) must NOT be read as
  // "no change": once known[] is retired, the stale local rows would never be
  // re-checked. Both > (advance) and < (regression) trigger a full reconcile —
  // which DELETES revoked rows (unlike a bootstrap merge, which only adds; see
  // localDbPersist). reconcile saves whatever epoch it converged to, even lower.
  // genuinely unchanged AND this session's cold-start full reconcile already ran
  // → skip the expensive path. The first reconcile of a session ALWAYS runs (the
  // cold-start safety net), even on an exact epoch match, to catch offline drift.
  if (serverEpoch === localEpoch && reconciledRejectionRevision === rejectionRevision) {
    // sync() owns lowering the gate after any required event catch-up.
    return;
  }
  // The first reconcile of a session (cold start, offline drift) and a replay
  // refusal raise the display gate up front (fail-closed): the UI suppresses
  // possibly-restricted content until reconciliation and event catch-up
  // succeed. A plain epoch change raises it only once the digest says our set
  // differs (onSetDiffers) — an equal set needs no lock — and a throw
  // (network / epoch churn) raises it too, so stale content stays hidden.
  const filledThisSession = mirrorFilledThisSession && reconciledRejectionRevision === null && rejectionRevision === 0;
  mirrorFilledThisSession = false;
  const gateFirst = !filledThisSession && (reconciledRejectionRevision === null || reconciledRejectionRevision !== rejectionRevision);
  if (gateFirst) setMembershipGated(true);
  const lastId = await getLastEventId(); // pin the event cursor across the apply
  const applyNodes = async (nodes: SyncDelta["nodes"]) => {
    const d = membershipDelta(lastId, nodes);
    await applyAndShow(d);
  };
  const sha256 = webCryptoSha256();
  let result: Awaited<ReturnType<typeof reconcileMembership>>;
  try {
    result = await reconcileMembership({
    startEpoch: serverEpoch,
    onSetDiffers: () => setMembershipGated(true),
    // Pages of MEMBERSHIP_PAGE_LIMIT ids (an older server caps them lower),
    // only for the digest's unequal buckets when it names them.
    fetchPage: (cursor, expected, prefixes) =>
      readWithDeadline(signal => api<MembershipPage>(`/api/sync/membership?cursor=${encodeURIComponent(cursor)}&expected_epoch=${expected}`
        + `&limit=${MEMBERSHIP_PAGE_LIMIT}`
        + (prefixes?.length ? `&prefixes=${prefixes.join(",")}` : ""), { signal })),
    // The digest first: a set that matches needs no pages (one request instead
    // of 20 at 20k notes). No Web Crypto (plain-HTTP LAN page): pages only.
    ...(sha256 ? {
      sha256,
      // A server that answers but lacks the endpoint (an older one after a
      // rollback, a self-hosted server behind a newer app: 404/405, or any
      // other refusal) means no digest: page everything, as before. Only an
      // unreachable server fails the check.
      fetchDigest: async (expected: number) =>
        (await takeDigestPrefetch(expected)) ?? readWithDeadline(signal => api<MembershipDigest>(`/api/sync/membership/digest?expected_epoch=${expected}`, { signal }))
          .catch((error: unknown): MembershipDigest => {
            if (isServerUnreachable(error)) throw error;
            return { epoch: expected, event_cursor: "0" };
          }),
    } : {}),
    getLocalKnown: () => getAllMembershipIds(), // node ids ∪ task ids — the complete held set
    // Revoke = node deletes; applySync's node-delete cascades the node's edges /
    // attrs / tasks locally (the audit-#4 cascade), so deletes need only the ids.
    // A create still in the queue is unknown to the server, not revoked: keep its local rows until the POST lands.
    isolateRevoked: async (revoked) => {
      const doomed = withoutPendingCreates(revoked, await getPendingWrites());
      if (doomed.length) await applyNodes({ upsert: [], delete: doomed });
    },
    // Grant = the FULL projection (review #3): nodes + attributes + edges + tasks,
    // each in its proper delta channel so applySync persists every one (a node
    // upsert alone wouldn't write node_attributes / edges / task rows).
    fetchProjection: (ids, expectedEpoch) => readWithDeadline(signal => api<MembershipProjection>(`/api/sync/nodes`, {
      method: "POST", body: JSON.stringify({ ids, expected_epoch: expectedEpoch }), signal,
    })),
    applyProjection: async (res) => {
      const d: SyncDelta = {
        last_event_id: lastId, // pin the event cursor — membership rows don't advance it
        nodes: { upsert: res.nodes, delete: [] },
        edges: { upsert: res.edges, delete: [] },
        tasks: { upsert: res.tasks, delete: [] },
        ...(res.pointers ? { pointers: { upsert: res.pointers, delete: [] } } : {}),
        attributes: res.attributes,
        ...(res.note_anchors ? { note_anchors: res.note_anchors } : {}),
        ...(res.note_link_bindings ? { note_link_bindings: res.note_link_bindings } : {}),
        ...(res.tags !== undefined ? { tags: res.tags } : {}),
        workspace: null,
      };
      assertSyncDeltaShape(d);
      await applyAndShow(d);
    },
    saveEpoch: (epoch) => setMembershipEpoch(epoch),
    });
  } catch (error) {
    // The browser went offline mid-check: wentOffline() lowered the gate for offline work and the failure is the
    // network's, not a membership change; raising it again would strand it up (the start-of-check guard above is not enough).
    if (isBrowserOnline()) setMembershipGated(true);
    throw error;
  }
  // FAIL-CLOSED: if the epoch kept moving and reconciliation never converged,
  // THROW — do NOT proceed as if membership were current (a revoked node could
  // still be local). We deliberately do NOT fall back to refresh(): a big-
  // workspace slim bootstrap MERGES (it adds rows, never deletes stale ones — see
  // localDbPersist), so refresh() can't remove a now-unreadable local row and is
  // NOT a complete cleanup. Only the reconcile's explicit revoked-delete is.
  // Throwing → sync() returns ok=false → the reconnect/cold-start gate stays
  // offline and retries; never "stale-but-trusted online".
  if (result.status === "restart-exhausted") {
    setMembershipGated(true);
    throw new Error("membership reconciliation exhausted (snapshot churn) — staying gated");
  }
  reconciledRejectionRevision = rejectionRevision;
  return result.eventCursor; // sync must scan intervening events before lifting the gate
}

// Returns { ok } — ok=true means the pass completed AND any needed membership
// reconcile succeeded. The reconnect path gates setOnline on it (fail-closed):
// the broad catch resolves ok=false on ANY failure (network, or a reconcile that
// threw / exhausted) instead of swallowing it and looking successful.
// Called by the membership pipeline (onMembershipChanged) on an SSE membership
// tick. If a sync is in flight, the tick's fresh epoch would be coalesced into
// that stale pass — so latch it, and sync()'s finally re-runs once to reconcile
// the new epoch. (A no-op when no sync is in flight: the immediately-following
// sync() call then runs fresh with the new epoch, no re-run needed.) Kept
// SEPARATE from sync()'s plain single-flight so incidental concurrent sync()
// calls — a timer + a UI trigger overlapping — don't trigger a redundant pass.
export function markSyncDirty(): void {
  if (syncInFlight) syncDirty = true;
}

// A burst of permission changes (one rejected agent chain is several events)
// arrives as a few membership ticks. Each used to run its own gate → reconcile
// → release cycle, so the workspace locked and unlocked repeatedly and any
// keystroke landing in a locked moment was dropped. The gate still rises the
// instant a tick arrives (fail-closed); the reconcile waits until the ticks
// stop for MEMBERSHIP_SETTLE_MS, so a burst is one lock and one release.
const MEMBERSHIP_SETTLE_MS = 300;
let membershipSettle: ReturnType<typeof setTimeout> | null = null;

/** SSE membership tick: gate now, reconcile once the burst has settled. */
export function membershipChanged(): void {
  setMembershipGated(true);
  if (membershipSettle) clearTimeout(membershipSettle);
  membershipSettle = setTimeout(() => {
    membershipSettle = null;
    markSyncDirty();
    void sync();
  }, MEMBERSHIP_SETTLE_MS);
}

/** The live stream (SSE) reopened. Ticks sent while it was down are lost, so
 *  catch up with a sync: it compares the membership epoch and locks the
 *  workspace only when permissions changed meanwhile (or for the session's
 *  first check). A reconnect alone does not lock. On Linux, Chrome drops every
 *  open connection whenever the computer's network interfaces change (a
 *  container starting or stopping, Tailscale updating its routes), so
 *  reconnects are frequent there — locking on each one flashed the screen and
 *  pulled the cursor out of the editor. Content already on screen stays
 *  visible until the sync's epoch check returns. */
export function liveStreamReconnected(): void {
  markSyncDirty();
  void sync();
}

/** `unreachable`: the pass failed because the server could not be reached
 *  (writeErrors.isServerUnreachable: network error, timeout, 502/503/504),
 *  not because it answered with a refusal or the membership check could not
 *  finish. */
export type SyncResult = { ok: boolean; unreachable?: boolean; /** More events wait than one pass takes; the next pass resumes. Not a failure. */ partial?: boolean };

/** The one rule for "the server did not answer" (owner decision 2026-11-15): a pass that failed because the server could
 *  not be reached is offline, never a lock. Boot and reconnect both ask this; only an answer from the server (a refusal,
 *  a membership change, a check that never converged) is fail-closed. */
const serverNotReached = (result: SyncResult): boolean => !result.ok && result.unreachable === true;

/** Offline mode with the cached copy usable: the indicator off and the membership gate down. Membership is re-checked on
 *  the next reconnect (a person removed meanwhile is told then, the copy wiped). */
function stayOffline(): void {
  setOnline(false);
  setMembershipGated(false);
}

export function sync(): Promise<SyncResult> {
  if (syncInFlight) return syncInFlight;
  const run = (async (): Promise<SyncResult> => {
    const finishWorkspaceCheck = async () => {
      const refusalRevision = getReplayRejectionRevision();
      // Layouts never arrive in /sync. Check after replay/membership, before
      // releasing the view, and do not acknowledge a refusal arriving mid-read.
      await canvasWriter.refreshOpenCanvas();
      if (refusalRevision !== getReplayRejectionRevision()) return false;
      // Another permission change is waiting (a settling burst, or a tick that
      // arrived during this pass): keep the workspace locked for that pass
      // instead of releasing it for a moment and locking it again.
      if (membershipSettle || syncDirty) return true;
      setMembershipGated(false);
      return true;
    };
    try {
      while (bootstrapLanding) await bootstrapLanding;
      syncWaitingForBoot = true;
      try { await bootCursorReady; } finally { syncWaitingForBoot = false; }
      while (bootstrapLanding) await bootstrapLanding;
      await flushPendingWrites();
      await releaseHeldNotes();
      if (hasUncheckedReplayRefusal()) setMembershipGated(true);
      // No local copy: no cursor to move and no mirror to apply a delta to, so
      // the whole bootstrap IS the sync (it is read-policy-filtered, so it
      // settles the membership gate too).
      if (getLocalCopyState() === "none") {
        const ok = await refreshWhole({ insideSync: true });
        if (ok) await finishWorkspaceCheck();
        return { ok };
      }
      // PG bigint ids are decimal strings in the real JSON response. Compare
      // their numeric value: lexical "1000" > "500" is false and used to trap
      // sync on one page until a manual retry advanced the persisted cursor.
      let since: number | string = await getLastEventId();
      // Step C: the routine sync no longer sends `known[]`. Revocation/grant is
      // the membership pipeline's job now — the epoch-gated reconcile
      // (maybeReconcileMembership) + the cold-start full reconcile + the
      // membership_changed SSE tick + the on-reconnect handshake, all fail-closed
      // behind the display gate. So `POST /sync` is a pure event-delta pull; the
      // server's known[] diff is retired from the client path (kept only as a
      // legacy capability for GET callers / tests). This drops the per-sync
      // getAllMembershipIds()+payload cost.
      // The latest membership epoch the server reports this pass; after we're
      // caught up on events, reconcile membership iff it advanced.
      let serverMembershipEpoch: number | undefined;
      let requiredEventCursor = 0n;
      // Audit #3: the backend pages 500 events per delta. A window full of
      // events the frontend doesn't project (governance/audit) used to
      // early-return WITHOUT advancing the cursor — the client refetched the
      // same 500 forever and never saw anything newer. Empty deltas now
      // advance the cursor and fast-forward (bounded) to the next batch
      // that actually carries projections.
      for (let hop = 0; hop < 20; hop++) {
        const delta: SyncDelta = await readWithDeadline(signal => api<SyncDelta>(`/api/sync`, {
          method: "POST",
          body: JSON.stringify({ since }), // Step C: no known[] — membership pipeline owns revocation
          signal,
        }));
        assertSyncDeltaShape(delta); // a bad answer ends the pass here: nothing applied, cursor unmoved
        if (delta.resync_required) {
          // The server couldn't diff our (too-large) held set. Re-bootstrap to a
          // correct, read-policy-filtered baseline instead of trusting a partial
          // delta. refresh() swaps in the authoritative current readable set.
          const rejectionRevision = getReplayRejectionRevision();
          const ok = await refreshWhole({ insideSync: true });
          // The full read-filtered re-bootstrap IS the authoritative converge, so
          // LOWER the gate — otherwise the workspace stayed stuck on "Updating
          // permissions…" forever (the gate is raised on every reconnect/cache
          // paint and this branch returned without ever lowering it). Only stay
          // gated if the re-bootstrap itself failed (still offline).
          if (ok) {
            reconciledRejectionRevision = rejectionRevision;
            // A concurrent drain can reject new input while refresh is loading.
            // Finish another pass before reporting this projection as current.
            if (rejectionRevision !== getReplayRejectionRevision()) continue;
            if (!await finishWorkspaceCheck()) continue;
          }
          return { ok };
        }
        if (delta.head_event_id !== undefined && BigInt(since) > BigInt(delta.head_event_id)) {
          // Our cursor is past where the server's event log ends: the server
          // went back (a restored backup), and this copy may hold what the
          // restore dropped. Start over from the server's position with a whole
          // bootstrap, and re-check membership as on a cold start.
          await setLastEventId(delta.head_event_id);
          since = delta.head_event_id;
          reconciledRejectionRevision = null;
          if (!await refreshWhole({ insideSync: true })) return { ok: false, unreachable: !getAppState().online };
          continue;
        }
        serverMembershipEpoch = delta.membership_epoch ?? serverMembershipEpoch;
        noteMembershipEpoch(serverMembershipEpoch);
        if (isEmptyDelta(delta)) {
          if (BigInt(delta.last_event_id) > BigInt(since)) {
            await setLastEventId(delta.last_event_id);
            since = delta.last_event_id;
            continue; // more batches may follow
          }
          const membershipCursor = await maybeReconcileMembership(serverMembershipEpoch);
          if (membershipCursor !== undefined) requiredEventCursor = BigInt(membershipCursor);
          if (BigInt(since) < requiredEventCursor) continue;
          if (serverMembershipEpoch !== undefined && reconciledRejectionRevision !== getReplayRejectionRevision()) continue;
          if (!await finishWorkspaceCheck()) continue;
          return { ok: true }; // truly caught up (+ membership reconciled if it advanced)
        }
        const applied = await applyAndShow(delta);
        for (const id of applied.heldText ?? []) heldBehindQueue.add(id);
        // HIGH gap: a NON-empty batch used to RETURN here — so a long offline
        // gap or >500 events spanning multiple 500-event batches left the client
        // half-synced until the next sync trigger. Advance the cursor and keep
        // pulling within this pass until caught up (empty delta returns above),
        // bounded by the hop cap (20×500 = 10k events/pass; more continues on
        // the next sync). `known` is fixed for the pass (revocation diffs once).
        if (BigInt(delta.last_event_id) > BigInt(since)) {
          await setLastEventId(delta.last_event_id);
          since = delta.last_event_id;
          continue;
        }
        const membershipCursor = await maybeReconcileMembership(serverMembershipEpoch);
        if (membershipCursor !== undefined) requiredEventCursor = BigInt(membershipCursor);
        if (BigInt(since) < requiredEventCursor) continue;
        if (serverMembershipEpoch !== undefined && reconciledRejectionRevision !== getReplayRejectionRevision()) continue;
        if (!await finishWorkspaceCheck()) continue;
        return { ok: true }; // cursor didn't advance — avoid a tight loop
      }
      // Hop cap hit (>10k events this pass): NOT caught up, so membership was NOT
      // reconciled this pass → report ok=false so the reconnect gate stays offline
      // (fail-closed) until a later pass catches up + reconciles. Event progress
      // was still persisted (cursor advanced each hop), so the next pass resumes.
      return { ok: false, partial: true };
    } catch (error) {
      // A concurrent drain may have refused input while a remote read failed.
      // Keep unverified optimistic rows hidden until a later successful check.
      if (hasUncheckedReplayRefusal()) setMembershipGated(true);
      // Any failure — network, or a reconcile that threw/exhausted. Resolve
      // ok=false (do NOT swallow-and-look-successful): the reconnect path keeps
      // the client offline rather than flipping online on unresolved membership.
      // A fetch failure, a deadline or a gateway 502/503/504 (a deploy) means
      // the server was not reached — boot treats that as offline. Any other
      // answer, or a reconcile that could not finish, was reached.
      return { ok: false, unreachable: isServerUnreachable(error) };
    }
  })().then((result) => {
    // The sync status says when the server's newer content is not arriving (it still reads "connected").
    if (!result.partial) setIncomingProblem(result.ok ? null : result.unreachable ? "unreachable" : "refused");
    return result;
  }).finally(() => {
    syncInFlight = null;
    if (syncDirty) {
      // A membership signal arrived mid-flight. Re-raise the gate (the in-flight
      // pass may have lowered it against the stale epoch) and re-run sync() to
      // reconcile the NEW epoch — self-terminating: the re-run only re-latches if
      // yet another signal arrives during it.
      syncDirty = false;
      setMembershipGated(true);
      void sync();
    }
  });
  syncInFlight = run;
  return run;
}

export async function generatePreview(): Promise<void> {
  if (!getAppState().online) return;
  await sendWrite("POST", "/api/preview");
  await refresh();
}

// ── The mutation layer, bound once against live store getters ───────────────

bindDomainLifecycle({ scheduleUserFolderSync, refresh });


// ── Lifecycle steps connectivity.ts orders ───────────────────────────────────

/** First load of the workspace: the cached copy (gated until membership is
 *  checked), the user folder when this browser has none, then the slim or
 *  full bootstrap and the first sync. `endedOffline`: boot finished without
 *  reaching the server, so the next offline→online flip must refresh. */
export function boot(): Promise<{ endedOffline: boolean }> {
  const run = runBoot();
  bootInFlight = run.then(() => {}, () => {});
  return run;
}

async function runBoot(): Promise<{ endedOffline: boolean }> {
  let endedOffline = false;
  const since = offlineEvents;
  // A second boot (the host was swapped or re-attached) must not strand a
  // sync() still waiting on the first one's promise.
  releaseBootCursor();
  bootCursorReady = new Promise((resolve) => { releaseBootCursor = resolve; });
  bindDeviceStatus();
  // No local copy (IndexedDB blocked, snapshot unreadable): the server's data
  // is still shown and saved to; only the offline copy is missing, and the
  // page says so (useMemoryOnlyLocalCopy).
  await initLocalDb().catch(() => useMemoryOnlyLocalCopy());
  // Only a device without a cursor needs the bootstrap's. One that already
  // synced keeps syncing in parallel with the boot (a warm reload's
  // membership check then overlaps the slim bootstrap, as before).
  const hasCursor = await getLastEventId().catch(() => 0) > 0;
  if (hasCursor) { releaseBootCursor(); startDigestPrefetch(); }
  void refreshPendingCount(); // seed the sync-status chip from the local queue

  // The browser snapshot owns acknowledged local writes. Folder export is
  // delayed and can fail: it must not replace a newer snapshot or undo an
  // explicit backup restore on the next startup. Import a folder only when
  // this browser has no workspace yet. A read that FAILED is not "no
  // workspace": the snapshot and its queue may be intact behind a timeout, and
  // the import replaces both.
  let localUnreadable = false;
  let local = await loadBootstrapList().catch(() => { localUnreadable = true; return null; });

  // Load from user's folder if File System Access API is configured
  if (getStoragePref() === "fs-access") {
    const handle = await getStoredDirHandle().catch(() => null);
    if (handle) {
      const granted = await requestDirPermission(handle).catch(() => false);
      if (granted) {
        let usableFolder = true;
        if (!local && !localUnreadable) {
          const buffer = await readDbFromDir(handle).catch(() => { usableFolder = false; return null; });
          if (buffer) {
            await importDatabase(buffer).catch(() => { usableFolder = false; });
            local = await loadBootstrapList().catch(() => null);
          }
        }
        if (usableFolder) dirHandle = handle;
      }
    }
  }
  // Cold-start GATE-FIRST (fail-closed): if we're painting from a CACHED
  // mirror, raise the gate BEFORE the paint so possibly-stale/revoked content
  // never shows un-reconciled — even for a flash. The forced cold-start
  // reconcile (awaited sync below) lowers it on success; the offline catch
  // lowers it (cached-but-offline is the accepted offline-first limitation).
  // A fresh load (no cache) fetches read-filtered data directly — no gate.
  let startLocalRest = () => {};
  if (local) {
    setMembershipGated(true);
    const { note_anchors: heldAnchors, note_link_bindings: heldBindings, ...held } = local;
    replaceAllAnchors(heldAnchors);
    replaceAllBindings(heldBindings);
    restoreBlockAnchorsEnabled();
    setAppState({ data: held, bootstrapped: true });
    // The list is up; the edges, tasks and attrs follow when the thread is idle.
    // A reopen waits for the check: each merge re-renders the whole store (half
    // a second at 20k notes on a phone) behind a gate nobody can see through,
    // and ran in the middle of the check's own steps.
    const generation = wholeBootstrapGeneration;
    let started = false;
    startLocalRest = () => { if (!started) { started = true; onIdle(() => { void loadLocalRest(generation); }); } };
    if (!hasCursor) startLocalRest();
  }
  let slimLanded = false;
  let bootServerTime: string | undefined;
  // ⑤ scale: at/above SLIM_MODE_NODE_THRESHOLD nodes the session STAYS slim
  // — pulling every body into the heap (the full bootstrap) plus the LRU
  // self-disabling once bodies!=='none' meant 10k bodies resident forever.
  // Staying slim keeps the LRU evicting; bodies hydrate on open.
  let stayslim = false;
  const mark = await canvasListMark();
  try {
    // Cold start (no local cache): paint from the slim bootstrap first —
    // payload is a fraction of the full one, so the shell is interactive
    // while bodies stream in behind. Selected-node bodies hydrate on
    // demand via hydrateNode (the editor guards on nodeNeedsBody).
    // A cached payload of N≥threshold nodes tells us this is a big
    // workspace even before any network call — refresh it slim, not full,
    // so the reload of a large workspace never re-pulls every body either.
    const localBig = !!local && local.nodes.length >= SLIM_MODE_NODE_THRESHOLD;
    // Reopen: a mirror with an event cursor (refreshOnReopen above).
    const reopen = !!local && hasCursor;
    if (!reopen && (!local || localBig)) {
      try {
        const slim = await fetchBootstrap("/api/bootstrap?bodies=none");
        await paintThenPersist(slim, () => { answeredOnline(since); setBootstrapped(true); });
        slimLanded = true;
        mirrorFilledThisSession = !local;
        bootServerTime = slim.server_time;
        // Decide from the slim payload's own node count — no extra roundtrip.
        stayslim = slim.nodes.length >= SLIM_MODE_NODE_THRESHOLD;
      } catch (error) {
        // A cached big workspace that cannot reach the server is an offline
        // cold start: the outer catch keeps the cache painted, stays
        // offline and lowers the gate. Treating it as a live slim session
        // flipped online and left "Checking your workspace…" up (GAP-20).
        if (localBig) throw error;
        // No cache: fall through to the full fetch below.
      }
    }
    if (reopen) {
      // Warm reload of a workspace this device already holds: the cached copy
      // is painted and sync's event deltas bring it current, so the gate needs
      // only sync's membership check — not the full bootstrap, which carries
      // every body and drawing (9.9 MB on the production workspace, about 7 s
      // of 「正在確認工作區資料…」 on every reload, 2026-10-18). Nor, for a
      // large workspace, the slim one (10 MB at 20k notes). The mirror's
      // background refresh runs on idle after the gate is down, the whole
      // bootstrap at most daily (refreshOnReopen).
      answeredOnline(since);
      const checked = await sync();
      startLocalRest();
      // Could not reach the server: the same offline cold start as a failed
      // bootstrap (catch below — cached copy usable, gate lowered). Reached
      // but not confirmed (a refusal, membership churn): stay online behind
      // the gate, which MembershipGate keeps retrying (fail-closed).
      if (serverNotReached(checked)) throw new Error("server unreachable during the boot sync");
      // A large workspace stays slim (its painted copy is): the offline body
      // download starts once the check is through. Started before it, its
      // requests to the mirror worker (one at a time) queued ahead of the
      // check's own and held the gate up for seconds at 20k notes.
      // A small workspace too: a first load that was left before its full download landed stored titles only, and the
      // daily gate (refreshOnReopen) would not fetch the bodies for a day. With nothing missing this is one query.
      void downloadBodiesForOffline();
      onIdle(() => { void refreshOnReopen(localBig).catch(() => null).then(() => downloadDrawingsForOffline()); });
    } else if (stayslim) {
      // ⑤ scale: big workspace — SKIP the full-body fetch entirely. Pulling
      // every body into the heap (and the LRU self-disabling once
      // bodies!=='none') meant 10k bodies stayed resident forever; staying
      // slim keeps the LRU evicting and bodies hydrate on open. Persist the
      // slim payload so a reload re-paints from cache, then sync + canvases.
      answeredOnline(since);
      pruneCanvasMirror(mark, bootServerTime);
      // AWAIT (not fire-and-forget): the first sync runs the cold-start FULL
      // reconcile (first check / replay-refusal revision) which DELETES anything no longer
      // readable from the cached mirror — so the boot doesn't leave revoked
      // rows live. (The pre-reconcile render-suppression display gate is Step D.)
      releaseBootCursor();
      // The offline download follows the boot sync, not runs beside it: its
      // requests to the mirror worker (one at a time) queued ahead of the
      // sync's own and held the first check up. Bodies come from the server's
      // current read set, and one for a row the reconcile removed matches
      // nothing locally.
      await sync();
      void downloadBodiesForOffline();
      onIdle(() => { void downloadDrawingsForOffline(); });
    } else {
      // The full hydration replaces the slim rows (all bodies in memory) and
      // persists the offline cache. When the slim paint landed it must NOT
      // run inline — doing so within the same tick clobbers the slim payload
      // and throws away the latency win the slim mode exists for. Defer it
      // to idle: the shell stays slim and interactive, on-open hydrateNode
      // covers body availability in the meantime, and the heavy payload only
      // lands once the main thread is quiet. When nothing painted (no local
      // cache AND slim failed) we still hydrate inline — there's no usable
      // shell to keep slim, so fetch the bodies now.
      // The offline drawing download follows, in the same idle slot.
      if (slimLanded) onIdle(() => { void hydrateFullBootstrap().catch(() => null).then(() => downloadDrawingsForOffline()); });
      else { bootServerTime = await hydrateFullBootstrap(); mirrorFilledThisSession = !local; }
      pruneCanvasMirror(mark, bootServerTime);
      // AWAIT: complete the cold-start full reconcile during boot (see above).
      releaseBootCursor();
      await sync();
      if (!slimLanded) onIdle(() => { void downloadDrawingsForOffline(); });
    }
  } catch {
    if (getAppState().accessRevoked) return { endedOffline }; // removed, not offline (lib/accessRevoked.ts)
    // Offline cold start: we couldn't reconcile, so lower the gate-first GATE
    // and show the cached mirror. This is the accepted offline-first limit —
    // membership is re-checked (and revoked rows deleted) on reconnect.
    stayOffline();
    // LRU test caught this: the slim paint must survive a full-fetch
    // failure (connection dropping mid-boot) — only fall back to the
    // empty shell when NOTHING painted at all.
    // Nothing was ever loaded and the server cannot be reached: no workspace,
    // at the least privilege (noWorkspaceData), not an owner's empty one.
    if (!local && !slimLanded) setData(noWorkspaceData);
    // The canvas list survives an offline cold start with the cached nodes:
    // a canvas is one of them (lib/canvasList).
    // Boot finished WITHOUT going online (offline cold start): init never
    // hydrated, so release ownership of the first online flip — the next
    // offline→online transition must do the full refresh to pull the data
    // we couldn't fetch now.
    if (!getAppState().online) endedOffline = true;
  } finally {
    startLocalRest(); // a boot that ended before its check still shows the cached relations
    releaseBootCursor();
    setBootstrapped(true);
  }
  return { endedOffline };
}

/** Tests: resolves once the boot and the sync pass running now have ended
 *  (a pass re-runs itself at most once per latched signal, so it follows
 *  those too). Requests the caller's mocks hold open are not settled here. */
export async function __idleSyncEngineForTests(): Promise<void> {
  await bootInFlight;
  while (syncInFlight) await syncInFlight.catch(() => null);
}

/** Tests: end what a finished test left running, then forget every timer,
 *  latch and memo this module keeps between calls — a boot started by one
 *  test would otherwise reach the next test's mocks. */
export async function __resetSyncEngineForTests(): Promise<void> {
  await __idleSyncEngineForTests();
  if (membershipSettle) clearTimeout(membershipSettle);
  membershipSettle = null;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  dirHandle = null;
  syncDirty = false;
  reconciledRejectionRevision = null;
  mirrorFilledThisSession = false;
  digestPrefetch = null;
  bodyDownload = null;
  drawingDownload = null;
  drawingsComplete = false;
  lastDrawingIndex = null;
  hydratedLru.clear();
  hydrateSeq = 0;
  releaseBootCursor();
  bootCursorReady = Promise.resolve();
  heldBehindQueue.clear();
}

/** The browser is back online. Drain the queue while still marked offline,
 *  then go online and sync. Resolves false when the server could not be
 *  reached or membership not confirmed: the workspace is back offline — gated
 *  while the browser is online (only the server is down), not gated when the
 *  browser itself went offline meanwhile — and the caller schedules the next
 *  attempt (the browser will not fire 'online' again when only the server
 *  was down). */
export async function reconnect(): Promise<boolean> {
  // We just left offline mode, where the gate is deliberately lowered so
  // cached work remains usable. Until reconnect sync proves membership is
  // current, that cache may contain rows revoked while we were away.
  setMembershipGated(true);
  // Drain the offline queue BEFORE flipping `online` true. While it drains,
  // online stays false so (audit #1) a fresh ink/edit still QUEUES — appended
  // after the draining writes (pending_writes is ORDER BY id ASC), never
  // direct-sent to race-then-be-overwritten by an older queued write; and
  // (audit #2) component GETs fail → they read the local mirror (which holds
  // the offline strokes) instead of loading stale server state that's about
  // to be overwritten by the drain. flushPendingWrites uses api() directly,
  // not the online flag, so it works here. Only once the server is caught up
  // do we go online and pull deltas.
  await flushPendingWrites();
  // With the fail-closed display gate already raised, setOnline(true) FIRST:
  // the online-flip rule in connectivity.ts keys off the false→true flip
  // to run a full read-policy-filtered refresh(), and sync() (next) runs the
  // membership reconcile that DELETES anything revoked while we were offline.
  // Flipping online does NOT itself reveal restricted content because Step D
  // suppresses the workspace until sync/reconcile lowers the gate. Gating the
  // flip on sync() is the WRONG lever (it'd also suppress the transition
  // refresh and gives false fail-closed).
  setOnline(true);
  const res = await sync();
  if (res.ok) {
    // Back online: check the drawing copies again (one may have missed a change).
    drawingsComplete = false;
    onIdle(() => { void downloadBodiesForOffline().then(() => downloadDrawingsForOffline()); });
    return true;
  }
  // sync() did NOT confirm. Revert the online flip so writes QUEUE rather than direct-send into a dead server.
  // Removed from the workspace while this ran (lib/accessRevoked.ts): the server answered and refused on purpose, which is
  // not "offline"; forgetWorkspace already lowered the gate and the notice replaces the app. connectivity.ts asks no more.
  if (getAppState().accessRevoked) return false;
  // The server could not be reached (boot's rule, serverNotReached): offline, the cached copy readable and writable (writes
  // queue), the gate down; connectivity.ts asks again after its back-off. Only with a copy on this device: without one there is
  // nothing to show, and a device that never verified this account stays behind the gate.
  // The server DID answer but the check did not confirm (a refusal, a membership that kept changing): fail-closed, the gate
  // stays up while the browser is online. When the browser itself went offline during this sync, wentOffline() already lowered
  // it (cached work stays usable; membership re-checks on the next reconnect).
  if (serverNotReached(res) && getLocalCopyState() !== "none") stayOffline();
  else { setMembershipGated(isBrowserOnline()); setOnline(false); }
  return false;
}

/** The browser went offline: flip the indicator at once (P0-4) and LOWER the
 *  membership gate. If we drop network mid-cold-start-reconcile, the reconcile
 *  throws, sync() resolves ok=false, and the gate raised by
 *  maybeReconcileMembership would otherwise stick up ("Updating
 *  permissions…") forever — blocking offline capture. Same accepted
 *  offline-first tradeoff as boot's offline path: membership is re-checked on
 *  reconnect. */
export function wentOffline(): void {
  offlineEvents += 1;
  setOnline(false);
  setMembershipGated(false);
}

/** Removed from the workspace (401 membership_removed): not offline. Drop the
 *  in-memory and on-device copy so the shell can show the notice instead. */
export function forgetWorkspace(): void {
  setAccessRevoked(true);
  setMembershipGated(false);
  setData(noWorkspaceData);
  forgetVerifiedAccount();
  void wipeWorkspaceMirror().catch(() => null);
}
