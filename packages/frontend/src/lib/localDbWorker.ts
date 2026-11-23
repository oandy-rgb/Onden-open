import { applyTagCatalog, restoreTagCatalog } from "./tagProjection";
import { prepareLocalDatabase } from "./localDbSchema";
import { createInitializationGate } from "./initializationGate";
import { upsertWorkspaceInto, updateWorkspaceSettingsInto, readWorkspaceSettings, readWorkspaceModules, writeWorkspaceModules, readLineWords, writeLineWords, type WorkspaceSettings } from "./workspaceMirror";
/// <reference lib="webworker" />
import { decodeTaskRow, upsertTaskInto } from "./taskMirror";
// ───────────────────────────────────────────────────────────────────────────
// localDb worker — owns the entire sql.js instance off the main thread.
//
// Previously sql.js initialised AND ran every query inline on the main thread
// (only db.export() was idle-deferred), so opening or searching a large local
// vault (10k+ nodes) janked the UI. This worker hosts init, all queries, and
// the periodic export/IndexedDB save behind a thin postMessage RPC, so the
// bootstrap hydration and search never block rendering. The main-thread shim
// (localDb.ts) keeps the same async public API and just forwards calls here.
// ───────────────────────────────────────────────────────────────────────────
import initSqlJs from "sql.js";
import type { BindParams, Database, SqlJsStatic } from "sql.js";
import type { Bootstrap, ContentNode, NodeEdge, NodeTask, NodeAttribute, NotePointer, AiSuggestion, Workspace, Canvas, CanvasMeta, CanvasData, Tag } from "./api";
import type { CanvasMembershipChange } from "./canvasMemberships";
import type { LinkBinding, NoteAnchor } from "./blockAnchorStore";
import { idbAdoptLegacy, idbIsStale, idbLoad as idbLoadStored, idbSave as idbSaveStored } from "./indexedDbStorage";
import { createPersistScheduler } from "./persistScheduler";
import {
  journalAppend, journalAvailable, journalClear, journalDrop, journalRead, journalScopeKey, lastSeq, latestBySession, mergeApplied,
  replayJournalInto, unappliedEntries, type JournalApplied, type JournalOp, type JournalRow,
} from "./localDbJournal";
import { SLIM_MODE_NODE_THRESHOLD } from "./slimMode";
import { persistBootstrapInto, persistBootstrapMetaInto, fillAttributesInto, planDrawingDownload, replaceStaleCopiesInto, drawingCopyKey, type DrawingIndexEntry, type LocalDrawingCopy, persistTagCatalogInto, slimBootstrapNodeDrops, dropNodeFromMirror, applyCanvasMembershipChangeInto, putGraphPositionInto, applyNoteAnchorDeltaInto, NOTE_ANCHORS_SELECT, applyLinkBindingDeltaInto, NOTE_LINK_BINDINGS_SELECT } from "./localDbPersist";
import { installUuidPolyfill, randomUUID } from "./uuid";
import { webCryptoSha256 } from "./hex";
import { projectPendingNoteText, missingPendingNoteCreations } from "./pendingNoteProjection";
import { writeTargets, targetIds, parseStoredTargets, type WriteTarget } from "./pendingWriteTargets";
import type { AppliedSyncDelta, LocalDbEvent, SyncDelta } from "./localDb";
import { upsertNodeInto, upsertEdgeInto, upsertPointerInto, upsertAttributeInto, reindexNodeText } from "./localMirror";
import { higherPosition, isCurrentAnswer } from "./answerPositions";
import { LocalDbError, type LocalDbErrorCode } from "./localDbErrors";
// The subpath, not the package root: the root pulls in the markdown pipeline,
// which needs a DOM a worker lacks (test/workerImports.test.ts).
import { snippetAround, queryTerms, type Snippet } from "@onden/markdown/snippet";
import { pageTextPlain } from "@onden/markdown/page-text";
import { INK_PAGE_ATTRS } from "@onden/markdown/ink";
import type { CanvasMembership } from "@onden/contract";
import { isTag, PDF_TEXT_ATTR } from "@onden/markdown/contract";

// Drawings stay out of the in-memory attribute map (their readers load them on open); the keys of bootstrap.ts's lean bootstrap.
// `pdf_text` (the text of a PDF's pages, up to ~60,000 characters a note) stays out for the same reason; the server's search reads it, this device's does not.
const DRAWING_KEYS_SQL = [...INK_PAGE_ATTRS, "pdf_annotations", PDF_TEXT_ATTR].map((k) => `'${k}'`).join(", ");

// A Worker has its own `crypto` realm separate from the main thread, so the
// secure-context randomUUID fallback (insecure LAN-IP HTTP self-host) must be
// installed here too — otherwise queued writes lose their idempotency key.
installUuidPolyfill();

// Per-attribute / sync delta shapes (mirrored in localDb.ts for the client).


type PendingWrite = { id: number; method: string; path: string; body: string | null; idem_key: string | null; attempts: number; targets?: WriteTarget[] };
type RejectedWrite = PendingWrite & { rejection: string };

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
// Pinned by the first RPC, before initialization. null is the unscoped legacy
// store (no current page opens it; fixtures do).
let storageScope: string | null | undefined;
// Pinned with it: this account owns the old unscoped native store and moves it
// onto its own key when it has none yet (lib/accountStorage).
let adoptLegacy = false;

// Imports replace the database. RPCs and background snapshots share this queue
// so an older snapshot cannot land after a replacement, and no caller can
// observe a candidate before its durable commit. A rejected operation does not
// prevent the next operation from running.
let databaseWork: Promise<unknown> = Promise.resolve();
function enqueueDatabaseWork<T>(work: () => Promise<T>): Promise<T> {
  const result = databaseWork.then(work);
  databaseWork = result.catch(() => {});
  return result;
}

async function getSql(): Promise<SqlJsStatic> {
  if (!SQL) {
    // The browser app is served from any path (a preview address per pull request), so its files are found next to the
    // page's assets; the web build and the dev server keep them at the site's root.
    // (Plain string work on the worker's own address: Vite rewrites `new URL(template, import.meta.url)` into an asset lookup.)
    const nextToAssets = import.meta.env.VITE_BROWSER_APP === "true";
    const pageRoot = import.meta.url.slice(0, import.meta.url.lastIndexOf("/assets/") + 1);
    SQL = await initSqlJs({ locateFile: (file) => (nextToAssets ? `${pageRoot}sql.js/${file}` : `/sql.js/${file}`) });
  }
  return SQL;
}

function getDb(): Database {
  if (!db) throw new Error("SQLite not available");
  return db;
}

// Saving. sql.js can only persist the WHOLE database (`db.export()`, 35–100 MB
// at 20k notes), so the snapshot is saved coalesced and off the hot path:
//
// - A durable change (a queued write, its rejection or removal, a note or
//   canvas delete) is appended to the journal (lib/localDbJournal): one small
//   IndexedDB record, committed before the RPC resolves. The snapshot then
//   follows lazily as compaction (`compact`, 15 s, or after 200 records).
// - A mirror change (sync, bootstrap, bodies) can be fetched again, so it only
//   marks the snapshot dirty (`persist`, 2 s debounce + idle).
// - Without a journal (no IndexedDB, or its write failed) a durable change
//   awaits one whole snapshot save, as before.
//
// The scheduler's own pagehide/beforeunload barrier is a no-op here (no
// `window`); the owner relays the main thread's pagehide and
// visibilitychange→hidden as a `flushLocalDbSync` RPC (see localDb.ts).
const journalSession = randomUUID();
let journalSeq = 0;
// Per session, the journal records the in-memory database contains (written
// into each snapshot as sync_state 'journal_applied').
let journalApplied: JournalApplied = {};
let journalOn = journalAvailable();

// A temporary session (lib/temporarySession.ts) keeps nothing in the browser: the copy lives in this worker's memory only
// and is never read from or written to IndexedDB, and there is no journal (it is IndexedDB too). The page says so with
// every request (`temporary`); everything else about the copy works as it always does.
let memoryOnly = false;
const idbLoad = (scope: string | null): Promise<ArrayBuffer | null> => (memoryOnly ? Promise.resolve(null) : idbLoadStored(scope));
const idbSave = (buffer: ArrayBuffer, scope: string | null, options: { replace?: boolean }): Promise<void> => (memoryOnly ? Promise.resolve() : idbSaveStored(buffer, scope, options));
const idbStaleCheck = (scope: string | null): Promise<boolean> => (memoryOnly ? Promise.resolve(false) : idbIsStale(scope));
let journalRecordsSinceSnapshot = 0;
const COMPACT_AFTER_RECORDS = 200;

function journalKey(): string {
  return journalScopeKey(storageScope!);
}

function readJournalApplied(d: Database): JournalApplied {
  try {
    const raw = d.exec("SELECT value FROM sync_state WHERE key='journal_applied'")[0]?.values[0]?.[0];
    const parsed = typeof raw === "string" ? JSON.parse(raw) as unknown : null;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "number")) as JournalApplied;
  } catch { return {}; }
}

function stampJournalApplied(d: Database, applied: JournalApplied): void {
  d.run("INSERT INTO sync_state(key,value) VALUES('journal_applied',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(applied)]);
}

// This session's entry counts only once it wrote a record.
let journalWrote = false;
function appliedNow(): JournalApplied {
  return journalWrote ? { ...journalApplied, [journalSession]: journalSeq } : { ...journalApplied };
}

// Records the snapshot now contains are deleted; sessions other than this one
// are then forgotten (their remaining records, if any, are newer).
async function dropJournalUpTo(applied: JournalApplied): Promise<void> {
  if (!journalOn || Object.keys(applied).length === 0) return;
  try {
    await journalDrop(journalKey(), applied);
    journalApplied = applied[journalSession] ? { [journalSession]: applied[journalSession] } : {};
  } catch (error) {
    // Harmless: the snapshot lists them as applied, so loading skips them.
    console.warn("[onden] local journal cleanup failed", error);
  }
}

// Snapshot writes go one at a time, but outside the RPC queue: the export is
// taken inside it (a consistent copy), the IndexedDB write is not, so a slow or
// stalled write no longer holds up addPendingWrite and every other RPC. An
// import or wipe, which replace the database, wait for it first.
let writeTail: Promise<unknown> = Promise.resolve();
let saveFailures = 0;
let backoffTimer: ReturnType<typeof setTimeout> | undefined;

function startSnapshotWrite(replace: boolean): Promise<void> | null {
  if (!db || memoryOnly || newerCopySeen) return null; // memoryOnly: nothing is kept, so no export of the whole database
  persist.cancel();
  compact.cancel();
  const applied = appliedNow();
  stampJournalApplied(db, applied);
  const buf = db.export().buffer as ArrayBuffer;
  const write = writeTail.then(async () => {
    await idbSave(buf, storageScope!, { replace });
    journalApplied = applied;
    journalRecordsSinceSnapshot = 0;
    if (saveFailures) {
      saveFailures = 0;
      clearTimeout(backoffTimer);
      backoffTimer = undefined;
      self.postMessage({ event: "snapshot-save", ok: true } satisfies LocalDbEvent);
    }
    await dropJournalUpTo(applied);
  });
  writeTail = write.catch(() => {});
  return write;
}

const isStale = (error: unknown) => (error as { name?: string } | null)?.name === "SnapshotStaleError";

/** Not saved: retry with a growing wait (a full export of 35–100 MB must not
 *  repeat every two seconds on a full disk) and tell the page once. */
function noteSaveFailed(): void {
  if (saveFailures++ === 0) self.postMessage({ event: "snapshot-save", ok: false } satisfies LocalDbEvent);
  // Saves requested meanwhile wait for this one retry, which saves everything.
  clearTimeout(backoffTimer);
  backoffTimer = setTimeout(() => { backoffTimer = undefined; queueSnapshot(); }, Math.min(2000 * 2 ** saveFailures, 300_000));
}

/** The person asked to try again (the notice's button): save now, without
 *  waiting out the backoff. A failed manual try says so to the caller only; it
 *  does not count as another automatic failure (the wait would double each
 *  time they press the button). */
async function retrySnapshotSave(): Promise<void> {
  if (saveFailures === 0) return;
  await writeSnapshotAdoptingStale(false, false);
}

/** Another tab stored a newer snapshot: ours would erase its compacted queue
 *  writes. Continue from the stored one plus the journal (this tab's own
 *  records are in it). Without a journal, this tab's queue is carried over. */
async function adoptStoredSnapshot(): Promise<void> {
  // A save of the database being replaced may still be on its way (queueSnapshot does not wait for it). Landing
  // between the reads below it would pass the generation check this very read just moved, and trim journal
  // records that the copy built here has not seen.
  await writeTail;
  const S = await getSql();
  const saved = await idbLoad(storageScope!);
  const fresh = saved ? new S.Database(new Uint8Array(saved)) : new S.Database();
  try {
    if (saved) verifySnapshotOwner(fresh);
    prepareLocalDatabase(fresh);
    if (!journalOn && db) {
      const rows = db.exec(PENDING_ROW)[0];
      const mine = (rows?.values ?? []).map((v) => ({ t: "pw.put" as const, row: Object.fromEntries(rows!.columns.map((c, i) => [c, v[i]])) as JournalRow }));
      replayJournalInto(fresh, mine.map((op, i) => ({ session: journalSession, seq: i, op })));
    }
    await replayJournal(fresh);
    // The page shows what this database held (the deltas it applied), not what the stored one holds: continue
    // the sync from the earlier of the two cursors, so the next sync hands the page the changes between.
    const shown = db ? eventCursorIn(db) : null;
    if (shown === null) {
      // This page loaded nothing from its own copy: the stored one is news to it, whatever it says about its last
      // whole download. Without that stamp the next reconnect downloads the whole workspace.
      fresh.run("DELETE FROM sync_state WHERE key='full_refresh_at'");
    } else if (shown < (eventCursorIn(fresh) ?? shown)) {
      fresh.run("UPDATE sync_state SET value=? WHERE key='last_event_id'", [String(shown)]);
    } else if (shown > (eventCursorIn(fresh) ?? shown)) {
      // The other way round: the stored copy is older than what this page applied, and the page may already be
      // waiting for an answer asked from its own, later cursor. Applied here, that answer would move the cursor past
      // the changes in between, and no later sync would bring them. So the next request starts from the stored
      // copy's cursor (getLastEventId), whatever lands before it: replaying a change twice is harmless.
      adoptedCursor = eventCursorIn(fresh);
    }
  } catch (error) {
    fresh.close();
    // Another tab, on a newer build, stored a copy this build cannot read. Reading it moved this tab's idea of the
    // stored generation to that copy, so its next save would pass the stale check and overwrite it with this tab's
    // older one (and the changes queued in it). From here on this worker saves nothing and answers nothing.
    if (error instanceof LocalDbError && error.code === "local_copy_too_new") newerCopySeen = true;
    throw error;
  }
  db?.close();
  db = fresh;
}

/** A stored copy from a newer build was met after this worker had its own open (adoptStoredSnapshot). */
let newerCopySeen = false;

/** Before the queue is judged empty: take in what other tabs and the installed
 *  app queued. Their records are still in the journal until one of them stores
 *  a snapshot, which changes the stored generation (then continue from it). */
async function catchUpWithOtherTabs(): Promise<void> {
  if (!db) return;
  if (await idbStaleCheck(storageScope!)) return adoptStoredSnapshot();
  if (!journalOn) return;
  const todo = unappliedEntries(await journalRead(journalKey()), journalApplied).filter((e) => e.session !== journalSession);
  if (todo.length === 0) return;
  replayJournalInto(db, todo);
  journalApplied = mergeApplied(journalApplied, latestBySession(todo));
  // What this tab records next (it may be sending one of these writes) must replay after them: sessions
  // number from their own start, and equal numbers sort by session id.
  journalSeq = Math.max(journalSeq, lastSeq(todo, {}));
  scheduleSave();
}

/** Write the whole database; if another tab stored a newer snapshot, adopt it
 *  first and write again. Failure is thrown, not counted (see saveSnapshot). */
async function writeSnapshotAdoptingStale(replace: boolean, stale: boolean): Promise<void> {
  for (;;) {
    if (stale) await adoptStoredSnapshot();
    try { await startSnapshotWrite(replace); return; }
    catch (error) {
      if (isStale(error) && !stale) { stale = true; continue; }
      throw error;
    }
  }
}

/** Save the whole database once. Every pending save is covered by it.
 *  `replace`: the caller replaced the database on purpose (wipe). */
async function saveSnapshot(replace = false, stale = false): Promise<void> {
  try { await writeSnapshotAdoptingStale(replace, stale); }
  catch (error) { noteSaveFailed(); throw error; }
}

function queueSnapshot(): void {
  if (backoffTimer !== undefined) return;
  void enqueueDatabaseWork(async () => {
    try {
      startSnapshotWrite(false)?.catch((error) => {
        if (isStale(error)) void enqueueDatabaseWork(() => saveSnapshot(false, true)).catch(() => {});
        else noteSaveFailed();
      });
    } catch { noteSaveFailed(); }
  }).catch(() => {});
}

const persist = createPersistScheduler({ doExport: queueSnapshot });
const compact = createPersistScheduler({ doExport: queueSnapshot, debounceMs: 15_000, idleTimeoutMs: 5_000 });

function scheduleSave(): void {
  persist.schedule();
}

/** Make a change durable before its RPC resolves: one journal record, or (no
 *  journal) one whole snapshot. `critical: false` is for a change whose loss
 *  only replays work the server deduplicates; it never waits for a snapshot.
 *  `refuseWhileBackingOff`: for a record whose caller keeps the write itself when it is refused (a queue row). While a
 *  whole-database save waits out its backoff, such a record is refused at once instead of trying the whole export
 *  again: online the save is then sent without a row; offline it goes to recovery, even if space was freed meanwhile,
 *  until the backoff's retry (at most 300 s) saves again. */
async function makeDurable(op: JournalOp, { critical = true, refuseWhileBackingOff = false } = {}): Promise<void> {
  if (journalOn) {
    const seq = ++journalSeq;
    journalWrote = true;
    try {
      // A critical record can be the only copy of what a person typed (a save on its way, a queued edit): on the disk.
      await journalAppend(journalKey(), { session: journalSession, seq, op }, critical ? "strict" : undefined);
      if (++journalRecordsSinceSnapshot >= COMPACT_AFTER_RECORDS) scheduleSave();
      else compact.schedule();
      return;
    } catch (error) {
      console.warn("[onden] local journal write failed; saving the whole local database instead", error);
    }
  }
  if (critical) {
    // A whole-database save already failed and waits out its backoff (noteSaveFailed: a full disk). Another export
    // now would copy 35–100 MB on every save, to fail again. This record is not kept; the caller keeps the write
    // itself (online: sends it without a row; offline: recovery), as for any record storage refused. A record with no
    // such fallback (a refusal kept for the person) still tries.
    if (refuseWhileBackingOff && backoffTimer !== undefined) throw new Error("The local copy is waiting to retry its save");
    await saveSnapshot();
  } else scheduleSave();
}

const PENDING_ROW = "SELECT id, method, path, body, idem_key, attempts, rejection, created_at, targets, made_at FROM pending_writes";
function pendingRow(id: number): JournalRow | undefined {
  return qry<JournalRow>(`${PENDING_ROW} WHERE id = ?`, [id])[0];
}

/** Run mirror statements and keep them, to journal as one record. */
function recordingRun(d: Database): { run(sql: string, params?: BindParams): void; stmts: Array<[string, unknown[]]> } {
  const stmts: Array<[string, unknown[]]> = [];
  return {
    stmts,
    run(sql, params = []) {
      d.run(sql, params);
      stmts.push([sql, params as unknown[]]);
    },
  };
}

// Durability barrier relayed from the main thread's unload path. Journaled
// changes are already on disk, so only pending mirror changes need the whole
// save; the RPC resolves once it is written. Nothing pending: nothing written.
async function flushLocalDbSync(): Promise<void> {
  if (!db) return;
  if (persist.isDirty() || (!journalOn && compact.isDirty())) await saveSnapshot();
}

function qry<T extends object>(sql: string, params: unknown[] = []): T[] {
  const stmt = getDb().prepare(sql);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stmt.bind(params as any);
  const rows: T[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T);
  stmt.free();
  return rows;
}

function run(sql: string, params: unknown[] = []): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getDb().run(sql, params as any);
}

async function initLocalDb(): Promise<void> {
  const S = await getSql();
  const saved = await idbLoad(storageScope!);
  const adopted = !saved && adoptLegacy && storageScope !== null ? await adoptLegacyStore(S) : null;
  const database = adopted ?? (saved ? new S.Database(new Uint8Array(saved)) : new S.Database());

  try {
    if (!adopted) {
      if (saved) verifySnapshotOwner(database);
      else if (storageScope !== null) {
        database.run("CREATE TABLE local_account (scope TEXT NOT NULL)");
        database.run("INSERT INTO local_account VALUES (?)", [storageScope!]);
      }
      prepareLocalDatabase(database);
    }
    await replayJournal(database);
  } catch (error) { database.close(); throw error; }

  db = database;
}

/** Apply the journal records the snapshot lacks: changes acknowledged after
 *  its last save, by this device's earlier sessions or by another tab. Their
 *  next snapshot save drops them from the journal. A read failure fails
 *  initialization, like the snapshot read: the queue must not look empty. */
async function replayJournal(database: Database): Promise<void> {
  journalApplied = readJournalApplied(database);
  if (!journalOn) return;
  const entries = await journalRead(journalKey());
  // This session's records sort after everything an earlier one left.
  journalSeq = lastSeq(entries, journalApplied);
  if (entries.length === 0) return;
  const todo = unappliedEntries(entries, journalApplied);
  if (todo.length > 0) {
    replayJournalInto(database, todo);
    journalApplied = mergeApplied(journalApplied, latestBySession(todo));
  }
  // Fold them into the snapshot (and clean up already-saved leftovers).
  scheduleSave();
}

// The old unscoped native snapshot, stamped with this account and saved under
// its key (the old key is deleted in the same transaction). Its pending writes
// then drain to the server they were made against, as this account. A snapshot
// that already names an owner is not legacy and is left alone.
async function adoptLegacyStore(S: SqlJsStatic): Promise<Database | null> {
  const legacy = await idbLoad(null);
  if (!legacy) return null;
  const database = new S.Database(new Uint8Array(legacy));
  try {
    if (database.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='local_account'")[0]?.values.length) {
      database.close();
      return null;
    }
    database.run("CREATE TABLE local_account (scope TEXT NOT NULL)");
    database.run("INSERT INTO local_account VALUES (?)", [storageScope!]);
    prepareLocalDatabase(database);
    await idbAdoptLegacy(database.export().buffer as ArrayBuffer, storageScope!);
  } catch (error) { database.close(); throw error; }
  return database;
}

/** The cached workspace for the first paint. `listOnly` (loadBootstrapList)
 *  leaves out what the list and sidebar do not need: edges, pointers, tasks,
 *  suggestions, graph positions and every note's attrs map (empty here). Those
 *  arrive through loadBootstrapRelations / loadAttributePage, which the caller
 *  reads when idle and merges. Everything else is the same, including the queue
 *  projection, so a pending edit is in the first paint either way. */
async function loadBootstrapCore(listOnly: boolean): Promise<Bootstrap | null> {
  const ws = qry<Omit<Workspace, "modules" | "modules_to_confirm" | "line_words"> & { line_words?: string | null; actor_role: string | null; actor_is_owner?: number | null; can_review?: number | null; site_config: string | null; chrome: string | null; modules?: string | null; modules_to_confirm?: string | null }>("SELECT * FROM workspace LIMIT 1");
  if (ws.length === 0) return null;
  const pending = await getPendingWrites();
  // A large workspace paints slim, like its online session: bodies stay in the
  // local database and are read when a note opens (hydrateNode → getStoredBody
  // offline). body_len marks a row whose body is elsewhere; NULL (older
  // builds) stays unknown. A note with queued writes keeps its full text —
  // that is the user's own input and must open as written.
  // A slim paint does not even read the other bodies out of SQLite (at 20k
  // notes they are most of this query); md_len stands in for a NULL body_len.
  const slimPaint = (qry<{ n: number }>("SELECT COUNT(*) AS n FROM nodes")[0]?.n ?? 0) >= SLIM_MODE_NODE_THRESHOLD;
  const queuedIds = queuedNoteIds(pending);
  // In sibling order (lib/childOrder: order_key, order_stamp, id) like the server's bootstrap, by byte (SQLite's
  // default collation); a row with no key (written locally and not yet answered by the server) goes last.
  const stored = qry<ContentNode & { body_len: number | null; created_at: string | null; md_len: number }>(
    `SELECT id, source_type, node_type, title, slug, ${slimPaint ? "CASE WHEN id IN (SELECT value FROM json_each(?)) THEN markdown ELSE '' END" : "markdown"} AS markdown, parent_id, CAST(hidden AS INTEGER) as hidden, order_key, order_stamp, presentation, tag_schema, class_tag_ids, label_tag_ids, updated_at, body_len, space_id, created_at, collection_views, LENGTH(markdown) AS md_len FROM nodes`
    + " ORDER BY order_key IS NULL, order_key ASC, order_stamp ASC, id ASC",
    slimPaint ? [JSON.stringify([...queuedIds])] : [],
  );
  const nodes: ContentNode[] = stored.map(({ body_len, created_at, md_len, ...rest }) => {
    const n: ContentNode = created_at ? { ...rest, created_at } : rest;
    const length = body_len ?? (md_len > 0 ? md_len : null);
    return length === null ? n : { ...n, body_len: length };
  });
  const { edges, pointers, tasks, suggestions, graph_positions: graphPositions } = listOnly
    ? { edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] }
    : readBootstrapRelations();
  const canvasMemberships = qry<CanvasMembership>("SELECT canvas_id, canvas_title, node_id FROM canvas_memberships");
  const noteAnchors = qry<NoteAnchor>(NOTE_ANCHORS_SELECT);
  const noteLinkBindings = qry<LinkBinding>(NOTE_LINK_BINDINGS_SELECT);
  // Group attribute rows by node id so we can attach the flat {key:value} map
  // to the matching ContentNode below — mirrors the bootstrap shape.
  // Drawings stay out of the in-memory map: every reader loads them on open
  // (lib/ink/store), and at scale they were most of the painted heap.
  const attrsByNode = new Map<string, Record<string, string>>();
  if (!listOnly) {
    const attrRows = qry<{ node_id: string; key: string; value: string }>(`SELECT node_id, key, value FROM node_attributes WHERE key NOT IN (${DRAWING_KEYS_SQL})`);
    for (const row of attrRows) {
      const map = attrsByNode.get(row.node_id) ?? {};
      map[row.key] = row.value;
      attrsByNode.set(row.node_id, map);
    }
  }
  const restoredNodes = [...projectPendingNoteText(nodes.map((n) => ({
      ...n,
      hidden: Boolean(n.hidden),
      presentation: n.presentation ? JSON.parse(n.presentation as unknown as string) : null,
      // Tag identity round-trips as JSON so offline cold start keeps class-tag
      // schema + the class/label membership arrays (mirrors the bootstrap shape).
      tag_schema: n.tag_schema ? JSON.parse(n.tag_schema as unknown as string) : null,
      class_tag_ids: n.class_tag_ids ? JSON.parse(n.class_tag_ids as unknown as string) : [],
      label_tag_ids: n.label_tag_ids ? JSON.parse(n.label_tag_ids as unknown as string) : [],
      collection_views: n.collection_views ? JSON.parse(n.collection_views as unknown as string) : null,
      attrs: attrsByNode.get(n.id) ?? {},
    })), pending), ...missingPendingNoteCreations(nodes, pending)];
  // Projected queued text is what this row now holds. A queued change that
  // carries no text (title only) on a never-downloaded note keeps its body_len,
  // so the note still reads as "not here yet" instead of opening empty.
  const paintedNodes = restoredNodes.map((n) => queuedIds.has(n.id) && n.markdown ? { ...n, body_len: n.markdown.length } : n);
  return {
    ...(slimPaint ? { bodies: "none" as const } : {}),
    workspace: { ...ws[0], modules: readWorkspaceModules(ws[0].modules), modules_to_confirm: readWorkspaceModules(ws[0].modules_to_confirm), line_words: readLineWords(ws[0].line_words) },
    ...readWorkspaceSettings(ws[0]),
    // A queue commit can precede its optimistic cache upsert. On offline cold
    // start the durable request still supplies the pending text in that gap.
    nodes: paintedNodes,
    edges,
    pointers,
    tasks,
    suggestions,
    events: [],
    actor_role: ws[0].actor_role ?? null,
    actor_is_owner: ws[0].actor_is_owner === 1,
    can_review: ws[0].can_review === 1,
    tags: restoreTagCatalog(qry<{ value: string }>("SELECT value FROM sync_state WHERE key='tags_json'")[0]?.value, paintedNodes),
    timezone: qry<{ value: string }>("SELECT value FROM sync_state WHERE key='timezone'")[0]?.value,
    canvas_memberships: canvasMemberships,
    graph_positions: graphPositions,
    note_anchors: noteAnchors,
    note_link_bindings: noteLinkBindings,
  };
}

/** The workspace's edges, pointers, tasks, suggestions and graph positions, as
 *  the bootstrap carries them. */
function readBootstrapRelations() {
  return {
    edges: qry<NodeEdge>("SELECT * FROM edges"),
    pointers: qry<NotePointer>("SELECT id, parent_id, target_id, order_key, order_stamp, display_prefix FROM pointers ORDER BY order_key IS NULL, order_key ASC, order_stamp ASC, id ASC"),
    tasks: qry<Record<string, unknown>>("SELECT * FROM tasks").map(decodeTaskRow),
    suggestions: qry<AiSuggestion>("SELECT id, target_id, suggestion_type, payload, status, reasoning FROM suggestions")
      .map((s) => ({ ...s, payload: JSON.parse(s.payload as unknown as string) })),
    graph_positions: qry<{ node_id: string; x: number; y: number }>("SELECT node_id, x, y FROM graph_positions")
      .map(({ node_id, x, y }) => ({ nodeId: node_id, x, y })),
  };
}

const loadBootstrap = () => loadBootstrapCore(false);
const loadBootstrapList = () => loadBootstrapCore(true);
const loadBootstrapRelations = async () => readBootstrapRelations();

/** One page of the attrs maps loadBootstrapList left empty: rows after the
 *  previous page's `next` (0 to start), in storage order; `next` is null on the
 *  last page. Each page is its own request so other requests run between pages. */
async function loadAttributePage(after: number, limit: number): Promise<{ rows: Array<{ node_id: string; key: string; value: string }>; next: number | null }> {
  const page = qry<{ rowid: number; node_id: string; key: string; value: string }>(
    `SELECT rowid, node_id, key, value FROM node_attributes WHERE rowid > ? AND key NOT IN (${DRAWING_KEYS_SQL}) ORDER BY rowid LIMIT ?`,
    [after, limit],
  );
  return { rows: page.map(({ node_id, key, value }) => ({ node_id, key, value })), next: page.length < limit ? null : page[page.length - 1]!.rowid };
}

// The sync cursor only moves forward: a late or repeated write cannot lower it.
const CURSOR_MAX_SQL = "INSERT INTO sync_state (key, value) VALUES ('last_event_id', ?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)";

async function persistBootstrap(data: Bootstrap): Promise<Bootstrap & { answer_stale?: true; answer_watermark?: string | null; answer_server?: string | null }> {
  // ?nodes=none: the workspace parts only; every node row stays as it is.
  // The same rule as a delta (lib/answerPositions.ts): a bootstrap's head is the event cursor it was read at. A bootstrap
  // from another server identity is that server's whole state: it is taken, and the watermark starts over.
  const verdict = await judgeAnswer(data.last_event_id, data.server_id);
  if (!verdict.changed && !verdict.current) return { ...data, answer_stale: true, answer_watermark: watermark(), answer_server: knownServerId() };
  // Another identity's ?nodes=none is not its whole state: the rows here are the old log's, so a rebuild is owed.
  if (verdict.changed && data.nodes_omitted === true) await forgetCopyWatermark();
  await adoptServerIdentity(data.server_id);
  if (data.nodes_omitted === true) {
    persistBootstrapMetaInto(getDb(), data);
    if (data.last_event_id != null) await raiseWatermark(String(data.last_event_id));
    scheduleSave();
    return data;
  }
  const pending = await getPendingWrites();
  const drops = data.bodies === "none" ? slimBootstrapNodeDrops(
    new Set(data.nodes.map(n => n.id)), qry<{ id: string }>("SELECT id FROM nodes").map(row => row.id),
  ) : [];
  const served = data.nodes;
  data = { ...data, nodes: [...projectPendingNoteText(data.nodes, pending), ...missingPendingNoteCreations(data.nodes, pending)] };
  noteHeldText(served, data.nodes);
  // The remote readable set decides which old mirrors to clear. Only durable
  // creation input supplies missing local notes; never retain the old metadata.
  persistBootstrapInto(getDb(), data, drops);
  // The rebuild owed since the server went back (forgetCopyWatermark) is this whole snapshot.
  getDb().run("DELETE FROM sync_state WHERE key='rebuild_owed'");
  // When the mirror last took a whole snapshot (syncEngine: the daily refresh).
  getDb().run(
    "INSERT INTO sync_state (key, value) VALUES ('full_refresh_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [String(Date.now())] as any,
  );
  // GAP-249: a mirror with no sync cursor yet now holds this payload, so its
  // event sync may start where the payload is current instead of since=0. An
  // existing cursor is never moved: the mirror may still lack changes between
  // it and the payload (a slim bootstrap merges, it does not replay deletes).
  if (data.last_event_id != null && /^\d+$/.test(data.last_event_id)) {
    getDb().run(
      // An older payload than the cursor (a slow download that landed after
      // newer deltas) rewinds it: it replaced newer rows, and replaying the
      // deltas from its own position is idempotent. A newer one never moves it.
      "INSERT INTO sync_state (key, value) VALUES ('last_event_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(excluded.value AS INTEGER) < CAST(value AS INTEGER)",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [data.last_event_id] as any,
    );
    await raiseWatermark(String(data.last_event_id));
  }
  scheduleSave();
  return data;
}

/** The page refused an answer this copy had already applied (its own watermark rose while the copy worked): the cursor
 *  goes back to where that request started, so the next request carries everything again for the page as well. */
async function rewindCursor(to: string): Promise<void> {
  if (!/^\d+$/.test(to)) return;
  run("UPDATE sync_state SET value=? WHERE key='last_event_id' AND CAST(value AS INTEGER) > CAST(? AS INTEGER)", [to, to]);
  scheduleSave();
}

/** What the page starts from on load, and learns at each sync pass's start: the watermark and identity this copy holds,
 *  and whether a rebuild is owed (the server went back and no whole bootstrap was stored since). */
async function getWatermark(): Promise<{ position: string | null; server: string | null; rebuildOwed: boolean }> {
  // Another tab's raises and owed rebuild first (best effort, as judgeAnswer).
  await catchUpWithOtherTabs().catch((error: unknown) => console.warn("[onden] could not read other tabs' changes before the watermark", error));
  return { position: watermark(), server: knownServerId(), rebuildOwed: qry("SELECT 1 FROM sync_state WHERE key='rebuild_owed'").length > 0 };
}

/** A single note read from the server. `head`: where it was read (READ_HEAD_HEADER): judged like any answer
 *  (lib/answerPositions.ts); a read from before what this copy knows is not stored (`answer_stale`). */
async function persistRemoteNode(node: ContentNode, head?: string, serverId?: string): Promise<ContentNode & { answer_stale?: true; answer_watermark?: string | null; answer_server?: string | null }> {
  const verdict = head === undefined ? null : await judgeAnswer(head, serverId);
  if (verdict?.changed) await forgetCopyWatermark(); // another identity: a rebuild is owed, as applySync
  if (verdict && !verdict.current) {
    // Read again later, from this copy's own list (held_text: it goes with the snapshot to a reload and to other tabs);
    // the next read that is taken takes it off (noteHeldText).
    const held = heldNoteIds();
    if (!held.has(node.id)) { held.add(node.id); writeHeldText(held); }
    return { ...node, answer_stale: true, answer_watermark: watermark(), answer_server: knownServerId() };
  }
  const [projected] = projectPendingNoteText([node], await getPendingWrites());
  await upsertNode(projected);
  if (head !== undefined) await raiseWatermark(head);
  noteHeldText([node], [projected]);
  return projected;
}

// Notes whose stored text is queued text kept over a NEWER server row (a bootstrap, a delta or a single read that
// came while a write of the note was queued: pendingNoteProjection). The cursor moved past the server's version, so
// no later delta brings it again: once nothing is queued for the note, the page reads it again
// (syncEngine.releaseHeldNotes). Kept in the copy (sync_state), so it goes with the snapshot to the next page load and
// to other tabs: the write is often sent by another page than the one that took the server row.
const HELD_TEXT = "held_text";
function heldNoteIds(): Set<string> {
  try { return new Set(JSON.parse(qry<{ value: string }>("SELECT value FROM sync_state WHERE key=?", [HELD_TEXT])[0]?.value ?? "[]") as string[]); }
  catch { return new Set(); }
}
function writeHeldText(held: Set<string>): void {
  run("INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [HELD_TEXT, JSON.stringify([...held])]);
  scheduleSave();
}
/** `stored[i]` is what the copy now holds for the server's `served[i]`. */
function noteHeldText(served: ContentNode[], stored: ContentNode[]): void {
  const held = heldNoteIds();
  let changed = false;
  served.forEach((row, i) => {
    const kept = stored[i] && (stored[i]!.title !== row.title || stored[i]!.markdown !== row.markdown);
    if (kept && !held.has(row.id)) { held.add(row.id); changed = true; }
    else if (!kept && held.delete(row.id)) changed = true;
  });
  if (changed) writeHeldText(held);
}
/** Held notes nothing is queued for any more: the server's row is to be read again. Notes gone from the copy are forgotten. */
async function heldNotesNowSent(): Promise<string[]> {
  const held = heldNoteIds();
  if (held.size === 0) return [];
  const present = new Set(qry<{ id: string }>(`SELECT id FROM nodes WHERE id IN (${[...held].map(() => "?").join(",")})`, [...held]).map((row) => row.id));
  if ([...held].some((id) => !present.has(id))) writeHeldText(new Set([...held].filter((id) => present.has(id))));
  const queued = queuedNoteIds(await getPendingWrites());
  return [...held].filter((id) => present.has(id) && !queued.has(id));
}

/** Resolve `replace_for` against the local mirror: an edge touching a listed
 * node and absent from the authoritative set is deleted. Queued edge writes are
 * the user's own unsent input, so a pending create is kept and a pending
 * delete is not revived by the server's older row. */
function replaceTouchingEdges(edges: SyncDelta["edges"], pending: PendingWrite[]): SyncDelta["edges"] {
  const { replace_for: scope, ...explicit } = edges;
  const queued = queuedEdgeWrites(pending);
  const upsert = explicit.upsert.filter(edge => !queued.deleted.has(edge.id));
  if (!scope?.length) return { ...explicit, upsert };
  const shipped = new Set(explicit.upsert.map(edge => edge.id));
  const stale = qry<{ id: string }>(
    `SELECT id FROM edges WHERE source_node_id IN (SELECT value FROM json_each(?))
       OR target_node_id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(scope), JSON.stringify(scope)],
  ).map(row => row.id).filter(id => !shipped.has(id) && !queued.created.has(id));
  return { upsert, delete: [...new Set([...explicit.delete, ...stale])] };
}

function queuedEdgeWrites(pending: PendingWrite[]): { created: Set<string>; deleted: Set<string> } {
  const created = new Set<string>(), deleted = new Set<string>();
  for (const write of pending) {
    const into = write.method === "POST" ? created : write.method === "DELETE" ? deleted : null;
    if (!into) continue;
    for (const target of writeTargets(write)) if (target.kind === "edge" && target.part === undefined) into.add(target.id);
  }
  return { created, deleted };
}

/** Notes (tags too: they are nodes) with a queued write on them or a part of
 *  them, including their own queued create. A write that only mentions a note
 *  (an edge to it, a link in a body) does not count. */
function queuedNoteIds(pending: PendingWrite[]): Set<string> {
  return new Set(pending.flatMap((write) => [...targetIds(write, "node"), ...targetIds(write, "tag")]));
}

/** Resolve pointer `replace_for` against the mirror into explicit deletes.
 * Pointer writes are online-only (never queued), so there is no pending input
 * to protect, unlike edges. */
function replaceTouchingPointers(pointers: NonNullable<SyncDelta["pointers"]>): NonNullable<SyncDelta["pointers"]> {
  const { replace_for: scope, ...explicit } = pointers;
  if (!scope?.length) return explicit;
  const shipped = new Set(explicit.upsert.map(pointer => pointer.id));
  const stale = qry<{ id: string }>(
    `SELECT id FROM pointers WHERE parent_id IN (SELECT value FROM json_each(?))
       OR target_id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(scope), JSON.stringify(scope)],
  ).map(row => row.id).filter(id => !shipped.has(id));
  return { upsert: explicit.upsert, delete: [...new Set([...explicit.delete, ...stale])] };
}

/** Resolve the membership `replace_for` (D98) against the mirror into
 * explicit deletes: a held membership whose note or canvas is listed and
 * that the server no longer ships is gone. The result carries no
 * replace_for, so the store applies exactly what the mirror did. */
function replaceTouchingMemberships(memberships: NonNullable<SyncDelta["canvas_memberships"]>): CanvasMembershipChange {
  const { replace_for: scope, upsert } = memberships;
  const explicit = memberships.delete ?? [];
  if (!scope?.length) return { upsert, delete: explicit };
  const shipped = new Set(upsert.map(m => `${m.canvas_id}\u0000${m.node_id}`));
  const stale = qry<{ canvas_id: string; node_id: string }>(
    `SELECT canvas_id, node_id FROM canvas_memberships WHERE node_id IN (SELECT value FROM json_each(?))
       OR canvas_id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(scope), JSON.stringify(scope)],
  ).filter(m => !shipped.has(`${m.canvas_id}\u0000${m.node_id}`));
  return { upsert, delete: [...explicit, ...stale] };
}

/** The server identity this copy's cursor and watermark count in (lib/answerPositions.ts), null before any answer said. */
function knownServerId(): string | null {
  return qry<{ value: string }>("SELECT value FROM sync_state WHERE key='server_id'")[0]?.value ?? null;
}

/** The highest position this copy knows of for its server (lib/answerPositions.ts), null for none. */
function watermark(): string | null {
  return qry<{ value: string }>("SELECT value FROM sync_state WHERE key='answer_watermark'")[0]?.value ?? null;
}

const RAISE_WATERMARK_SQL = `INSERT INTO sync_state (key, value) VALUES ('answer_watermark', ?) ON CONFLICT(key) DO UPDATE SET
  value = CASE WHEN CAST(excluded.value AS INTEGER) > CAST(value AS INTEGER) THEN excluded.value ELSE value END`;

/** Raise the watermark to `position` (never lower it). Journaled, so another tab on this copy takes it in before it
 *  applies an answer (catchUpWithOtherTabs), and a reload keeps it. */
async function raiseWatermark(position: string): Promise<void> {
  if (!/^\d+$/.test(position) || higherPosition(watermark(), position) === watermark()) return;
  run(RAISE_WATERMARK_SQL, [position]);
  await makeDurable({ t: "sql", stmts: [[RAISE_WATERMARK_SQL, [position]]] }, { critical: false });
}

/** The server went back (lib/data/writePositions.ts serverWentBack), or answers under another identity (applySync,
 *  a ?nodes=none persistBootstrap): the watermark starts over, and a rebuild is owed until a whole bootstrap is stored
 *  (persistBootstrap), across reloads. Returns whether it was owed already (the person
 *  is told once per going back). Durable before it returns: a failure throws. */
async function forgetCopyWatermark(): Promise<{ alreadyOwed: boolean }> {
  const alreadyOwed = qry("SELECT 1 FROM sync_state WHERE key='rebuild_owed'").length > 0;
  const stmts: Array<[string, unknown[]]> = [
    ["DELETE FROM sync_state WHERE key='answer_watermark'", []],
    ["INSERT INTO sync_state (key, value) VALUES ('rebuild_owed', '1') ON CONFLICT(key) DO NOTHING", []],
  ];
  for (const [sql, params] of stmts) run(sql, params);
  await makeDurable({ t: "sql", stmts }, { critical: true });
  return { alreadyOwed };
}

/** Another server identity: another event log. Its positions say nothing about what this copy knew, so the watermark
 *  starts over; returns whether it changed. Journaled like a raise. */
async function adoptServerIdentity(id: string | undefined): Promise<boolean> {
  if (id === undefined) return false;
  const known = knownServerId();
  if (known === id) return false;
  const stmts: Array<[string, unknown[]]> = [
    ["INSERT INTO sync_state (key, value) VALUES ('server_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [id]],
    ...(known === null ? [] : [["DELETE FROM sync_state WHERE key='answer_watermark'", []] as [string, unknown[]]]),
  ];
  for (const [sql, params] of stmts) run(sql, params);
  await makeDurable({ t: "sql", stmts }, { critical: false });
  return known !== null;
}

/** One answer that carries rows, before it is applied: another tab's raises are taken in first. `changed`: another
 *  server identity (the engine rebuilds from a whole bootstrap); `current`: it may be applied. */
async function judgeAnswer(head: string | number | undefined, serverId: string | undefined): Promise<{ changed: boolean; current: boolean }> {
  // Best effort: storage that cannot be read now leaves this tab judging by what it knows itself (its own raises are
  // always in), which is what it did before any other tab wrote.
  await catchUpWithOtherTabs().catch((error: unknown) => console.warn("[onden] could not read other tabs' changes before an answer", error));
  if (serverId !== undefined && knownServerId() !== null && knownServerId() !== serverId) return { changed: true, current: false };
  return { changed: false, current: isCurrentAnswer(head, watermark()) };
}

async function applySync(delta: SyncDelta): Promise<AppliedSyncDelta> {
  // The one rule (lib/answerPositions.ts): an answer read before what this copy knows is not applied at all.
  const verdict = await judgeAnswer(delta.head_event_id, delta.server_id);
  if (verdict.changed) { await forgetCopyWatermark(); return { ...emptyDeltaOf(delta), serverChanged: true }; } // a rebuild is owed
  if (!verdict.current) return { ...emptyDeltaOf(delta), stale: true, answer_watermark: watermark(), answer_server: knownServerId() };
  await adoptServerIdentity(delta.server_id);
  const pending = await getPendingWrites();
  const catalogTouched = delta.tags !== undefined || delta.nodes.delete.length > 0
    || delta.nodes.upsert.some(node => isTag(node));
  // Legacy snapshots have no independent catalog; loadBootstrap supplies the
  // old readable-node fallback exactly once before the new cache is written.
  let previousTags: Tag[] | undefined;
  if (catalogTouched && delta.tags === undefined) {
    const stored = qry<{ value: string }>("SELECT value FROM sync_state WHERE key='tags_json'")[0]?.value;
    previousTags = stored === undefined ? (await loadBootstrap())?.tags : restoreTagCatalog(stored, []);
  }
  const projected = projectPendingNoteText(delta.nodes.upsert, pending);
  noteHeldText(delta.nodes.upsert, projected);
  const heldText = projected.filter((node, i) => node.title !== delta.nodes.upsert[i]!.title || node.markdown !== delta.nodes.upsert[i]!.markdown).map((node) => node.id);
  delta = { ...delta, nodes: { ...delta.nodes, upsert: projected },
    edges: replaceTouchingEdges(delta.edges, pending),
    ...(delta.pointers ? { pointers: replaceTouchingPointers(delta.pointers) } : {}),
    ...(delta.canvas_memberships ? { canvas_memberships: replaceTouchingMemberships(delta.canvas_memberships) } : {}) };
  // A settings change of this device's still waiting in the queue: keep the
  // local design rather than the server's older one (the queued change
  // arrives with a later delta). Dropped from the result too, so the store
  // keeps it as well.
  if (delta.site_config !== undefined && pending.some(write => write.path === "/api/workspace/config")) {
    delta = { ...delta, site_config: undefined, chrome: undefined };
  }
  let pendingCreations: ContentNode[] = [];
  const d = getDb();
  d.run("BEGIN");
  try {
    if (catalogTouched) persistTagCatalogInto(d, applyTagCatalog(previousTags, delta) ?? []);
    for (const n of delta.nodes.upsert) upsertNodeInto(d, n, { from: "server" });
    for (const e of delta.edges.upsert) upsertEdgeInto(d, e);
    for (const id of delta.edges.delete) {
      d.run("DELETE FROM edges WHERE id = ?", [id] as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    for (const t of delta.tasks.upsert) {
      upsertTaskInto(d, t);
    }
    for (const p of delta.pointers?.upsert ?? []) upsertPointerInto(d, p);
    for (const id of delta.pointers?.delete ?? []) {
      d.run("DELETE FROM pointers WHERE id = ?", [id] as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    if (delta.canvas_memberships) applyCanvasMembershipChangeInto(d, { upsert: delta.canvas_memberships.upsert, delete: delta.canvas_memberships.delete ?? [] });
    if (delta.note_anchors) applyNoteAnchorDeltaInto(d, delta.note_anchors);
    if (delta.note_link_bindings) applyLinkBindingDeltaInto(d, delta.note_link_bindings);
    for (const id of delta.tasks.delete) {
      d.run("DELETE FROM tasks WHERE id = ?", [id] as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    // Attribute deltas — mirror the (node_id, key) compound key. Defensive
    // optional chain because older backends won't include this field.
    if (delta.attributes) {
      for (const a of delta.attributes.upsert) upsertAttributeInto(d, a);
      for (const a of delta.attributes.delete) {
        d.run("DELETE FROM node_attributes WHERE node_id = ? AND key = ?", [a.node_id, a.key] as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      }
    }
    if (delta.workspace) {
      const w = delta.workspace;
      d.run("UPDATE workspace SET name=?, slug=?, home_node_id=?, modules=?, modules_to_confirm=?, time_zone=?, day_start_hour=?, line_words=?", [w.name, w.slug, w.home_node_id ?? null, writeWorkspaceModules(w.modules), writeWorkspaceModules(w.modules_to_confirm), w.time_zone ?? null, w.day_start_hour ?? 0, writeLineWords(w.line_words)] as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    if (delta.site_config !== undefined) updateWorkspaceSettingsInto(d, { site_config: delta.site_config, chrome: delta.chrome ?? null });
    // Delete after every remote channel so a same-batch edge/task/attribute
    // cannot revive revoked data. Recreate only the user's own queued input.
    for (const id of delta.nodes.delete) dropNodeFromMirror(d, id);
    pendingCreations = missingPendingNoteCreations([], pending)
      .filter(note => qry<{ id: string }>("SELECT id FROM nodes WHERE id = ?", [note.id]).length === 0);
    for (const note of pendingCreations) await upsertNode(note);
    d.run(
      CURSOR_MAX_SQL,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [String(delta.last_event_id)] as any
    );
    d.run("COMMIT");
  } catch (e) {
    d.run("ROLLBACK");
    throw e;
  }
  scheduleSave();
  // Always derive this field locally; ignore any same-named wire property.
  // Applied: what it carried is known at its head, so an answer read earlier and arriving later is refused too.
  if (delta.head_event_id !== undefined) await raiseWatermark(delta.head_event_id);
  return { ...delta, pendingCreations, ...(heldText.length ? { heldText } : {}) };
}

/** An answer with every channel empty and its cursor fields kept: what applySync returns when it applies nothing. */
function emptyDeltaOf(delta: SyncDelta): SyncDelta {
  return {
    last_event_id: delta.last_event_id, ...(delta.head_event_id !== undefined ? { head_event_id: delta.head_event_id } : {}),
    nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] },
    attributes: { upsert: [], delete: [] }, workspace: null,
  };
}

async function upsertAttribute(
  nodeId: string, key: string, value: string, valueType = "text",
  isInheritable = false, source = "ui",
): Promise<void> {
  upsertAttributeInto(getDb(), { node_id: nodeId, key, value, value_type: valueType, is_inheritable: isInheritable, source });
  scheduleSave();
}

async function removeAttribute(nodeId: string, key: string): Promise<void> {
  const d = getDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d.run("DELETE FROM node_attributes WHERE node_id = ? AND key = ?", [nodeId, key] as any);
  scheduleSave();
}

/** Read one mirrored attribute value — the offline cold-start fallback for the
 *  ink hosts, whose primary read is a network GET of /attributes. A drawing
 *  made offline and reloaded WHILE STILL OFFLINE lives only in this mirror;
 *  without this read the network GET fails and the strokes look lost. Returns
 *  null when the node/key isn't mirrored. */
async function getNodeAttribute(nodeId: string, key: string): Promise<string | null> {
  const rows = qry<{ value: string }>(
    "SELECT value FROM node_attributes WHERE node_id = ? AND key = ? LIMIT 1",
    [nodeId, key],
  );
  return rows[0]?.value ?? null;
}

async function getNodeAttributeRecord(nodeId: string, key: string): Promise<NodeAttribute | null> {
  const row = qry<Omit<NodeAttribute, "is_inheritable"> & { is_inheritable: number }>(
    "SELECT key, value, value_type, is_inheritable, source FROM node_attributes WHERE node_id = ? AND key = ?",
    [nodeId, key],
  )[0];
  return row ? { ...row, is_inheritable: !!row.is_inheritable } : null;
}

/** Advance ONLY the sync cursor — for deltas whose 500-event window carried
 *  nothing the frontend projects (governance/audit events). Audit #3: the
 *  empty-delta early return skipped applySync, so the cursor never moved and
 *  the client refetched the same batch forever. */
async function setLastEventId(id: number | string): Promise<void> {
  const d = getDb();
  d.run(
    CURSOR_MAX_SQL,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [String(id)] as any,
  );
  scheduleSave();
}

function eventCursorIn(database: Database): number | null {
  const value = database.exec("SELECT value FROM sync_state WHERE key = 'last_event_id'")[0]?.values[0]?.[0];
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
}

/** Set when this tab took in a stored copy older than its own (adoptStoredSnapshot): the cursor the next sync request
 *  starts from. Any read sees it (the lower of it and the stored cursor); only the read that starts a sync request
 *  (`startingSync`) spends it, so it does not matter which of the cursor's readers asks first. */
let adoptedCursor: number | null = null;

async function getLastEventId({ startingSync = false }: { startingSync?: boolean } = {}): Promise<number> {
  const rows = qry<{ value: string }>("SELECT value FROM sync_state WHERE key = 'last_event_id'");
  const stored = rows.length > 0 ? parseInt(rows[0].value, 10) : 0;
  if (adoptedCursor === null || stored <= adoptedCursor) {
    if (startingSync) adoptedCursor = null;
    return stored;
  }
  const floor = adoptedCursor;
  if (!startingSync) return floor;
  adoptedCursor = null;
  run("UPDATE sync_state SET value=? WHERE key='last_event_id'", [String(floor)]);
  scheduleSave();
  return floor;
}

// The membership epoch the client last reconciled to (Step B). Separate cursor
// from last_event_id: the event cursor advances on every write, the membership
// epoch only on permission changes — the client reconciles membership ONLY when
// this lags the server's epoch. Persisted so a cold start doesn't re-reconcile.
async function setMembershipEpoch(epoch: number): Promise<void> {
  const d = getDb();
  d.run(
    "INSERT INTO sync_state (key, value) VALUES ('membership_epoch', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [String(epoch)] as any,
  );
  scheduleSave();
}

/** Keep a copy of server attribute values this device lacks (localDbPersist.fillAttributesInto). */
async function fillNodeAttributes(nodeId: string, rows: Array<{ key: string; value: string; value_type?: string; is_inheritable?: boolean; source?: string }>): Promise<void> {
  await fillAttributeRows(rows.map((row) => ({ ...row, node_id: nodeId })));
}

/** The same for rows of several notes (the offline drawing download). Rows
 *  of notes this device does not hold are skipped. A mirror change: the
 *  coalesced snapshot saves it (scheduleSave), never a save of its own. */
async function fillAttributeRows(rows: Array<{ node_id: string; key: string; value: string; value_type?: string; is_inheritable?: boolean; source?: string }>): Promise<number> {
  const held = new Set(qry<{ id: string }>(
    "SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) UNION SELECT id FROM tasks WHERE id IN (SELECT value FROM json_each(?))",
    [JSON.stringify(rows.map((r) => r.node_id)), JSON.stringify(rows.map((r) => r.node_id))],
  ).map((r) => r.id));
  const kept = rows.filter((r) => held.has(r.node_id));
  if (kept.length === 0) return 0;
  fillAttributesInto(getDb(), kept);
  scheduleSave();
  return kept.length;
}

/** Of these (note, key) pairs, the notes this device holds without a copy of
 *  that value (the offline drawing download's to-do list). */
/** SHA-256 hex of a UTF-8 string, or null where Web Crypto is missing (the
 *  download then fetches only missing copies, never replaces one). */
async function sha256Hex(text: string): Promise<string | null> {
  return (await webCryptoSha256()?.(text)) ?? null;
}

/** Notes with a queued write to their attributes: their copies are the
 *  person's own input, never replaced from the server. */
async function notesWithQueuedAttributes(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const write of await getPendingWrites()) {
    for (const target of writeTargets(write)) {
      if (target.kind === "node" && target.part?.split("/")[0] === "attributes") out.add(target.id);
    }
  }
  return out;
}

/** The offline drawing download's to-do list (localDbPersist.planDrawingDownload). */
async function planDrawings(index: DrawingIndexEntry[]): Promise<ReturnType<typeof planDrawingDownload>> {
  const ids = JSON.stringify([...new Set(index.map((e) => e.node_id))]);
  const held = new Set(qry<{ id: string }>(
    "SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) UNION SELECT id FROM tasks WHERE id IN (SELECT value FROM json_each(?))", [ids, ids],
  ).map((r) => r.id));
  const keys = JSON.stringify([...new Set(index.map((e) => e.key))]);
  const local = new Map<string, LocalDrawingCopy>();
  for (const row of qry<{ node_id: string; key: string; value: string; updated_at: string | null }>(
    "SELECT node_id, key, value, updated_at FROM node_attributes WHERE node_id IN (SELECT value FROM json_each(?)) AND key IN (SELECT value FROM json_each(?))", [ids, keys],
  )) local.set(drawingCopyKey(row.node_id, row.key), { hash: await sha256Hex(row.value), updated_at: row.updated_at });
  return planDrawingDownload(index, held, local, await notesWithQueuedAttributes(), Date.now());
}

/** Replace copies the plan found stale with the server's value — each only if
 *  it still has the hash it was planned with and no attribute write of its
 *  note is queued (the person drew meanwhile: their copy wins). */
async function replaceStaleAttributeRows(rows: Array<{ node_id: string; key: string; value: string; value_type?: string; is_inheritable?: boolean; source?: string; expected_hash: string }>): Promise<number> {
  const replaced = await replaceStaleCopiesInto(getDb(), rows, await notesWithQueuedAttributes(), sha256Hex);
  if (replaced) scheduleSave();
  return replaced;
}

/** When persistBootstrap last stored a whole snapshot (ms since epoch), 0 if never. */
async function getLastFullRefresh(): Promise<number> {
  const rows = qry<{ value: string }>("SELECT value FROM sync_state WHERE key = 'full_refresh_at'");
  const at = rows.length > 0 ? Number(rows[0].value) : 0;
  return Number.isFinite(at) ? at : 0;
}

/** The caller's spaces as the server last listed them (lib/spaces.ts), so an offline start knows the personal space.
 *  Kept with the copy's sync state: it goes with the snapshot, a wipe drops it, and a new MIRROR_SCHEMA_VERSION drops it
 *  too (localDbSchema stampMirrorSchema) — the server has renumbered spaces before (its migration 201). Null: none kept. */
async function loadSpaces(): Promise<unknown[] | null> {
  const raw = qry<{ value: string }>("SELECT value FROM sync_state WHERE key = 'spaces'")[0]?.value;
  if (!raw) return null;
  try { const list: unknown = JSON.parse(raw); return Array.isArray(list) ? list : null; } catch { return null; }
}

async function storeSpaces(spaces: unknown[]): Promise<void> {
  run("INSERT INTO sync_state (key, value) VALUES ('spaces', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(spaces)]);
  scheduleSave();
}

async function getMembershipEpoch(): Promise<number> {
  const rows = qry<{ value: string }>("SELECT value FROM sync_state WHERE key = 'membership_epoch'");
  return rows.length > 0 ? parseInt(rows[0].value, 10) : 0;
}

/** The node ids the client currently holds (its CVR / "known" set). Sent on
 *  sync so the backend can diff them against the current read set and emit
 *  deletes for any that left it via a permission change — those carry no
 *  node-targeted event, so this membership diff is the only way the client
 *  learns to drop the now-unreadable stale copy (HIGH gap #2). */
async function getAllNodeIds(): Promise<string[]> {
  return qry<{ id: string }>("SELECT id FROM nodes").map((r) => r.id);
}

// The COMPLETE local membership set for the CVR / reconciliation diff: node ids
// UNION task ids. Task nodes are part of readableNodeIdSet() server-side but live
// in the local `tasks` table, not `nodes` — so a nodes-only `known` made every
// task look perpetually newly-readable AND made a task-only revocation
// impossible to detect (the revoked task id was never in `known`).
async function getAllMembershipIds(): Promise<string[]> {
  return qry<{ id: string }>("SELECT id FROM nodes UNION SELECT id FROM tasks").map((r) => r.id);
}

async function upsertNode(n: ContentNode): Promise<void> {
  // A slim row keeps this device's stored body; a local row keeps the
  // server's space (lib/localMirror.ts).
  upsertNodeInto(getDb(), n, { from: "local" });
  scheduleSave();
}

/** Offline copy (large workspaces): the next notes whose body this device has
 *  not downloaded, most recently updated first (the likeliest to be opened).
 *  `cursor` is the opaque `next` of the previous page ("" to start); `next` is
 *  null when this page is the last. Legacy rows (body_len NULL) with no text
 *  are included once; a fetched empty body records 0. */
async function missingBodyIds(cursor: string, limit: number): Promise<{ ids: string[]; next: string | null }> {
  const [afterUpdated, afterId] = cursor ? (JSON.parse(cursor) as [string, string]) : [null, null];
  const rows = qry<{ id: string; updated: string }>(
    `SELECT id, COALESCE(updated_at, '') AS updated FROM nodes
      WHERE markdown = '' AND (body_len IS NULL OR body_len > 0) AND node_type <> 'class_tag'
        AND (? IS NULL OR (COALESCE(updated_at, ''), id) < (?, ?))
      ORDER BY COALESCE(updated_at, '') DESC, id DESC LIMIT ?`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [afterUpdated, afterUpdated, afterId, limit] as any,
  );
  const last = rows[rows.length - 1];
  return { ids: rows.map((row) => row.id), next: rows.length === limit && last ? JSON.stringify([last.updated, last.id]) : null };
}

/** Store downloaded bodies in the local database only. A row that already has
 *  text (a newer sync delta, or a local edit), a row known to be empty
 *  (body_len 0: emptied while the download was in flight) and a note with
 *  queued writes are left alone — the download never replaces anything newer.
 *  Only a row that still lacks its body (same test as missingBodyIds) is
 *  written, and only then is the search index updated. */
async function storeDownloadedBodies(bodies: Array<{ id: string; markdown: string }>): Promise<number> {
  const queued = queuedNoteIds(await getPendingWrites());
  const d = getDb();
  let stored = 0;
  for (const body of bodies) {
    if (queued.has(body.id)) continue;
    d.run(
      "UPDATE nodes SET markdown = ?, body_len = ? WHERE id = ? AND markdown = '' AND (body_len IS NULL OR body_len > 0)",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [body.markdown, body.markdown.length, body.id] as any,
    );
    if (d.getRowsModified() === 0) continue;
    stored++;
    const title = qry<{ title: string }>("SELECT title FROM nodes WHERE id = ?", [body.id] as any)[0]?.title ?? ""; // eslint-disable-line @typescript-eslint/no-explicit-any
    reindexNodeText(d, body.id, title, body.markdown);
  }
  if (stored > 0) scheduleSave();
  return stored;
}

/** The locally stored body of one note, or null when this device has none
 *  (not downloaded yet). Used to open a note offline. */
async function getStoredBody(id: string): Promise<string | null> {
  const row = qry<{ markdown: string; body_len: number | null }>("SELECT markdown, body_len FROM nodes WHERE id = ?", [id] as any)[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!row) return null;
  return row.markdown !== "" || row.body_len === 0 ? row.markdown : null;
}

/** Drop one note's stored body (the row stays, slim) after the server refused
 *  to serve it, so this device stops showing it offline. Unsent local writes
 *  (an edit, or the note's own queued create) keep their body: their replay
 *  will be refused and recovered. */
async function forgetBody(id: string): Promise<boolean> {
  if (queuedNoteIds(await getPendingWrites()).has(id)) return false;
  getDb().run("UPDATE nodes SET markdown = '', body_len = NULL WHERE id = ?", [id] as any); // eslint-disable-line @typescript-eslint/no-explicit-any
  const held = heldNoteIds();
  if (held.delete(id)) writeHeldText(held);
  const changed = getDb().getRowsModified() > 0;
  if (changed) scheduleSave();
  return changed;
}

async function removeNode(id: string): Promise<void> {
  const d = recordingRun(getDb());
  const storedTags = qry<{ value: string }>("SELECT value FROM sync_state WHERE key='tags_json'")[0]?.value;
  if (storedTags !== undefined) {
    persistTagCatalogInto(d, restoreTagCatalog(storedTags, []).filter(tag => tag.id !== id));
  }
  // The node and its dependents (tasks, edges, pointers, attributes), the same
  // cascade as a sync delete: one definition in localDbPersist.
  dropNodeFromMirror(d, id);
  // "deleted note comes back on refresh" (mobile): a delete only scheduleSave()'d
  // the mirror snapshot on the 2s debounce. Refreshing/closing within that window
  // — common on mobile, where the unload-flush relay is itself best-effort — left
  // the PRE-delete snapshot on disk, so the next cold start re-painted the node
  // from the stale mirror (and an offline/flaky-LAN boot never reaches a server
  // bootstrap to correct it). A delete is rare and feels irreversible, so make it
  // durable NOW instead of debounced: flush the snapshot synchronously and await
  // the write so the dropped row can never be resurrected from a stale mirror.
  // The journal record of these statements is that durable write.
  await makeDurable({ t: "sql", stmts: d.stmts });
}

async function upsertEdge(e: NodeEdge): Promise<void> {
  upsertEdgeInto(getDb(), e);
  scheduleSave();
}

async function removeEdge(id: string): Promise<void> {
  run("DELETE FROM edges WHERE id = ?", [id]);
  scheduleSave();
}

async function upsertWorkspace(workspace: Workspace, settings: WorkspaceSettings): Promise<void> {
  upsertWorkspaceInto(getDb(), workspace, settings);
  scheduleSave();
}

async function upsertTask(t: NodeTask): Promise<void> {
  upsertTaskInto(getDb(), t);
  scheduleSave();
}

async function removeTask(id: string): Promise<void> {
  run("DELETE FROM tasks WHERE id = ?", [id]);
  scheduleSave();
}

/** Upsert a canvas into the offline mirror. `data` is optional: a list-row sync
 *  (GET /api/canvases → CanvasMeta) carries no layout, so pass it undefined and
 *  the existing layout blob is KEPT (COALESCE) rather than nulled. A full
 *  canvas (select / create / save) passes `data` to overwrite the layout. */
async function upsertCanvas(c: { id: string; title: string; created_at?: string | null; updated_at?: string | null; data?: CanvasData | null }): Promise<void> {
  const dataJson = c.data === undefined ? null : JSON.stringify(c.data);
  run(
    `INSERT INTO canvases (id, title, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=COALESCE(NULLIF(excluded.title, ''), canvases.title),
       data=COALESCE(excluded.data, canvases.data),
       created_at=COALESCE(excluded.created_at, canvases.created_at),
       updated_at=COALESCE(excluded.updated_at, canvases.updated_at)`,
    [c.id, c.title, dataJson, c.created_at ?? null, c.updated_at ?? null]
  );
  scheduleSave();
}

async function removeCanvas(id: string): Promise<void> {
  const d = recordingRun(getDb());
  d.run("DELETE FROM canvases WHERE id = ?", [id]);
  // A canvas delete is rare and feels irreversible — make it durable NOW (not
  // debounced) so a cold start within the 2s save window can't resurrect it
  // from a stale snapshot, exactly like removeNode.
  await makeDurable({ t: "sql", stmts: d.stmts });
}

/** Set which of `nodeIds` the mirror holds on canvas `canvasId`: exactly the
 *  rows of `present` (canvasWriter's mirror step, from the store's current
 *  memberships; D98). Other notes and canvases are left alone. */
async function putCanvasMemberships(canvasId: string, nodeIds: string[], present: CanvasMembership[]): Promise<void> {
  const kept = new Set(present.map(m => m.node_id));
  applyCanvasMembershipChangeInto(getDb(), {
    upsert: present.filter(m => m.canvas_id === canvasId && nodeIds.includes(m.node_id)),
    delete: nodeIds.filter(id => !kept.has(id)).map(node_id => ({ canvas_id: canvasId, node_id })),
  });
  scheduleSave();
}

/** One note's hand-placed global-graph position, or none (graphPositionWriter). */
async function putGraphPosition(nodeId: string, position: { x: number; y: number } | null): Promise<void> {
  putGraphPositionInto(getDb(), nodeId, position);
  scheduleSave();
}

/** The canvas LIST (CanvasMeta[]) for cold-start / offline — mirrors
 *  GET /api/canvases (id/title/created_at/updated_at, newest first). */
async function loadCanvases(): Promise<CanvasMeta[]> {
  return qry<CanvasMeta>(
    // Tag boards (a tag's canvas lens) share this table under 'tag-board:<id>'.
    "SELECT id, title, created_at, updated_at FROM canvases WHERE id NOT LIKE 'tag-board:%' ORDER BY updated_at DESC NULLS LAST"
  );
}

/** One canvas WITH its layout (Canvas) for offline selectCanvas — mirrors
 *  GET /api/canvases/:id. Returns null when the layout was never fetched
 *  (data IS NULL) so the caller keeps trying the network rather than showing
 *  an empty board. */
async function loadCanvas(id: string): Promise<Canvas | null> {
  const rows = qry<{ id: string; title: string; data: string | null; created_at: string | null; updated_at: string | null }>(
    "SELECT id, title, data, created_at, updated_at FROM canvases WHERE id = ?", [id]
  );
  const row = rows[0];
  if (!row || row.data == null) return null;
  return {
    id: row.id,
    title: row.title,
    data: JSON.parse(row.data) as CanvasData,
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? "",
  };
}

/** When a queued row was made, in microseconds since 1970 (well inside 2^53): the queue's order (getPendingWrites).
 *  Every save is a row from the moment it is made (writeQueue.recordWrite), and the rows of several tabs meet in one
 *  queue when one tab takes in another's journal (a closed tab's save is adopted by the next page). Each copy numbers
 *  its rows itself, so by id the other tab's older save would come after this tab's newer one: its text would be
 *  projected over the newer and sent after it. Never below the newest row this copy holds, so one tab's rows keep
 *  the order they were made in even if the clock steps back; sub-millisecond where the browser gives it
 *  (performance.now), so two tabs' saves of one millisecond keep theirs (one microsecond apart is a true tie). */
function queuedAt(): number {
  const newest = qry<{ at: number | null }>("SELECT MAX(made_at) AS at FROM pending_writes")[0]?.at ?? 0;
  const now = typeof performance === "undefined" ? Date.now() * 1000 : Math.floor((performance.timeOrigin + performance.now()) * 1000);
  return Math.max(newest + 1, now);
}

async function addPendingWrite(method: string, path: string, body: string | null, idemKey?: string | null): Promise<void> {
  // Client-minted idempotency key: the reconnect drain sends it as the
  // Idempotency-Key header so a replay (lost response, a second tab/device
  // draining the same queue) can't double-apply server-side. The caller may
  // supply one (sync-protocol §7 step 2: it's reused as the minted event_id so
  // the event can be marked synced when this write drains); otherwise mint one.
  const key = idemKey ?? randomUUID();
  // A key names one queued write. The server answers every later request under it as a repeat of the first, so a
  // second record of the key (two saves of one key overlapping, an attempt sent again, the day's note started from
  // two places with different seeds) is that write, already queued and durable. Journal replay folds rows by key
  // the same way (localDbJournal replayPut); a refusal and a removal find the one row by its key (queuedRowOf).
  if (queuedRowOf(key)) return;
  // Which entities it acts on is read once, now; readers never parse the request.
  const targets = JSON.stringify(writeTargets({ method, path, body }));
  run("INSERT INTO pending_writes (method, path, body, idem_key, targets, made_at) VALUES (?, ?, ?, ?, ?, ?)", [method, path, body ?? null, key, targets, queuedAt()]);
  // A queued write is durability-critical: while offline it is the ONLY copy of
  // the user's change (the server hasn't seen it). The 2s debounce leaves a
  // window where a crash/kill loses it, so AWAIT its durable record (M14)
  // before resolving: a journal record of the row, not a whole-database save.
  const row = qry<JournalRow>(`${PENDING_ROW} WHERE id = last_insert_rowid()`)[0];
  try { await makeDurable({ t: "pw.put", row }, { refuseWhileBackingOff: true }); }
  catch (error) {
    // Not kept (a full disk): the caller is told, and keeps the write itself (sends it, or puts it in recovery). A row
    // left here would be a second holder nobody was told of: the lane would take it for older work ahead of the
    // caller's own write, and a later snapshot could still send it after the caller reported it failed.
    run("DELETE FROM pending_writes WHERE id = ?", [row.id]);
    throw error;
  }
}

/** When the oldest queued write was queued (SQLite UTC, no zone), or null. */
async function getOldestPendingWriteAt(): Promise<string | null> {
  return qry<{ at: string | null }>("SELECT MIN(created_at) AS at FROM pending_writes WHERE rejection IS NULL")[0]?.at ?? null;
}

async function getPendingWrites(): Promise<PendingWrite[]> {
  return withTargets(qry<StoredWrite>("SELECT id, method, path, body, idem_key, attempts, targets FROM pending_writes WHERE rejection IS NULL ORDER BY COALESCE(made_at, 0) ASC, id ASC"));
}

type StoredWrite = Omit<PendingWrite, "targets"> & { targets: string | null };
/** A row queued before targets were recorded has none: writeTargets decodes it. */
function withTargets<T extends StoredWrite>(rows: T[]): Array<Omit<T, "targets"> & { targets?: WriteTarget[] }> {
  return rows.map(({ targets, ...row }) => {
    const recorded = parseStoredTargets(targets);
    return recorded ? { ...row, targets: recorded } : row;
  });
}

/** A row is found by its key when it has one: its id is only its number in this copy, and taking in another tab's
 *  snapshot can give that number to another write (each tab numbers its own rows). */
function rowOf(id: number, idemKey?: string | null): JournalRow | undefined {
  return idemKey ? queuedRowOf(idemKey) : pendingRow(id);
}
/** The queued (not refused) row of a key: one at most (addPendingWrite). */
function queuedRowOf(idemKey: string): JournalRow | undefined {
  return qry<JournalRow>(`${PENDING_ROW} WHERE idem_key = ? AND rejection IS NULL ORDER BY id LIMIT 1`, [idemKey])[0];
}

async function clearPendingWrite(id: number, idemKey?: string | null): Promise<void> {
  const row = rowOf(id, idemKey);
  if (!row) return;
  run("DELETE FROM pending_writes WHERE id = ? AND rejection IS NULL", [row.id]);
  // Sent: losing this record only replays a request the server deduplicates.
  if (getDb().getRowsModified() > 0) await makeDurable({ t: "pw.del", id: row.id, idem_key: row.idem_key }, { critical: false });
}

async function getRejectedWrites(): Promise<RejectedWrite[]> {
  return withTargets(qry<StoredWrite & { rejection: string }>("SELECT id, method, path, body, idem_key, attempts, rejection, targets FROM pending_writes WHERE rejection IS NOT NULL ORDER BY id ASC"));
}

async function storeRejectedWrite(request: Pick<PendingWrite, "method" | "path" | "body"> & { idem_key: string }, reason: string): Promise<RejectedWrite> {
  if (!request.idem_key?.trim() || !reason.trim()) throw new Error("A rejected request needs its original key and reason");
  const byKey = "SELECT id, method, path, body, idem_key, attempts FROM pending_writes WHERE idem_key=?";
  // The server refused the key: the write it names (its one queued row) goes to recovery with its text.
  const queued = qry<PendingWrite>(`${byKey} AND rejection IS NULL`, [request.idem_key])[0];
  if (queued) {
    const kept = await rejectPendingWrite(queued, reason);
    if (sameQueuedRequest(queued, { ...queued, ...request })) return kept;
    // The refused request carries other text than that row (a second record of the key kept the first row): its own
    // text is kept as well, below.
  } else {
    // Nothing of the key queued: the same request refused before is that copy; another request under it is an error.
    const matches = qry<PendingWrite>(byKey, [request.idem_key]);
    if (matches.length > 0) {
      const row = matches[0];
      if (matches.length !== 1 || !sameQueuedRequest(row, { ...row, ...request })) {
        throw new Error("The recovery key belongs to a different request");
      }
      return rejectPendingWrite(row, reason);
    }
  }
  run("INSERT INTO pending_writes(method,path,body,idem_key,rejection,targets) VALUES(?,?,?,?,?,?)",
    [request.method, request.path, request.body, request.idem_key, reason, JSON.stringify(writeTargets(request))]);
  const row = withTargets(qry<StoredWrite & { rejection: string }>("SELECT id, method, path, body, idem_key, attempts, rejection, targets FROM pending_writes WHERE id=last_insert_rowid()"))[0];
  try { await makeDurable({ t: "pw.put", row: pendingRow(row.id)! }); }
  catch (error) { run("DELETE FROM pending_writes WHERE id=?", [row.id]); throw error; }
  return row;
}

type QueuedRequest = Pick<PendingWrite, "id" | "method" | "path" | "body" | "idem_key">;
function sameQueuedRequest(row: QueuedRequest, expected: QueuedRequest): boolean {
  return (["id", "method", "path", "body", "idem_key"] as const).every(key => row[key] === expected[key]);
}

async function rejectPendingWrite(expected: PendingWrite, reason: string): Promise<RejectedWrite> {
  const id = expected.id;
  const row = qry<StoredWrite & { rejection: string | null }>("SELECT id, method, path, body, idem_key, attempts, rejection, targets FROM pending_writes WHERE id=?", [id])[0];
  if (!row || !sameQueuedRequest(row, expected) || !reason.trim()) throw new Error("The queued request changed before rejection could be preserved");
  run("UPDATE pending_writes SET rejection=? WHERE id=?", [reason, id]);
  // RPCs and exports share databaseWork, so no intervening operation can
  // observe this state or be undone while its durable save is pending.
  try { await makeDurable({ t: "pw.put", row: pendingRow(id)! }); }
  catch (error) {
    run("UPDATE pending_writes SET rejection=? WHERE id=?", [row.rejection, id]);
    throw error;
  }
  return withTargets([{ ...row, rejection: reason }])[0];
}

async function dismissRejectedWrite(expected: RejectedWrite): Promise<void> {
  const id = expected.id;
  const row = qry<StoredWrite & { rejection: string; created_at: string }>("SELECT * FROM pending_writes WHERE id=? AND rejection IS NOT NULL", [id])[0];
  if (!row) return;
  if (!sameQueuedRequest(row, expected)) throw new Error("The recovery copy changed before removal");
  run("DELETE FROM pending_writes WHERE id=? AND rejection IS NOT NULL", [id]);
  try { await makeDurable({ t: "pw.del", id, idem_key: row.idem_key }); }
  catch (error) {
    run("INSERT INTO pending_writes(id,method,path,body,idem_key,attempts,rejection,created_at,targets) VALUES(?,?,?,?,?,?,?,?,?)",
      [row.id,row.method,row.path,row.body,row.idem_key,row.attempts,row.rejection,row.created_at,row.targets]);
    throw error;
  }
}

// Count transient failures so replay can warn without deleting queued work.
async function bumpPendingWriteAttempt(id: number, idemKey?: string | null): Promise<number> {
  const at = rowOf(id, idemKey)?.id;
  if (at === undefined) return 0;
  run("UPDATE pending_writes SET attempts = attempts + 1 WHERE id = ?", [at]);
  scheduleSave();
  const rows = qry<{ attempts: number }>("SELECT attempts FROM pending_writes WHERE id = ?", [at]);
  return rows[0]?.attempts ?? 0;
}

type SearchHit = { id: string; snippet: Snippet | null };

/** Notes whose text boxes (page_text) hold every term, after the notes found by
 *  title or body. The stored value is JSON, so a LIKE only narrows the rows;
 *  the terms must occur in the boxes' own text (not in the format's key names). */
function pageTextHits(terms: readonly string[]): SearchHit[] {
  const likes = terms.slice(0, 16).map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const rows = qry<{ node_id: string; value: string }>(
    `SELECT a.node_id, a.value FROM node_attributes a JOIN nodes n ON n.id = a.node_id
      WHERE a.key = 'page_text' AND ${likes.map(() => "a.value LIKE ? ESCAPE '\\'").join(" AND ")} LIMIT 200`,
    likes,
  );
  const hits: SearchHit[] = [];
  for (const row of rows) {
    const text = pageTextPlain(row.value);
    const lower = text.toLowerCase();
    if (terms.every((term) => lower.includes(term.toLowerCase()))) hits.push({ id: row.node_id, snippet: snippetAround(text, terms) });
  }
  return hits;
}

/** The text is stored as written, so a title typed with a combining accent (NFD) and one typed
 *  as a single character (NFC) only match each other when the query is tried in both forms.
 *  Most queries have one form (ASCII, CJK) and run once. */
async function searchNodes(query: string): Promise<SearchHit[]> {
  const forms = [...new Set([query, query.normalize("NFC"), query.normalize("NFD")])];
  if (forms.length === 1) return searchOneForm(query);
  const merged = new Map<string, SearchHit>();
  for (const form of forms) for (const hit of await searchOneForm(form)) if (merged.size < 50 && !merged.has(hit.id)) merged.set(hit.id, hit);
  return [...merged.values()];
}

async function searchOneForm(query: string): Promise<SearchHit[]> {
  const found = await searchTitlesAndBodies(query);
  const q = query.trim();
  if (!q) return found;
  const seen = new Set(found.map((hit) => hit.id));
  const terms = queryTerms(q);
  const more = pageTextHits(terms.length ? terms : [q]).filter((hit) => !seen.has(hit.id));
  return more.length === 0 ? found : [...found, ...more].slice(0, 50);
}

async function searchTitlesAndBodies(query: string): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  // Snippets are the server's contract (D76): plain text + highlight ranges
  // from the shared snippetAround, never FTS5 snippet() markup (which quoted
  // raw markdown and let a note's own `<mark>` text highlight itself).
  const terms = queryTerms(q);
  const withSnippet = (rows: Array<{ id: string; markdown: string | null }>) =>
    rows.map((r) => ({ id: r.id, snippet: r.markdown ? snippetAround(r.markdown, terms) : null }));
  // A title equal to the typed text, then one starting with it, come before
  // the FTS rank: typing a note's exact name finds it first however often
  // other notes repeat the word. (substr, not LIKE: the text may hold % or _.)
  const titleFirst = `(lower(title) = lower(?)) DESC, (substr(lower(title), 1, length(?)) = lower(?)) DESC`;
  // P0 instant-as-you-type: PREFIX-match each token (append * to a quoted token)
  // and lower the threshold to 2 chars, so "comp" ranks "computer" via the FTS
  // index instead of waiting for the slow LIKE %substring% fallback. Quoting
  // (with "" escaping) neutralises FTS5 operator chars so arbitrary input never
  // throws a syntax error. The LIKE fallback below still covers 1-char and any
  // FTS miss.
  if (q.length >= 2) {
    const ftsQuery = q.split(/\s+/).filter(Boolean)
      .map((tok) => `"${tok.replace(/"/g, '""')}"*`).join(" ");
    try {
      const results = qry<{ id: string; markdown: string | null }>(
        `SELECT id, markdown FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY ${titleFirst}, rank LIMIT 50`,
        [ftsQuery, q, q, q]
      );
      if (results.length > 0) return withSnippet(results);
    } catch { /* FTS is best-effort; ignore when the virtual table is unavailable */ }
  }
  // Every term must occur (title or body), as on the server: "kafka streams"
  // finds a note with both words apart, not only the exact phrase.
  const words = (terms.length ? terms : [q]).slice(0, 16);
  const likes = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const rows = qry<{ id: string; markdown: string | null }>(
    `SELECT id, markdown FROM nodes WHERE ${likes.map(() => "(title LIKE ? ESCAPE '\\' OR markdown LIKE ? ESCAPE '\\')").join(" AND ")} ORDER BY ${titleFirst} LIMIT 50`,
    [...likes.flatMap((like) => [like, like]), q, q, q]
  );
  return withSnippet(rows);
}

// The export returns the raw bytes; the main-thread shim wraps them in a File
// (a File can't be constructed off-window in every runtime, and the bytes are
// what's cheap to transfer back).
async function exportDatabase(): Promise<ArrayBuffer> {
  const data = getDb().export();
  return data.buffer as ArrayBuffer;
}

// Owner metadata travels with exports. Reject legacy/unowned web imports and
// other accounts even when they share a workspace; queued writes belong to the
// account that authored them. This is a local guard, not a signed identity.
function verifySnapshotOwner(candidate: Database): void {
  const exists = candidate.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='local_account'")[0]?.values.length;
  const owners = exists ? candidate.exec("SELECT scope FROM local_account")[0]?.values ?? [] : [];
  if (storageScope === null ? owners.length !== 0 : owners.length !== 1 || owners[0][0] !== storageScope) {
    throw new LocalDbError("backup_foreign_account", "The backup must belong to the current account and server");
  }
}

async function importDatabase(data: ArrayBuffer): Promise<void> {
  const S = await getSql();
  const imported = new S.Database(new Uint8Array(data));
  let applied: JournalApplied = {};
  try {
    // Migrations can create missing tables, so validate identity first. A
    // random SQLite file must not become an empty, apparently valid vault.
    const tables = imported.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0]?.values.flat() ?? [];
    if (!tables.includes("workspace") || !tables.includes("nodes")) throw new Error("Not an Onden local backup");
    if (imported.exec("PRAGMA quick_check")[0]?.values[0]?.[0] !== "ok") throw new Error("Damaged local backup");
    const workspaces = imported.exec("SELECT id FROM workspace")[0]?.values ?? [];
    const currentWorkspace = getDb().exec("SELECT id FROM workspace LIMIT 1")[0]?.values[0]?.[0];
    if (workspaces.length !== 1 || (currentWorkspace && workspaces[0][0] !== currentWorkspace)) {
      throw new Error("The backup must belong to the current workspace");
    }
    verifySnapshotOwner(imported);
    prepareLocalDatabase(imported);
    // The backup replaces the queue too: every journal record so far, of any
    // session, must not replay onto it.
    applied = await everyJournalRecord();
    stampJournalApplied(imported, applied);
    // Keep both the active instance and its disk snapshot intact on failure.
    // The successful IDB transaction is the replacement's commit point.
    await writeTail;
    await idbSave(imported.export().buffer as ArrayBuffer, storageScope!, { replace: true });
  }
  catch (error) { imported.close(); throw error; }
  const previous = db;
  db = imported;
  previous?.close();
  persist.cancel();
  compact.cancel();
  journalApplied = applied;
  journalRecordsSinceSnapshot = 0;
  await dropJournalUpTo(applied);
}

/** This session's records and every other session's in the journal. */
async function everyJournalRecord(): Promise<JournalApplied> {
  return mergeApplied(journalOn ? latestBySession(await journalRead(journalKey())) : {}, appliedNow());
}

/** Access revoked (lib/accessRevoked.ts): drop every row this account holds
 *  for the workspace — content, structure, queued and rejected writes, sync
 *  cursors — so nothing from it stays readable on this device. */
async function wipeWorkspaceMirror(): Promise<void> {
  for (const table of ["workspace", "nodes", "edges", "tasks", "canvases", "pointers", "suggestions",
    "node_attributes", "canvas_memberships", "graph_positions", "note_anchors", "note_link_bindings", "pending_writes", "sync_state"]) {
    run(`DELETE FROM ${table}`);
  }
  try { run("DELETE FROM nodes_fts"); } catch { /* FTS is best-effort; ignore when the virtual table is unavailable */ }
  // Queued writes in the journal are this workspace's too: none may replay.
  try { journalApplied = await everyJournalRecord(); }
  catch (error) { console.warn("[onden] local journal read failed while wiping", error); }
  await saveSnapshot(true);
  if (journalOn) await journalClear(journalKey());
}

// ── RPC dispatch ───────────────────────────────────────────────────────────
// The dispatch table maps the op name (= the public function name in
// localDb.ts) to its implementation. Args arrive as a tuple; the result (or a
// serialised error) is posted back keyed by the request id.
const ensureReady = createInitializationGate(initLocalDb);
const ops = {
  initLocalDb: ensureReady,
  loadBootstrap,
  loadBootstrapList,
  loadBootstrapRelations,
  loadAttributePage,
  persistBootstrap,
  persistRemoteNode,
  missingBodyIds,
  storeDownloadedBodies,
  getStoredBody,
  forgetBody,
  heldNotesNowSent,
  applySync,
  raiseWatermark,
  rewindCursor,
  getWatermark,
  forgetCopyWatermark,
  upsertAttribute,
  removeAttribute,
  getNodeAttribute,
  getNodeAttributeRecord,
  setLastEventId,
  getLastEventId,
  setMembershipEpoch,
  getMembershipEpoch,
  loadSpaces,
  storeSpaces,
  getLastFullRefresh,
  fillNodeAttributes,
  fillAttributeRows,
  planDrawings,
  replaceStaleAttributeRows,
  getAllNodeIds,
  getAllMembershipIds,
  upsertNode,
  removeNode,
  upsertEdge,
  removeEdge,
  upsertTask,
  upsertWorkspace,
  removeTask,
  upsertCanvas,
  removeCanvas,
  loadCanvases,
  loadCanvas,
  putCanvasMemberships,
  putGraphPosition,
  addPendingWrite,
  getPendingWrites,
  getOldestPendingWriteAt,
  clearPendingWrite,
  rejectPendingWrite,
  storeRejectedWrite,
  getRejectedWrites,
  dismissRejectedWrite,
  bumpPendingWriteAttempt,
  searchNodes,
  exportDatabase,
  importDatabase,
  flushLocalDbSync,
  retrySnapshotSave,
  catchUpWithOtherTabs,
  wipeWorkspaceMirror,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as Record<string, (...args: any[]) => Promise<unknown>>;

export type LocalDbRequest = { id: number; op: string; args: unknown[]; storageScope: string | null; adoptLegacy?: boolean; /** A temporary session: keep nothing (see memoryOnly). */ temporary?: boolean };
export type LocalDbResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code?: LocalDbErrorCode };

self.onmessage = (ev: MessageEvent<LocalDbRequest>) => {
  void enqueueDatabaseWork(async () => {
    const { id, op, args } = ev.data;
    const fn = ops[op];
    if (!fn) {
      const res: LocalDbResponse = { id, ok: false, error: `Unknown localDb op: ${op}` };
      self.postMessage(res);
      return;
    }
    try {
      const incoming = ev.data.storageScope;
      if (incoming !== null && (typeof incoming !== "string" || !incoming)) throw new Error("Missing local storage account");
      if (storageScope === undefined) {
        storageScope = incoming; adoptLegacy = ev.data.adoptLegacy === true;
        if (ev.data.temporary === true) { memoryOnly = true; journalOn = false; adoptLegacy = false; }
      }
      if (storageScope !== incoming) throw new Error("Local storage account changed; reload the page");
      await ensureReady();
      if (newerCopySeen) throw new LocalDbError("local_copy_too_new", "The local copy was written by a newer version");
      const result = await fn(...args);
      const res: LocalDbResponse = { id, ok: true, result };
      self.postMessage(res);
    } catch (e) {
      const res: LocalDbResponse = { id, ok: false, error: e instanceof Error ? e.message : String(e), code: e instanceof LocalDbError ? e.code : undefined };
      self.postMessage(res);
    }
  });
};
