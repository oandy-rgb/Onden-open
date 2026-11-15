// The account preferences (RSS unread numbers, per-feed numbers, reading
// positions, last visit, the journal's 收工, the nav layout, the sidebar's tags,
// the one-time hints, where day notes go…) share one shape: a synced pref (lib/syncedPrefStore) with a local copy
// under its own PREFS key, a parser, and — for the old values — a one-time move
// off the key they were kept under before.
//
//   • Every save carries the time of the edit; the server keeps the later edit,
//     so a device that was offline never writes an older edit over a newer one.
//   • `isNewer` (optional): for a value that only moves forward (a time, a day).
//     The server keeps the value that is further forward whatever the edit
//     times (equal is not newer: this device's edit stands), and the key must
//     be in the backend's FORWARD_ORDER (services/actorPrefs.ts) with the same
//     order. Here it decides whether the old local value is worth moving up.
//   • `merge` (optional): for a value two devices both add to (the hints seen:
//     a union). Saving sends merge(server's, this device's), without an edit
//     time, and keeps that here too, so what another device added is not lost.
//
// Every spec says how its value follows the person (`follows`), because a value
// that only makes sense on one kind of screen must not land unchanged on
// another (2026-11-08: a split opened on a desktop reopened on the phone):
//   • "account": one value on every device (hints seen, time zone, RSS unread
//     choice…): the same choice wherever they sign in.
//   • "deviceKind": a layout choice. The value is kept once per kind of screen —
//     "phone" while the mobile layout applies (isMobileLayout, ≤ 900px wide, so
//     a tablet held narrow is a phone and a tablet at desktop width is a
//     desktop), "desktop" otherwise — under `${serverKey}.phone` / `.desktop`.
//     Each kind follows the account across devices of that kind, and a
//     rotation or window resize switches to the other kind's value. Until a
//     kind has its own value it starts from the old single value (`serverKey`
//     itself, still accepted by the server but no longer written, and the old
//     local copy), so nothing set before is lost.
// Not lib/prefs' "account" scope: that is only "this browser's copy per signed-in
// account", never sent anywhere. test/guards/accountPrefs.guard.test.ts keeps
// every spec's declaration and the backend's key list in step.
//
// The one place that spells the endpoint: PUT /api/me/prefs/:key (the read is
// reads.people.myPref). test/guards/tasks-time.guard.test.ts holds it there.
//   • `legacy` (optional): the key the value was kept under before it followed
//     the account. Until the first sync it is what the page shows; once a sync
//     reached the server it is moved up once — only when the server holds
//     nothing yet (or, with `isNewer`, only when it is newer) — then removed.
//     The server's value is never replaced by an old local one otherwise.

import { useEffect, useSyncExternalStore } from "react";
import { getPref, getPrefJson, prefKey, removePref, setPrefJson, type Pref } from "./prefs";
// syncedPrefStore before the data layer: lib/data/dayNoteParentStore calls
// createAccountPref while lib/data loads, and a load that starts here (this file
// first, then the data layer, then back) must find createSyncedPrefStore ready.
// (reads and sendWrite are only used later, when a pref loads or saves.)
import { createSyncedPrefStore, useKeepSynced, useSyncedPref, type SyncedPrefStore } from "./syncedPrefStore";
import { reads, sendWrite } from "./data";
import { isMobileLayout, mediaQueryList, MOBILE_QUERY } from "./mediaQuery";

type AccountPrefBase<T> = {
  /** The pref key on the server (PUT /api/me/prefs/:key). */
  serverKey: string;
  /** This device's copy, an account-scope PREFS key. */
  copy: Pref;
  parse: (value: unknown) => T | null;
};

export type AccountPrefSpec<T> = AccountPrefBase<T> & (
  | {
    /** The same choice on every device. */
    follows: "account";
    /** Whether `a` is strictly newer than `b`. */
    isNewer?: (a: T, b: T) => boolean;
    /** What to save given the server's value (null: none yet) and this device's. */
    merge?: (theirs: T | null, mine: T) => T;
    legacy?: { pref: Pref; parse: (raw: string) => T | null };
  }
  | {
    /** One value per kind of screen (phone / desktop); see the file header.
     *  The backend must accept `${serverKey}.phone` and `${serverKey}.desktop`. */
    follows: "deviceKind";
  }
);

export type DeviceKind = "phone" | "desktop";
export const DEVICE_KINDS: readonly DeviceKind[] = ["phone", "desktop"];
/** The kind of screen this page is on now: the mobile layout is a phone. */
export const currentDeviceKind = (): DeviceKind => (isMobileLayout() ? "phone" : "desktop");

type AccountPref<T> = {
  store: SyncedPrefStore<T>;
  bound: () => boolean;
  /** The value and `save`, kept in sync; re-renders on every change. */
  useValue: () => ReturnType<typeof useSyncedPref<T>>;
  /** Keep it in sync (and move the old value) without re-rendering on its changes. */
  useKeepInSync: () => void;
};

export function createAccountPref<T>(spec: AccountPrefSpec<T>): AccountPref<T> {
  return spec.follows === "deviceKind" ? createDeviceKindPref(spec) : createSinglePref(spec);
}

/** One value per kind of screen: a synced store per kind, and one facade that
 *  always answers for the kind the page is in. */
function createDeviceKindPref<T>(spec: AccountPrefBase<T>): AccountPref<T> {
  const { serverKey, copy, parse } = spec;
  const stores = {} as Record<DeviceKind, SyncedPrefStore<T>>;
  for (const kind of DEVICE_KINDS) {
    const kindCopy: Pref = { ...copy, key: `${copy.key}.${kind}` };
    stores[kind] = createSyncedPrefStore<T>(
      {
        // This kind's own value; none yet: what the account held before the split by kind.
        load: async () => parse((await reads.people.myPref<unknown>(`${serverKey}.${kind}`)).value)
          ?? parse((await reads.people.myPref<unknown>(serverKey)).value),
        save: async (value, editedAt) => {
          const answer = await sendWrite<{ value?: unknown; applied?: boolean } | undefined>(
            "PUT", `/api/me/prefs/${serverKey}.${kind}`,
            editedAt === null ? { value } : { value, editAgeMs: Math.max(0, Date.now() - editedAt) },
          );
          if (answer?.applied === false) return parse(answer.value);
        },
      },
      {
        scope: () => prefKey(kindCopy),
        // No copy of this kind yet: start from the old single copy.
        read: () => (getPref(kindCopy) !== null ? getPrefJson(kindCopy) : getPrefJson(copy)),
        write: (next) => { setPrefJson(kindCopy, next); },
      },
      parse,
    );
  }
  const now = (): SyncedPrefStore<T> => stores[currentDeviceKind()];
  const bound = () => prefKey(copy) !== null;
  const store: SyncedPrefStore<T> = {
    get: () => now().get(),
    subscribe: (listener) => {
      const offs = DEVICE_KINDS.map((kind) => stores[kind].subscribe(listener));
      // A rotation or resize across the breakpoint changes which value applies.
      const query = mediaQueryList(MOBILE_QUERY);
      query?.addEventListener("change", listener);
      return () => { offs.forEach((off) => off()); query?.removeEventListener("change", listener); };
    },
    save: (value) => { now().save(value); },
    stage: (value) => { now().stage(value); },
    sync: () => now().sync(),
    forget: () => { DEVICE_KINDS.forEach((kind) => stores[kind].forget()); },
  };
  return {
    store,
    bound,
    useValue: () => {
      const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
      useKeepSynced(store, bound);
      return { ...snapshot, save: store.save };
    },
    useKeepInSync: () => { useKeepSynced(store, bound); },
  };
}

function createSinglePref<T>(spec: AccountPrefBase<T> & Extract<AccountPrefSpec<T>, { follows: "account" }>): AccountPref<T> {
  const { serverKey, copy, parse, isNewer, legacy } = spec;
  const merge = spec.merge ?? null;
  const load = async () => parse((await reads.people.myPref<unknown>(serverKey)).value);
  const legacyValue = (): T | null => {
    const raw = legacy ? getPref(legacy.pref) : null;
    return legacy && raw !== null ? legacy.parse(raw) : null;
  };

  const store: SyncedPrefStore<T> = createSyncedPrefStore<T>(
    {
      load,
      save: async (value, editedAt) => {
        const path = `/api/me/prefs/${serverKey}`;
        if (merge && value !== null) {
          // A union of what several devices added is not "the later edit": send
          // it unconditionally (read-then-write; see `merge` above).
          const merged = merge(await load(), value);
          await sendWrite("PUT", path, { value: merged });
          return merged;
        }
        // The server keeps the later edit (and, for `isNewer` keys, the value
        // that is further forward: services/actorPrefs FORWARD_ORDER) in one
        // statement; a refused write answers with what the account holds.
        const answer = await sendWrite<{ value?: unknown; applied?: boolean } | undefined>(
          "PUT", path,
          // How long ago the edit was made, measured now on this device's clock
          // (each send, including a retry of a dirty copy, measures again): the
          // server dates the edit by its own clock, so a device clock that runs
          // fast or slow cannot win or lose against another device's edit.
          editedAt === null ? { value } : { value, editAgeMs: Math.max(0, Date.now() - editedAt) },
        );
        if (answer?.applied === false) return parse(answer.value);
      },
    },
    {
      scope: () => prefKey(copy),
      // No copy yet: show the old local value until a sync says what the account holds.
      read: () => {
        if (getPref(copy) !== null) return getPrefJson(copy);
        const old = legacyValue();
        return old === null ? null : { value: old, dirty: false, editedAt: null };
      },
      write: (next) => { setPrefJson(copy, next); },
    },
    parse,
  );
  const bound = () => prefKey(copy) !== null;

  let moving = false;
  /** After a sync reached the server: move the old local value up once, then drop it. */
  const moveLegacy = (): void => {
    if (!legacy || moving || !bound() || !store.get().settled) return;
    const old = legacyValue();
    const had = getPref(legacy.pref) !== null;
    if (!had) return;
    moving = true;
    try {
      removePref(legacy.pref);
      const now = store.get();
      if (old === null || now.dirty) return;
      if (now.value === null) store.save(old);
      else if (isNewer?.(old, now.value)) store.save(old);
    } finally { moving = false; }
  };

  return {
    store,
    bound,
    /** The value and `save`, kept in sync; re-renders on every change. */
    useValue: () => useSyncedPref(store, bound),
    /** Keep it in sync (and move the old value) without re-rendering on its changes. */
    useKeepInSync: () => {
      useKeepSynced(store, bound);
      useEffect(() => {
        moveLegacy();
        return store.subscribe(moveLegacy);
      }, []);
    },
  };
}
