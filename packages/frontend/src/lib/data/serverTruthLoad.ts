// serverTruth.ts (a note read from the server, judged by where it was read) runs only after the server has answered, so it
// is not part of the boot JS. Its chunk starts loading when this page's modules load, not on first use: the instance is
// then this page's own (the multi-tab test world gives each tab its own modules, and an import started later resolves
// in the newest tab's), and it is there before the first note opens. A failed load is tried again on use.
import { addToast } from "../appStore";
import { isBrowserOnline } from "../browserNetwork";
import { t } from "../i18n";

type ServerTruth = typeof import("./serverTruth");

/** Notes to read from the server again, once nothing of this device is queued for one (syncEngine.releaseHeldNotes, at
 *  the start of every sync): a delta's text kept behind a queued write of this device (AppliedSyncDelta.heldText), whose
 *  merged row no later delta carries; a read refused a few times in a row (serverTruth.readServerNode). Here, not in
 *  syncEngine, so serverTruth needs no import of it (syncEngine loads serverTruth). */
export const readAgain = new Set<string>();
/** Set by syncEngine. `sync`: what a refused read asks for a little later (serverTruth.readServerNode). `again`: a pass
 *  now, or once the one in flight ends (its start is past, syncEngine.markSyncDirty): after the server went back.
 *  `readWhenAnswered`: a read whose field stayed under an edit still waiting for its answer (storeOps.serverCopyOver)
 *  is read again once that edit has its answer, whether or not a pass is in flight (syncEngine.readAgainWhenAnswered).
 *  `forgetRounds`: set by serverTruth, for tests: every note's refused rounds start over and the syncs they asked
 *  for later are not run (a test's timer would otherwise start a pass in whichever test runs then). */
export const later: { sync: () => void; again: () => void; readWhenAnswered: (id: string) => void; forgetRounds?: () => void } = { sync: () => {}, again: () => {}, readWhenAnswered: () => {} };

let loading: Promise<ServerTruth> = import("./serverTruth");
loading.catch(() => {});

export function serverTruth(): Promise<ServerTruth> {
  return (loading = loading.catch(() => import("./serverTruth")));
}

let toldToReload = false;
/** For a caller with nothing else to do without it (syncEngine.hydrateNode): asked twice; still not loaded while online
 *  (after a deploy the file is gone and the page could not reload itself, lib/lazyWithReload.ts), the person is told
 *  once to reload the page. Offline the stored body stays and nothing is said. */
export async function serverTruthOrTell(): Promise<ServerTruth | null> {
  // The wording is in the boot dictionary (lib/i18n.zh-TW.boot.ts): no late file is needed to say it.
  try { return await serverTruth().catch(() => serverTruth()); } catch {
    if (isBrowserOnline() && !toldToReload) {
      toldToReload = true;
      addToast(t("This version of the app is out of date. Reload the page."), "warning");
    }
    return null;
  }
}
