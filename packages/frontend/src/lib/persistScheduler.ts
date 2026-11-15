// Debounce + idle-defer scheduler for the local SQLite snapshot persist.
//
// sql.js has no incremental on-disk format: persisting means `db.export()`,
// which serializes the ENTIRE database. Doing that synchronously on every edit
// blocks the main thread for a duration that grows with content size = typing
// jank. This scheduler decouples the "a mutation happened" signal from the
// actual export by:
//   1. debouncing/coalescing a burst of edits into a single save, and
//   2. running the export inside requestIdleCallback so it never competes with
//      the keystroke that triggered it.
// Durability is preserved by flushSync(), which the owner wires to
// onPageHide (pagehide, or the page going hidden) so a still-pending save is written before the tab dies.
//
// The doExport callback is injected so this module stays pure and testable with
// fake timers + a spy — no sql.js / IndexedDB needed.

import { onPageHide } from "./pageHide";

export type PersistScheduler = {
  /** Mark dirty and (re)arm the debounce; the export runs later, off the hot path. */
  schedule(): void;
  /** Cancel pending timers and export immediately & synchronously if dirty. */
  flushSync(): void;
  /** Cancel pending timers and clear the dirty flag without exporting, for an
   *  owner that is about to save the whole state itself. Returns whether a
   *  save was pending. */
  cancel(): boolean;
  /** A save is pending (scheduled, not yet started). */
  isDirty(): boolean;
};

/** How long typing may pause before each autosave runs (ms). The values differ on purpose (a
 *  small form saves sooner than the note body, the local snapshot is the slowest); they live here
 *  so a new autosave picks a named delay instead of a bare number. */
export const SAVE_DEBOUNCE_MS = {
  view: 400,
  schema: 600,
  card: 1000,
  overview: 1500,
  snapshot: 2000,
} as const;

/** Runs `fn` once, `ms` after the last `run()`. A new `run` replaces the pending one; callers flush by calling their own save. */
export function createSaveDebounce(ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  return {
    run(fn: () => void) { cancel(); timer = setTimeout(() => { timer = null; fn(); }, ms); },
    cancel,
  };
}

export type PersistSchedulerOptions = {
  /** Performs the expensive snapshot + store. Invoked at most once per dirty cycle. */
  doExport: () => void;
  /** Debounce window for coalescing edits (ms). */
  debounceMs?: number;
  /** Upper bound on how long the idle export may be deferred (ms). */
  idleTimeoutMs?: number;
};

export function createPersistScheduler(opts: PersistSchedulerOptions): PersistScheduler {
  const debounceMs = opts.debounceMs ?? SAVE_DEBOUNCE_MS.snapshot;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 1000;

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let idleHandle: number | null = null;
  // True between a schedule() and the export that consumes it. The flush path
  // reads this so a coalesced-away save is never silently dropped.
  let dirty = false;
  let unloadBound = false;

  function cancelIdle(): void {
    if (idleHandle == null) return;
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(idleHandle);
    else clearTimeout(idleHandle as unknown as ReturnType<typeof setTimeout>);
    idleHandle = null;
  }

  function cancelTimer(): void {
    if (saveTimer == null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  function exportIfDirty(): void {
    if (!dirty) return;
    // Clear BEFORE export so a mutation racing in during the (possibly async)
    // store re-marks dirty and re-arms a fresh cycle instead of being lost.
    dirty = false;
    opts.doExport();
  }

  function runExportDeferred(): void {
    cancelIdle();
    if (typeof requestIdleCallback === "function") {
      // Cap the wait so a perpetually busy main thread can't starve the save.
      idleHandle = requestIdleCallback(() => { idleHandle = null; exportIfDirty(); }, { timeout: idleTimeoutMs });
    } else {
      idleHandle = setTimeout(() => { idleHandle = null; exportIfDirty(); }, 0) as unknown as number;
    }
  }

  function flushSync(): void {
    cancelTimer();
    cancelIdle();
    exportIfDirty();
  }

  function bindUnloadFlush(): void {
    if (unloadBound || typeof window === "undefined") return;
    unloadBound = true;
    // Flush synchronously so durability survives the tab dying (close, bfcache,
    // or a phone app switch); pagehide also fires on desktop tab close.
    onPageHide(flushSync);
  }

  function schedule(): void {
    dirty = true;
    bindUnloadFlush();
    cancelTimer();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      runExportDeferred();
    }, debounceMs);
  }

  function cancel(): boolean {
    cancelTimer();
    cancelIdle();
    const was = dirty;
    dirty = false;
    return was;
  }

  return { schedule, flushSync, cancel, isDirty: () => dirty };
}
