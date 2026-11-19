// The save rule's check, shared by the kill/reopen tests and the multi-tab property
// (docs/architecture/note-writes.md「送出前先記下」).
//
// After a page is reopened, a note body in the local copy that the server never
// accepted must have a pending record holding that text: a queued write (it
// will be sent), a refused row or a recovery entry (it is shown to the
// person). Otherwise the editor shows the text as if saved, nothing sends it,
// and the next bootstrap or sync of the note replaces it with the server's.

import { NOTES, noteVersion, type Tab, type World } from "./tabWorld";

const textOf = (body: string | null): number => {
  try { return noteVersion((JSON.parse(body ?? "{}") as { markdown?: string }).markdown); }
  catch { return -1; }
};

/** Notes whose stored body is a text the server never accepted and no pending record holds. Run before the tab sends anything. */
export async function strandedTexts(w: World, tab: Tab): Promise<string[]> {
  const run = <T>(fn: () => Promise<T>) => w.drive(w.start(tab, fn) as Promise<T>, null);
  const { localDb, writeRecovery } = tab.mods;
  const queued = await run(() => localDb.getPendingWrites());
  const refused = await run(() => localDb.getRejectedWrites());
  await run(() => writeRecovery.refreshRecoveryWrites());
  const held = new Set([...queued, ...refused, ...writeRecovery.getRecoveryWrites()].map((write) => textOf(write.body)));
  const problems: string[] = [];
  for (const id of NOTES) {
    const stored = noteVersion((await run(() => localDb.getStoredBody(id))) ?? undefined);
    if (stored <= 0 || w.server.appliedNs.has(stored) || w.server.remoteNs.has(stored) || held.has(stored)) continue;
    problems.push(`${id}: the local copy holds v${stored}, the server never accepted it, and no queued write or recovery entry holds it`);
  }
  return problems;
}
