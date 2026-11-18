// The 「這次更新」 changes this account has not seen yet (lib/whatsNew), and the
// way to mark them seen. Nothing until the account's "seen up to" is known (the
// server's, or this device's copy while offline), so a card another device
// already closed never flashes here.
//
// An account with nothing recorded yet is either brand new (its first look is
// at this build's list: nothing to show) or older than this build (it never
// saw the list: show it). Two instants tell which: when the account was created
// and when the running build was made (lib/buildTime, whatsNewText.createdWithThisBuild).
// A change's `date:` plays no part: it has no time zone, so comparing it with
// the creation day gave a new account the card whenever a note was dated
// "tomorrow" in some zone.

import { isBrowserOnline } from "../lib/data";
import { useCallback, useEffect, useState } from "react";
import { authClient } from "../lib/auth-client";
import { changesSeenBound, changesSeenStore } from "../lib/changesSeenStore";
import { BUILT_AT_MS } from "../lib/buildTime";
import { useSyncedPref } from "../lib/syncedPrefStore";
import { createdWithThisBuild, unseenChanges, type Change } from "../lib/whatsNewText";

/** When this account was created (epoch ms), or null when the session can't say. */
async function accountCreatedAtMs(): Promise<number | null> {
  try {
    const created = (await authClient.getSession()).data?.user.createdAt;
    const ms = created ? new Date(created).getTime() : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}

/** The bundled list (lib/whatsNew) loads on its own, once: its texts stay out of the boot JS. */
let bundled: Promise<readonly Change[]> | null = null;
const loadBundledChanges = () => (bundled ??= import("../lib/whatsNew").then((m) => m.CHANGES).catch((): readonly Change[] => { bundled = null; return []; }));
const NONE: readonly Change[] = [];

/** `changes` given: that list (tests). Otherwise the bundled one, which counts as empty until it has loaded.
 *  `builtAtMs`: when this build was made; null (a build that does not know) shows nothing to an account without a mark. */
export function useUnseenChanges(given?: readonly Change[], builtAtMs: number | null = BUILT_AT_MS): { unseen: Change[]; markAllSeen: () => void } {
  const [loaded, setLoaded] = useState<readonly Change[]>(NONE);
  useEffect(() => {
    if (given) return;
    let live = true;
    void loadBundledChanges().then((list) => { if (live) setLoaded(list); });
    return () => { live = false; };
  }, [given]);
  const changes = given ?? loaded;
  const { value, settled, save } = useSyncedPref(changesSeenStore, changesSeenBound);
  const bound = changesSeenBound();
  const offline = !isBrowserOnline();
  const known = bound && (settled || (offline && value !== null));
  const newest = changes[0] ?? null;
  const [createdAtMs, setCreatedAtMs] = useState<number | null>(null);

  const needsCreatedAt = known && newest !== null && value === null && builtAtMs !== null;
  useEffect(() => {
    if (!needsCreatedAt) return;
    let live = true;
    void accountCreatedAtMs().then((ms) => { if (live) setCreatedAtMs(ms); });
    return () => { live = false; };
  }, [needsCreatedAt]);

  // An account made with this build starts at the newest change, as if it had already seen it.
  const startsFresh = needsCreatedAt && createdAtMs !== null && createdWithThisBuild(createdAtMs, builtAtMs);
  useEffect(() => {
    if (startsFresh) save(newest.id);
  }, [startsFresh, newest, save]);

  const markAllSeen = useCallback(() => {
    const current = changesSeenStore.get().value;
    if (newest && (current === null || newest.id > current)) save(newest.id);
  }, [newest, save]);

  const ready = known && newest !== null && (value !== null || (createdAtMs !== null && !startsFresh));
  return { unseen: ready ? unseenChanges(changes, value) : [], markAllSeen };
}
