// The browser app's backend: the same Hono app and PGlite, in a Web Worker.
// Entry of the worker bundle (scripts/build-browser.mjs). Design: docs/architecture/browser-app.md.
//
//   page ──postMessage──▶ this worker ──▶ queue ──▶ app.fetch(request) ──▶ PGlite (memory)
//                                                                    └──▶ saveLoop ──▶ OPFS / IndexedDB
//
// env.ts and hostSetup.ts first: they set what db.ts, config.ts and requestContext.ts read at import time.
import "./env.js";
import { workerQueue as queue } from "./hostSetup.js";
import type { BridgeRequest, FromWorker, ToWorker } from "@onden/markdown";
import { DEVICE_FILE_EMPTY_PARAM, DEVICE_FILE_PATH } from "@onden/markdown/contract";
import { BROWSER_APP_CLEAR_SAMPLES_PATH, BROWSER_APP_STATE_PATH, BROWSER_APP_TEMP_PARAM, BROWSER_APP_LANG_PARAM, TEMP_SESSION_MEDIA_LIMIT_BYTES } from "@onden/markdown";
import { app } from "../app.js";
import { auth } from "../auth.js";
import { getWorkspaceId, migrate, pglite, pool, useDatabaseSnapshot } from "../db.js";
import { listMigrations } from "../dbMigrations.js";
import { loadWorkspaceClock, startWorkspaceClockReload } from "../services/workspaceTime.js";
import { MODULES, backfillModuleImports, startModuleBackground } from "../modules/index.js";
import { indexMissingNoteLinks } from "../services/wikilinkEdges.js";
import { startDispatcherCatchup } from "../services/dispatcherQueue.js";
import { log } from "../logger.js";
import { createLocalSession } from "./localSession.js";
import { unavailableInBrowserApp } from "./unavailable.js";
import { openSnapshotStore, type SnapshotStore } from "./snapshotStore.js";
import { isJournaled, MAX_BODY_BYTES, openJournal, type Journal } from "./journal.js";
import { bootFailure, bootFailureKind, judgeSchema } from "./schemaCheck.js";
import { copyIsStored, createSaveLoop, type SaveLoop } from "./saveLoop.js";
import { useMediaFiles, type MediaFiles } from "../services/mediaFiles.js";
import { useImageCodec } from "../services/imageCodec.js";
import { canvasImageCodec } from "./imageCodec.js";
import { memoryMediaFiles, openMediaFiles } from "./mediaStorage.js";
import { startTemporarySession } from "./temporarySession.js";
import { ensureOwnNodeId, ownNodeFingerprint } from "./nodeIdentity.js";
import { clearSampleNotes, sampleNoteCount, sampleNotesState, seedSampleNotes, welcomeNoteId } from "./sampleNotes.js";

const post = (message: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);

type Running = {
  session: ReturnType<typeof createLocalSession>;
  saveLoop: SaveLoop;
  store: SnapshotStore;
  media: { files: MediaFiles; kind: SnapshotStore["kind"] };
  journal: Journal | undefined;
  /** The last logged write that has finished running; a copy made now contains everything up to it (snapshotStore CopyMeta). */
  progress: { executed: number; skipped: number };
  /** `?temp=1`: nothing of this session is kept (see the top of the file). */
  temporary: boolean;
};

// Opened once and kept outside boot(): "download the old data" and "start over" must work when boot() failed.
const workerParams = new URL(self.location.href).searchParams;
const forceIndexedDb = workerParams.get("store") === "indexeddb";
// A temporary session keeps nothing in this browser and touches nothing an ordinary session keeps: no saved copy (the
// "none" store never looks at OPFS or IndexedDB), no journal, files in memory only.
const temporary = workerParams.get(BROWSER_APP_TEMP_PARAM) === "1";
// `?empty=1`: this page is opened to take a file from another device. A first open then makes no sample notes (a copy with
// notes of its own is refused by services/stampedJoin.ts) and saves its empty copy at once, so a page that is killed
// half way reopens as that empty copy and not as a first open.
const startEmpty = workerParams.get(DEVICE_FILE_EMPTY_PARAM) === "1" && !temporary;
const storeReady = openSnapshotStore(temporary ? "none" : forceIndexedDb ? "indexeddb" : undefined);
// Uploaded files live in the same kind of place as the saved copy (mediaStorage.ts); the backend reaches them only
// through services/mediaFiles.ts, which boot() points at this.
const mediaReady = temporary
  ? Promise.resolve({ files: memoryMediaFiles(TEMP_SESSION_MEDIA_LIMIT_BYTES), kind: "none" as SnapshotStore["kind"] })
  : storeReady.then((store) => openMediaFiles(store.kind));
let journalReady: Promise<Journal | undefined> | undefined;
const journalOnce = () => (journalReady ??= temporary ? Promise.resolve(undefined) : openJournal().catch(() => undefined));

/** The packaged, already-migrated database (scripts/build-browser.mjs): a first open starts from it
 *  instead of running every migration in the browser. */
async function packagedSnapshot(): Promise<Blob> {
  const response = await fetch(new URL("./snapshot.tar.gz", import.meta.url));
  if (!response.ok) throw new Error(`the packaged database could not be loaded (${response.status})`);
  return response.blob();
}

async function boot() {
  const t0 = performance.now();
  // `worker.js?store=indexeddb` (the page passes its own ?store=indexeddb on) is the test hook for the IndexedDB path.
  const store = await storeReady;
  // A copy that cannot be read is never replaced by the packaged one behind the person's back: boot fails and
  // the page offers 「重新開始」 (reset) explicitly.
  const saved = await store.read();
  const firstOpen = saved === undefined;
  useDatabaseSnapshot(async () => saved?.blob ?? packagedSnapshot());

  // Is this copy one this build can open? A copy newer than the app is refused before anything is changed; an older
  // one is brought up to date in memory, and only after that works is it saved over (the old copy stays until then).
  const bundled = (await listMigrations()).map((m) => m.version);
  const applied = await appliedMigrations();
  const verdict = judgeSchema(applied, bundled);
  if (verdict.kind === "newer") throw bootFailure("newer-copy", "the saved copy was made by a newer version of the app");
  try {
    await migrate({ seedNativeActor: false });
  } catch (error) {
    log.warn("browser", `upgrading the saved copy failed: ${String(error)}`);
    throw bootFailure("upgrade-failed", "the saved copy could not be brought up to date");
  }
  const upgraded = verdict.kind === "upgrade" && applied.length > 0 ? verdict.pending.length : 0;
  const schema = bundled[bundled.length - 1] ?? "";
  // Before this boot's first write: a copy is its own node (the packaged database carries no node id).
  const ownNodeIdMade = await ensureOwnNodeId();
  const workspaceId = await getWorkspaceId();
  await loadWorkspaceClock(workspaceId);
  await (await auth.$context).runMigrations();
  await backfillModuleImports();

  const media = await mediaReady;
  useMediaFiles(media.files);
  useImageCodec(canvasImageCodec);
  await media.files.sweepIncomplete();

  const session = createLocalSession(app, auth.api as never);
  await session.signIn();

  const journal = await journalOnce();
  const startSeq = saved?.meta.journalSeq ?? 0;
  journal?.startAfter(startSeq);
  const progress = { executed: startSeq, skipped: 0 };

  const database = await pglite!.database();
  const saveLoop = createSaveLoop({
    queue,
    store,
    // Through the pool's own lock: a copy is never made while some transaction still holds the connection.
    copy: async (format) => {
      const held = await pglite!.connect();
      try { return (await database.dumpDataDir(format)) as Blob; } finally { held.release(); }
    },
    writeMark: async () => (await pglite!.query("SELECT txid_snapshot_xmax(txid_current_snapshot())::text AS mark")).rows[0].mark as string,
    report: (state) => post({ t: "save-state", state }),
    meta: () => ({ journalSeq: progress.executed, schema }),
    onDurable: (meta) => journal?.trimThrough(meta.journalSeq),
  });
  saveLoop.setJournal({ journal: journal !== undefined });

  let seeded = await sampleNotesState();
  let welcome: string | null = null;
  if (temporary) {
    welcome = await startTemporarySession((request) => session.fetchAsLocalUser(request), session.origin, workerParams.get(BROWSER_APP_LANG_PARAM) ?? "");
  } else if (firstOpen && !seeded && !startEmpty) {
    await seedSampleNotes((request) => session.fetchAsLocalUser(request), session.origin);
    seeded = true;
    welcome = await welcomeNoteId();
  }

  // Writes the last page logged but never got into a copy (it was closed or reloaded right after an edit).
  const report = { upgraded, recovered: 0, recoveryFailed: 0 };
  const logged = journal ? await journal.after(startSeq) : [];
  // The opening screen says how far this is: a long log takes long (every entry is a whole request, saveLoop.ts MAX_UNSAVED_CHANGES).
  let replayed = 0;
  const say = () => post({ t: "replay-progress", done: replayed, total: logged.length });
  if (logged.length) say();
  let saidAt = performance.now();
  for (const entry of logged) {
    await queue.run(async () => {
      try {
        const response = await session.fetchAsLocalUser(toRequest(entry, session.origin), entry.body?.byteLength);
        await response.arrayBuffer();
        // A 4xx now is what it was then (a refused edit); only a server-side failure means a change was lost.
        if (response.ok) report.recovered++; else if (response.status >= 500) report.recoveryFailed++;
      } catch (error) {
        log.warn("browser", `replaying a logged change failed: ${String(error)}`);
        report.recoveryFailed++;
      }
      progress.executed = entry.seq;
      await saveLoop.afterJob();
    });
    replayed++;
    if (performance.now() - saidAt > 250 || replayed === logged.length) { say(); saidAt = performance.now(); }
  }

  // Background work is limited to what makes sense with the page open and no network:
  // the day rolling over, recurring tasks, cascades a closed tab interrupted, note links.
  startWorkspaceClockReload(workspaceId);
  startDispatcherCatchup();
  // The tasks module's own loop (recurring tasks roll forward); the RSS and reminder loops need a server and are not started.
  startModuleBackground(MODULES.filter((module) => module.id === "tasks"));
  void queue.run(() => indexMissingNoteLinks()).catch((err) => log.warn("wikilink", `note link index backfill failed: ${String(err)}`));

  // Learn the write mark; on a first open the sample notes are in no copy yet, so one is due.
  await queue.run(async () => { await saveLoop.afterJob(); });
  // A first open, an upgrade and a recovery each leave something that is in no copy yet: save it before the page starts.
  if (firstOpen || ownNodeIdMade || upgraded > 0 || report.recovered + report.recoveryFailed > 0) {
    saveLoop.markUnsaved();
    if (upgraded > 0 || report.recovered > 0 || startEmpty) await saveLoop.flush();
  }
  log.info("browser", `ready in ${Math.round(performance.now() - t0)} ms (${firstOpen ? "first open" : "saved copy"})`);
  return { session, saveLoop, store, media, journal, progress, firstOpen, seeded, welcome, report, temporary };
}

/** The migrations the saved copy has (empty for a new database or one without the table). */
async function appliedMigrations(): Promise<string[]> {
  try {
    return (await pool.query("SELECT version FROM schema_migrations")).rows.map((row: { version: string }) => row.version);
  } catch {
    return [];
  }
}

const bootMs0 = performance.now();
const ready = boot();
ready.then(
  (running) => {
    post({ t: "ready", firstOpen: running.firstOpen, bootMs: Math.round(performance.now() - bootMs0), store: running.store.kind, seeded: running.seeded, temporary: running.temporary, welcomeNoteId: running.welcome, ...running.report });
    post({ t: "save-state", state: running.saveLoop.state() });
  },
  (error) => post({ t: "boot-failed", kind: bootFailureKind(error), message: error instanceof Error ? error.message : String(error) }),
);

const RESTORE_APPLY = /^\/api\/backup\/restore\/[^/]+\/apply$/;
const RESTORE_WAIT_MS = 10 * 60_000;

/** The job a "restore started" answer names. Read before the answer's bytes are handed to the page: a transferred
 *  buffer is empty here afterwards, and a restore nobody waits for is saved only by luck (2026-11-02). */
function restoreJobOf(started: ArrayBuffer): string | undefined {
  try {
    return (JSON.parse(new TextDecoder().decode(started)) as { job?: { id?: string } }).job?.id;
  } catch {
    log.warn("browser", "a restore answer named no job; its end is not waited for");
    return undefined;
  }
}

async function waitForRestore(jobId: string): Promise<void> {
  const giveUpAt = Date.now() + RESTORE_WAIT_MS;
  // Read the job's row directly: a request made through the app would put its own context on the (single, shared) stack
  // while the job is in the middle of a transaction.
  while (Date.now() < giveUpAt) {
    const { rows } = await pool.query("SELECT status FROM backup_restore_jobs WHERE id = $1", [jobId]);
    if (rows[0]?.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const readers = new Map<number, ReadableStreamDefaultReader<Uint8Array>>();

function toRequest(message: Pick<BridgeRequest, "method" | "path" | "headers" | "body">, origin: string): Request {
  const method = message.method.toUpperCase();
  return new Request(new URL(message.path, origin).href, {
    method,
    headers: message.headers,
    ...(method === "GET" || method === "HEAD" || message.body === null ? {} : { body: message.body }),
  });
}

const respond = (id: number, status: number, body: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer;
  post({ t: "head", id, status, statusText: "", headers: [["content-type", "application/json"]] });
  post({ t: "chunk", id, data: bytes }, [bytes]);
  post({ t: "end", id });
};

async function answer(running: Running, message: BridgeRequest): Promise<void> {
  const { id } = message;
  const path = message.path.split("?")[0];
  // The person is always signed in here; signing out would only lock them out of their own notes.
  if (path === "/api/auth/sign-out") return respond(id, 200, { success: true });
  if (path === BROWSER_APP_STATE_PATH) {
    // `?node=1`: also say a one-way name of this copy's node id (hashed on each ask, so only the tests that compare two copies ask).
    const withNode = new URL(message.path, "http://localhost").searchParams.get("node") === "1";
    const usage = await running.media.files.usage().catch(() => ({ files: 0, bytes: 0 }));
    return respond(id, 200, { ...running.saveLoop.state(), sampleNotes: await queue.run(() => sampleNoteCount()), ownNode: withNode ? await queue.run(() => ownNodeFingerprint()) : null, media: { ...usage, store: running.media.kind }, temporary: running.temporary });
  }
  if (path === BROWSER_APP_CLEAR_SAMPLES_PATH) {
    const cleared = await queue.run(async () => {
      const n = await clearSampleNotes((request) => running.session.fetchAsLocalUser(request), running.session.origin);
      await running.saveLoop.afterJob();
      return n;
    });
    return respond(id, 200, { cleared });
  }

  const refused = unavailableInBrowserApp(message.method, path);
  if (refused) return respond(id, 501, { error: "browser_app_unavailable", detail: `${refused.feature} is not in the browser app` });

  let streaming: Response | null = null;
  await queue.run(async () => {
    // Write ahead: the change is in the journal before the backend runs it, and so before the page is told it is saved.
    let logged = 0;
    if (running.journal && isJournaled(message.method, path)) {
      if (message.body && message.body.byteLength > MAX_BODY_BYTES) running.progress.skipped++;
      else logged = await running.journal.append({ method: message.method, path: message.path, headers: message.headers, body: message.body }).catch(() => { running.progress.skipped++; return 0; });
      running.saveLoop.setJournal({ journalSkipped: running.progress.skipped });
    }
    try {
    let response = await running.session.fetchAsLocalUser(toRequest(message, running.session.origin), message.body?.byteLength);
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      // The session expired while the tab stayed open: sign in again and repeat the request once.
      await running.session.signIn();
      response = await running.session.fetchAsLocalUser(toRequest(message, running.session.origin), message.body?.byteLength);
    }
    const headers = [...response.headers.entries()];
    if (response.headers.get("content-type")?.startsWith("text/event-stream") && response.body) {
      // A stream stays open for the life of the page: read it outside the queue (it only relays in-memory ticks).
      post({ t: "head", id, status: response.status, statusText: response.statusText, headers });
      streaming = response;
      return;
    }
    if (response.headers.get("content-type")?.startsWith("application/x-ndjson") && response.body) {
      // The file for another device (GET /api/snapshot) can be hundreds of MB: relayed a piece at a time while the queue is held
      // (it reads the database as it goes), never gathered here. The page writes it to a file as it arrives.
      post({ t: "head", id, status: response.status, statusText: response.statusText, headers });
      const reader = response.body.getReader();
      readers.set(id, reader);
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const piece = value.slice().buffer;
          post({ t: "chunk", id, data: piece }, [piece]);
        }
        post({ t: "end", id });
      } catch {
        post({ t: "failed", id, message: "the file could not be made" });
      } finally {
        readers.delete(id);
      }
      return;
    }
    const data = await response.arrayBuffer();
    const status = response.status;
    // Before the page hears the answer: once it has, "unsaved" must already be true, or a page that closes right
    // after its last edit would see "everything is saved" for a change that is only in memory.
    if (message.method.toUpperCase() !== "GET" && message.method.toUpperCase() !== "HEAD") await running.saveLoop.afterJob();
    const restoreJob = RESTORE_APPLY.test(path) && message.method.toUpperCase() === "POST" && status === 202 ? restoreJobOf(data) : undefined;
    post({ t: "head", id, status, statusText: response.statusText, headers });
    if (data.byteLength) post({ t: "chunk", id, data }, [data]);
    post({ t: "end", id });
      // A restore keeps working after it answered "started" (services/backupRestoreJobs.ts runs it on its own).
      // The browser app runs one thing at a time, so the queue is held until it is done: a request in the middle of
      // its batches would share its transaction. The page's progress polls wait behind it and are answered at the end.
      if (restoreJob) {
        await waitForRestore(restoreJob);
        await running.saveLoop.afterJob();
        // The restore's steps are not in the journal: until a copy holds the result, closing the page right now would lose
        // it. The page's progress poll waits behind this job, so it hears "done" only when the browser has the notes.
        await running.saveLoop.flushInJob();
      }
    } finally {
      if (logged) running.progress.executed = logged;
    }
  });

  const stream = streaming as Response | null;
  if (stream?.body) {
    const reader = stream.body.getReader();
    readers.set(id, reader);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const data = value.slice().buffer;
        post({ t: "chunk", id, data }, [data]);
      }
      post({ t: "end", id });
    } catch {
      post({ t: "end", id });
    } finally {
      readers.delete(id);
    }
  }
}

/** Take the file another device made into this copy: POST /api/snapshot with the file read as a stream (a piece at a time; the
 *  bridge's ordinary request would gather the whole body first). Holds the queue until it ends, so nothing else writes during it
 *  (the backend refuses ordinary writes meanwhile too: workspace_joining). A taken file is saved to the browser's storage before
 *  "done" is said; a refused or cut-off one leaves the empty copy the backend guarantees. */
async function joinFile(running: Running, id: number, file: Blob): Promise<void> {
  let readBytes = 0;
  let saidAt = 0;
  const counted = file.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(piece, controller) {
      readBytes += piece.byteLength;
      controller.enqueue(piece);
      if (performance.now() - saidAt > 200) { saidAt = performance.now(); post({ t: "join-progress", id, readBytes, totalBytes: file.size }); }
    },
    flush() { post({ t: "join-progress", id, readBytes: file.size, totalBytes: file.size }); },
  }));
  let result: FromWorker = { t: "join-result", id, ok: false, status: 0, error: null, detail: null };
  await queue.run(async () => {
    try {
      const request = new Request(new URL(DEVICE_FILE_PATH, running.session.origin).href, {
        method: "POST", headers: { "content-type": "application/x-ndjson" }, body: counted, duplex: "half",
      } as RequestInit);
      const response = await running.session.fetchAsLocalUser(request);
      const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: string; pages?: number; rows?: number };
      if (response.ok) {
        await running.saveLoop.afterJob();
        await running.saveLoop.flushInJob();
        // The notes are in memory only if the browser did not store the copy (full, blocked, or no storage at all: store "none"
        // never writes and never says "failed"): that is not "brought over". Only a copy that was written counts.
        // The page starts again from what is stored, which is the empty copy.
        result = !copyIsStored(running.saveLoop.state())
          ? { t: "join-result", id, ok: false, status: 507, error: "join_not_kept", detail: null }
          : { t: "join-result", id, ok: true, pages: body.pages ?? 0, rows: body.rows ?? 0 };
      } else {
        await running.saveLoop.afterJob();
        result = { t: "join-result", id, ok: false, status: response.status, error: body.error ?? null, detail: body.detail ?? null };
      }
    } catch (error) {
      log.warn("browser", `taking in a file failed: ${String(error)}`);
    }
  });
  post(result);
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.t === "cancel") { void readers.get(message.id)?.cancel().catch(() => {}); return; }
  // These two work when the start failed too: they are how a person gets out of "the saved copy cannot be opened".
  if (message.t === "export-copy") {
    const saved = await (await storeReady).read().catch(() => undefined);
    const data = saved ? await saved.blob.arrayBuffer() : null;
    post({ t: "copy", id: message.id, data }, data ? [data] : []);
    return;
  }
  if (message.t === "reset") {
    // No copy may land after the erase below: stop the save loop first (a save in flight finishes before it).
    // A start that failed has no loop: nothing is writing.
    await (await ready.catch(() => undefined))?.saveLoop.stop();
    await (await storeReady).clear();
    await (await journalOnce())?.clear().catch(() => {});
    await (await mediaReady).files.clear().catch(() => {});
    post({ t: "done", id: message.id });
    return;
  }
  let running: Awaited<typeof ready>;
  try { running = await ready; } catch { return; }
  if (message.t === "request") {
    answer(running, message).catch((error) => post({ t: "failed", id: message.id, message: error instanceof Error ? error.message : String(error) }));
  } else if (message.t === "join-file") {
    void joinFile(running, message.id, message.file);
  } else if (message.t === "flush") {
    await running.saveLoop.flush();
    post({ t: "done", id: message.id });
  }
};
