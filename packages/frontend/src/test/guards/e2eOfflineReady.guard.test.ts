// Guard: a full-stack e2e spec that goes offline first waits for the device to be offline-ready (`expectOfflineReady`).
// The e2e harness has no cache of the lazily loaded screens until the idle warm-up (lib/offlineWarmup.ts) has run. A spec that
// calls `context.setOffline(true)` before that fails whenever the page needs a screen it has not loaded yet: the chunk load
// fails, AppErrorBoundary replaces the app ("Not available offline yet"), and the reconnect handler that would send the queued
// writes is gone — the failure looks like "an offline change never reached the server" (zzDeepTag02, 2026-11-18, about 1 run in 8).
// Specs that already go offline without the wait are listed; fix one by calling `expectOfflineReady(page)` once the page is
// loaded and before it goes offline, then delete its line. The list can only shrink.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { E2E_DIR } from "./e2eSelectors";

const DIR = join(E2E_DIR, "fullstack");
const GOES_OFFLINE = /\.setOffline\(\s*true\s*\)/;
const WAITS = /\bexpectOfflineReady\(/;

// ratchet:list NOT_YET_WAITING
const NOT_YET_WAITING: readonly string[] = [
  "inkColdStart.spec.ts", "mobilePanels.spec.ts", "offlineFlakyNetwork.spec.ts", "offlineOrganize.spec.ts",
  "offlineTaskTag.spec.ts", "syncStatus.spec.ts", "taskScopeContract.spec.ts", "zzDeepCan02.spec.ts", "zzDeepCol01.spec.ts",
  "zzDeepCol02.spec.ts", "zzDeepCol03.spec.ts", "zzDeepCol05.spec.ts", "zzDeepHist05.spec.ts", "zzDeepHist08.spec.ts",
  "zzDeepRev02.spec.ts", "zzDeepRss05.spec.ts", "zzDeepRss05b.spec.ts", "zzDeepSys03.spec.ts", "zzDeepTag10.spec.ts",
];

const goingOfflineWithoutWaiting = (files: Record<string, string>) =>
  Object.entries(files).filter(([, text]) => GOES_OFFLINE.test(text) && !WAITS.test(text)).map(([name]) => name).sort();

describe("offline e2e specs wait for the device to be offline-ready", () => {
  const files = Object.fromEntries(readdirSync(DIR).filter((name) => name.endsWith(".spec.ts")).map((name) => [name, readFileSync(join(DIR, name), "utf8")]));
  const found = goingOfflineWithoutWaiting(files);

  it("every spec that goes offline waits first, except the listed ones", () => {
    expect(found.filter((name) => !NOT_YET_WAITING.includes(name)), "call expectOfflineReady(page) (e2e/fullstack/helpers.ts) before going offline").toEqual([]);
  });

  it("lists nothing that waits now or no longer goes offline", () => {
    expect(NOT_YET_WAITING.filter((name) => !found.includes(name)), "delete these from NOT_YET_WAITING").toEqual([]);
  });

  it("reads a spec's text: a wait or a going-offline call counts only as a call", () => {
    expect(goingOfflineWithoutWaiting({ "a.spec.ts": "await context.setOffline(true);" })).toEqual(["a.spec.ts"]);
    expect(goingOfflineWithoutWaiting({ "b.spec.ts": "await expectOfflineReady(page);\nawait context.setOffline(true);" })).toEqual([]);
    expect(goingOfflineWithoutWaiting({ "c.spec.ts": "await context.setOffline(false);" })).toEqual([]);
  });
});
