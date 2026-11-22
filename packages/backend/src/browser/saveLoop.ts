// When the worker writes a copy of the database to its store, and what that costs the person.
//
// The database lives in memory; a copy is written (1) shortly after the last change, (2) at the latest
// MAX_UNSAVED_MS after the first change not yet in a copy, (3) as soon as MAX_UNSAVED_CHANGES changes are not in one,
// (4) when the page is hidden or closing.
// So a closed tab loses nothing, and a killed one (a phone that drops the page in the background, a crash)
// loses at most the changes of the last MAX_UNSAVED_MS plus the time one copy takes to write
// (docs/architecture/browser-app.md §4). A copy is the whole database, so the page waits for it on a big one.
//
// Every save made by a timer or by the count limit goes AHEAD of the requests still waiting in the queue (`runNext`):
// at the back of the queue it would wait for all of them, and a page that keeps 300 requests outstanding saw no copy at all
// for 80 s (2026-11-12). Only the request already running is waited for.

import type { BridgeSaveState } from "@onden/markdown";
import type { SerialQueue } from "./queue.js";
import type { CopyMeta, SnapshotStore } from "./snapshotStore.js";

export const IDLE_BEFORE_SAVE_MS = 500;
export const MAX_UNSAVED_MS = 10_000;
/** Also bounds the write-ahead log: a reopen replays at most this many entries (about 0.1–0.4 s each, journal.ts). */
export const MAX_UNSAVED_CHANGES = 100;

export type SaveLoopDeps = {
  queue: SerialQueue;
  store: SnapshotStore;
  /** A copy of the whole database, in the format the store wants. Runs inside the queue. */
  copy: (format: SnapshotStore["copyFormat"]) => Promise<Blob>;
  /** Changes whenever a transaction wrote something (txid_snapshot_xmax). Runs inside the queue. */
  writeMark: () => Promise<string>;
  report: (state: BridgeSaveState) => void;
  /** What the copy about to be made will say about itself (the last logged write that has finished running, the schema).
   *  Runs inside the same queue job as the copy, so nothing is half-in. */
  meta: () => CopyMeta;
  /** A copy with this `meta` is durable: whatever it covers no longer needs to be kept elsewhere (the journal trims). */
  onDurable?: (meta: CopyMeta) => void | Promise<void>;
};

export type SaveLoop = {
  /** Call at the end of a queued job that may have written. */
  afterJob(): Promise<void>;
  /** The database holds something the store does not (a first open: the sample notes), whatever the write mark says. */
  markUnsaved(): void;
  /** Save now if anything is unsaved (page hidden or closing). */
  flush(): Promise<void>;
  /** The same, for a caller that is ALREADY running inside a queue job (queue.run would wait for itself): the copy is made
   *  in that job and this resolves once the store has it. A restore ends with this, so "done" is said only when the
   *  restored notes are in the browser's storage and not in memory alone. */
  flushInJob(): Promise<void>;
  state(): BridgeSaveState;
  /** The journal's part of the state (it is not the loop's business, but the page reads one object). */
  setJournal(update: Partial<Pick<BridgeSaveState, "journal" | "journalSkipped">>): void;
  /** Never write a copy again, and wait for the one being written to finish. "Start over" calls this before it erases
   *  the store: a copy that finished after the erase would put the old notes back (or leave a pointer to a file that is gone). */
  stop(): Promise<void>;
};

/** Whether the copy is really in the browser's storage now: written without failing and nothing changed since. A store of kind "none" (a private window, no
 *  usable storage) never writes and never says "failed", so "not failed" alone would call a copy kept that is gone at the next load. */
export function copyIsStored(state: BridgeSaveState): boolean {
  return state.store !== "none" && !state.failed && !state.unsaved && state.lastSavedAt !== null;
}

export function createSaveLoop(deps: SaveLoopDeps): SaveLoop {
  const state: BridgeSaveState = { store: deps.store.kind, lastSavedAt: null, lastCopyMs: null, lastCopyBytes: null, unsaved: false, changes: 0, failed: false, journal: false, journalSkipped: 0 };
  let lastMark: string | null = null;
  let firstUnsavedAt = 0;
  /** Counts changes seen; a copy covers the changes up to the count it was made at. */
  let changes = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> = Promise.resolve();
  let stopped = false;
  /** `changes` as of the last copy the store holds. */
  let savedChanges = 0;
  /** `changes` as of the last copy that was tried, written or not: a store that refuses (it is full) is asked again a moment after
   *  the next change and after another MAX_UNSAVED_CHANGES changes, not after every single change (a copy is the whole database). */
  let triedChanges = 0;
  /** A save started by a timer or the count limit is queued or running: another one would only pile up behind it. */
  let autoSaving = false;

  const publish = () => deps.report({ ...state });

  function arm(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = undefined; autoSave(); }, IDLE_BEFORE_SAVE_MS);
    // A timer that has fired forgets itself: one that fired while a copy was being written (and so did nothing) must not
    // stop the next one from being set.
    if (!maxTimer) maxTimer = setTimeout(() => { maxTimer = undefined; autoSave(); }, Math.max(0, firstUnsavedAt + MAX_UNSAVED_MS - Date.now()));
  }

  function autoSave(): void {
    if (autoSaving) return;
    autoSaving = true;
    void save(true).finally(() => { autoSaving = false; });
  }

  function disarm(): void {
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    idleTimer = undefined;
    maxTimer = undefined;
  }

  async function save(front = false, inJob = false): Promise<void> {
    disarm();
    if (stopped || deps.store.kind === "none" || !state.unsaved) return;
    const run = inJob ? <T>(job: () => Promise<T>) => job() : front ? deps.queue.runNext : deps.queue.run;
    const startedAt = performance.now();
    const startedWall = Date.now();
    let copy: Blob;
    let covers = 0;
    let meta!: CopyMeta;
    try {
      copy = await run(async () => {
        covers = changes;
        meta = deps.meta();
        lastMark = await deps.writeMark();
        return deps.copy(deps.store.copyFormat);
      });
    } catch {
      triedChanges = changes;
      state.failed = true;
      publish();
      return;
    }
    triedChanges = Math.max(triedChanges, covers);
    writing = writing.then(async () => {
      try {
        await deps.store.write(copy, meta);
        state.lastSavedAt = Date.now();
        state.lastCopyMs = Math.round(performance.now() - startedAt);
        state.lastCopyBytes = copy.size;
        state.failed = false;
        await Promise.resolve(deps.onDurable?.(meta)).catch(() => {});
        // "Saved" only once the store has the copy, and only if nothing changed while it was being written.
        savedChanges = Math.max(savedChanges, covers);
        // Changes made after this copy was taken wait at most MAX_UNSAVED_MS more: counted from this copy, not from the old first change.
        if (covers === changes) { state.unsaved = false; firstUnsavedAt = 0; } else firstUnsavedAt = startedWall;
      } catch {
        state.failed = true;
      }
      publish();
    });
    await writing;
    if (state.unsaved && !state.failed) { firstUnsavedAt ||= Date.now(); arm(); }
  }

  function markUnsaved(): void {
    if (stopped) return;
    changes++;
    state.changes = changes;
    const wasUnsaved = state.unsaved;
    state.unsaved = true;
    firstUnsavedAt ||= Date.now();
    arm();
    if (changes - Math.max(savedChanges, triedChanges) >= MAX_UNSAVED_CHANGES) autoSave();
    // A session that keeps no copy never goes back to "saved": its page follows every change instead (BridgeSaveState.changes).
    if (!wasUnsaved || deps.store.kind === "none") publish();
  }

  return {
    markUnsaved,
    async afterJob() {
      const mark = await deps.writeMark();
      if (lastMark === null) { lastMark = mark; return; }
      if (mark === lastMark) return;
      lastMark = mark;
      markUnsaved();
    },
    flush: () => save(true),
    flushInJob: () => save(true, true),
    async stop() { stopped = true; disarm(); await writing; },
    state: () => ({ ...state }),
    setJournal(update) { Object.assign(state, update); publish(); },
  };
}
