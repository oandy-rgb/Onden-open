// "A newer version is out": the server says which build it runs on every API
// response (X-Onden-Build, backend buildHeader.ts); a page built from another
// revision offers a reload instead of running old code against a new API for
// days. The reload is the stale-chunk one (lazyWithReload): the open draft is
// saved first.

import { setClientTooOldListener, setServerBuildListener } from "./api";
import { SESSION_KEYS, writeSession } from "./sessionPrefs";
import { setNewVersionAvailable } from "./appStore";
import { BUILD_ID, reloadForNewVersion, isNewerServerBuild, type ReloadVerdict } from "./lazyWithReload";

let latestServerBuild: string | null = null;

/** Start listening to the server's build (idempotent). */
export function watchServerBuild(): void {
  setServerBuildListener(noteServerBuild);
  setClientTooOldListener(noteClientTooOld);
}

/** The server refused a write because this page is too old for it (426): offer the reload whatever the build ids say.
 *  What the person typed stays (the write is a refusal that keeps its input, lib/data/writeErrors). */
export function noteClientTooOld(): void {
  offerReload(true);
}

/** The one place the 「有新版，重新載入」 notice is switched on. */
function offerReload(newer: boolean): void {
  if (newer) setNewVersionAvailable(true);
}

/** The build the server (or, in the trial version, the published folder's build file) says is current. */
export function noteServerBuild(serverBuild: string | null): void {
  if (serverBuild) latestServerBuild = serverBuild;
  offerReload(isNewerServerBuild(serverBuild, BUILD_ID));
}

/** 「有新版，重新載入」: reload once no text lives only in memory. Anything but
 *  `safe`: the page stays, and the verdict says why. */
export async function reloadForNewBuild(): Promise<ReloadVerdict> {
  if (latestServerBuild) writeSession(SESSION_KEYS.buildNotice, latestServerBuild); // unwritten: at worst we ask again
  return reloadForNewVersion();
}
