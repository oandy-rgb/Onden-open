// The 「這次更新」 changes this account has not seen yet (lib/whatsNew), and the
// way to mark them seen. Nothing until the account's "seen up to" is known (the
// server's, or this device's copy while offline), so a card another device
// already closed never flashes here.
//
// An account with nothing recorded yet is either brand new (its first look is
// at today's list: nothing to show) or older than the newest change (it never
// saw the list: show it). The account's creation day tells which.

import { isBrowserOnline } from "../lib/data";
import { useCallback, useEffect, useState } from "react";
import { authClient } from "../lib/auth-client";
import { changesSeenBound, changesSeenStore } from "../lib/changesSeenStore";
import { todayId } from "../lib/localDate";
import { useSyncedPref } from "../lib/syncedPrefStore";
import { unseenChanges, type Change } from "../lib/whatsNewText";

/** The day this account was created, or null when the session can't say. */
async function accountCreatedDay(): Promise<string | null> {
  try {
    const created = (await authClient.getSession()).data?.user.createdAt;
    return created ? todayId(new Date(created)) : null;
  } catch { return null; }
}

/** The bundled list (lib/whatsNew) loads on its own, once: its texts stay out of the boot JS. */
let bundled: Promise<readonly Change[]> | null = null;
const loadBundledChanges = () => (bundled ??= import("../lib/whatsNew").then((m) => m.CHANGES).catch((): readonly Change[] => { bundled = null; return []; }));
const NONE: readonly Change[] = [];

/** `changes` given: that list (tests). Otherwise the bundled one, which counts as empty until it has loaded. */
export function useUnseenChanges(given?: readonly Change[]): { unseen: Change[]; markAllSeen: () => void } {
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
  const [createdDay, setCreatedDay] = useState<string | null>(null);

  const needsCreatedDay = known && newest !== null && value === null;
  useEffect(() => {
    if (!needsCreatedDay) return;
    let live = true;
    void accountCreatedDay().then((day) => { if (live) setCreatedDay(day); });
    return () => { live = false; };
  }, [needsCreatedDay]);

  // A new account starts at the newest change, as if it had already seen it.
  const startsFresh = needsCreatedDay && createdDay !== null && createdDay >= newest.date;
  useEffect(() => {
    if (startsFresh) save(newest.id);
  }, [startsFresh, newest, save]);

  const markAllSeen = useCallback(() => {
    const current = changesSeenStore.get().value;
    if (newest && (current === null || newest.id > current)) save(newest.id);
  }, [newest, save]);

  const ready = known && newest !== null && (value !== null || (createdDay !== null && !startsFresh));
  return { unseen: ready ? unseenChanges(changes, value) : [], markAllSeen };
}
