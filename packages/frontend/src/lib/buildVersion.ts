// "A newer version is out": the server says which build it runs on every API
// response (X-Onden-Build, backend buildHeader.ts); a page built from another
// revision offers a reload instead of running old code against a new API for
// days. The reload is the stale-chunk one (lazyWithReload): the open draft is
// saved first.

import { setClientTooOldListener, setServerBuildListener } from "./api";
import { SESSION_KEYS, readSession, writeSession } from "./sessionPrefs";
import { setAppState } from "./appStore";
import { BUILD_ID, reloadForNewVersion, type ReloadVerdict } from "./lazyWithReload";

/** The server build the person already reloaded for. A frontend-only deploy
 *  leaves the two builds different even after the reload; asking again for
 *  the same server build would only nag. */
function reloadedFor(): string | null {
  return readSession(SESSION_KEYS.buildNotice);
}

/** Whether a server on `serverBuild` means this page (built as `ownBuild`) is
 *  old. Unknown on either side ("dev" in tests and local builds, no header
 *  from a server that does not know) never does. */
export function isNewerServerBuild(serverBuild: string | null, ownBuild: string = BUILD_ID, alreadyReloaded: string | null = reloadedFor()): boolean {
  if (!serverBuild || ownBuild === "dev") return false;
  return serverBuild !== ownBuild && serverBuild !== alreadyReloaded;
}

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
  if (newer) setAppState({ newVersionAvailable: true });
}

/** The build the server (or, in the trial version, the published folder's build file) says is current. */
export function noteServerBuild(serverBuild: string | null): void {
  if (serverBuild) latestServerBuild = serverBuild;
  offerReload(isNewerServerBuild(serverBuild));
}

/** 「有新版，重新載入」: reload once no text lives only in memory. Anything but
 *  `safe`: the page stays, and the verdict says why. */
export async function reloadForNewBuild(): Promise<ReloadVerdict> {
  if (latestServerBuild) writeSession(SESSION_KEYS.buildNotice, latestServerBuild); // unwritten: at worst we ask again
  return reloadForNewVersion();
}
