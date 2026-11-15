// A small account preference kept on the server, per person (PUT
// /api/me/prefs/:key), so it follows them to every device, and in a local copy
// (lib/prefs, account scope) so it draws at once and edits made offline stick.
// The navigation layout (lib/navLayoutStore) and the sidebar's pinned and
// hidden tags (lib/sidebarTagsStore) are two of them.
//
// The contract callers rely on:
//   • `save` takes effect immediately on this page and in the local copy; it
//     is then sent to the server. A copy the server has not accepted yet is
//     marked `dirty` and is sent again on the next sync (reconnect, focus).
//   • A sync with nothing dirty adopts the server's value. A dirty copy is sent
//     with how long ago the edit was made (`editAgeMs`, from this device's
//     `editedAt`, measured at each send; accountPrefStore) and the server dates
//     the edit by its own clock and keeps the later edit: an edit made offline long ago does not overwrite a
//     newer one from another device. When the server refuses it, the copy takes
//     what the server holds and is no longer dirty. There is no merge: a
//     preference is one small choice, the last edit in time wins.
//     (A copy saved by an older frontend has no time and is sent unconditionally.)
//   • `settled` is true once a sync reached the server. Only then may a caller
//     prune ids that are gone (a removed module, a deleted tag): before it,
//     the local copy may be older than another device's edit.
//   • null is the default (never edited, or reset).
// Before the page is bound to an account the value lives in memory only.

import { useEffect, useSyncExternalStore } from "react";
import { onAppResume } from "./appResume";

export type SyncedPrefSnapshot<T> = {
  value: T | null;
  /** This copy has not been accepted by the server yet. */
  dirty: boolean;
  /** When this device made the edit, in ms since the epoch (this device's
   *  clock); null for a value taken from the server or saved before times were kept. */
  editedAt: number | null;
  /** A sync has reached the server since the page (or account) opened. */
  settled: boolean;
};

/** The server side. Both reject when it cannot be reached. `save` may return
 *  what the server now holds when that differs from what was sent (a list the
 *  server merged with another device's, or a later edit it kept instead); the
 *  store then takes it. `editedAt` is null when the copy has no edit time. */
export type SyncedPrefRemote<T> = {
  load: () => Promise<T | null>;
  save: (value: T | null, editedAt: number | null) => Promise<T | null | void>;
};

/** The local copy. `scope` names whose copy it is (null: none yet, memory only). */
export type SyncedPrefLocal<T> = {
  scope: () => string | null;
  read: () => unknown;
  write: (copy: { value: T | null; dirty: boolean; editedAt: number | null }) => void;
};

export type SyncedPrefStore<T> = {
  get: () => SyncedPrefSnapshot<T>;
  subscribe: (listener: () => void) => () => void;
  /** Change the value (null: back to the default) and send it at once. */
  save: (value: T | null) => void;
  /** Change the value here and in the local copy, dirty, without sending it:
   *  for a value that changes many times a second (a reading position). The
   *  caller sends it later with `sync`; until then it survives a reload as dirty. */
  stage: (value: T | null) => void;
  /** Send a dirty copy, or take the server's. Never rejects. */
  sync: () => Promise<void>;
  /** Drop what this page holds: the next read comes from the local copy again,
   *  not yet synced. For when that copy was cleared or replaced from outside
   *  (tests; the page itself starts from nothing). */
  forget: () => void;
};

export function createSyncedPrefStore<T>(
  remote: SyncedPrefRemote<T>, local: SyncedPrefLocal<T>, parse: (value: unknown) => T | null,
): SyncedPrefStore<T> {
  let held: { scope: string | null; snapshot: SyncedPrefSnapshot<T> } | null = null;
  let syncing: Promise<void> | null = null;
  // Bumped by forget(): a sync started before it answers about a copy that is
  // gone, so its result is dropped instead of written over the fresh one.
  let generation = 0;
  const listeners = new Set<() => void>();

  const parseLocal = (copy: unknown): { value: T | null; dirty: boolean; editedAt: number | null } => {
    if (!copy || typeof copy !== "object") return { value: null, dirty: false, editedAt: null };
    const { value, dirty, editedAt } = copy as { value?: unknown; dirty?: unknown; editedAt?: unknown };
    return { value: parse(value), dirty: dirty === true, editedAt: typeof editedAt === "number" && Number.isFinite(editedAt) ? editedAt : null };
  };
  const get = (): SyncedPrefSnapshot<T> => {
    const scope = local.scope();
    if (!held || held.scope !== scope) held = { scope, snapshot: { ...parseLocal(scope === null ? null : local.read()), settled: false } };
    return held.snapshot;
  };
  const set = (next: SyncedPrefSnapshot<T>) => {
    const scope = local.scope();
    held = { scope, snapshot: next };
    if (scope !== null) local.write({ value: next.value, dirty: next.dirty, editedAt: next.editedAt });
    for (const listener of listeners) listener();
  };

  /** Now, and later than this copy's previous edit even if the clock stood still or went back. */
  const editTime = (): number => Math.max(Date.now(), (get().editedAt ?? 0) + 1);

  const sync = (): Promise<void> => {
    if (syncing) return syncing;
    const started = generation;
    syncing = (async () => {
      const before = get();
      try {
        if (before.dirty) {
          const stored = await remote.save(before.value, before.editedAt);
          if (started !== generation) return;
          // A newer edit made while this one was in flight stays dirty.
          const now = get();
          const value = stored === undefined ? now.value : stored;
          set(now === before ? { value, dirty: false, editedAt: null, settled: true } : { ...now, settled: true });
        } else {
          const server = await remote.load();
          if (started !== generation) return;
          const now = get();
          set(now === before ? { value: server, dirty: false, editedAt: null, settled: true } : { ...now, settled: true });
        }
      } catch {
        // Offline or refused: the local copy stands and a later sync retries.
      } finally {
        // After forget() the slot may hold a newer sync: leave that one.
        if (started === generation) syncing = null;
      }
      // An edit made while this sync ran is still dirty: send it now. (A
      // failed send leaves the snapshot as it was, so this never loops.)
      if (started === generation && get().dirty && get() !== before) await sync();
    })();
    return syncing;
  };

  return {
    get,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    save: (value) => {
      set({ value, dirty: true, editedAt: editTime(), settled: get().settled });
      void sync();
    },
    stage: (value) => { set({ value, dirty: true, editedAt: editTime(), settled: get().settled }); },
    forget: () => {
      generation += 1;
      held = null;
      syncing = null;
      for (const listener of listeners) listener();
    },
    sync,
  };
}

/** Keep the store in sync while mounted, without re-rendering on its changes:
 *  sync once per page while it stays settled (or while dirty), and again when
 *  the page comes back online or into view. `bound` is false before the page is
 *  bound to an account (tests, sign-in): nothing to sync yet. */
export function useKeepSynced<T>(store: SyncedPrefStore<T>, bound: () => boolean): void {
  useEffect(() => {
    if (!bound()) return;
    if (!store.get().settled || store.get().dirty) void store.sync();
    return onAppResume(() => { void store.sync(); });
  }, [store, bound]);
}

/** The value and a way to change it, kept in sync (useKeepSynced). */
export function useSyncedPref<T>(store: SyncedPrefStore<T>, bound: () => boolean): SyncedPrefSnapshot<T> & { save: SyncedPrefStore<T>["save"] } {
  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
  useKeepSynced(store, bound);
  return { ...snapshot, save: store.save };
}

/** Wait (at most `ms`) until a sync has reached the server, so a caller that is
 *  about to act on the value does not act on an empty local copy (a new device,
 *  cleared data, a page that has not synced yet). Offline or slow: returns
 *  at the limit and the caller uses the local copy, as `get()` shows it. The
 *  one wait for every account pref. */
export async function settledWithin<T>(store: SyncedPrefStore<T>, ms: number): Promise<void> {
  if (store.get().settled) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([store.sync(), new Promise((done) => { timer = setTimeout(done, ms); })]);
  clearTimeout(timer);
}
