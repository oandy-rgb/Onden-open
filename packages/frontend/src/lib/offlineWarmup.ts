// Offline warm-up: fetch the code of every screen that loads on use, once per
// page load, while online and idle. The screens are the ones defined with
// lazyWithReload (it lists itself; `warm: false` leaves a large one out) plus
// OFFLINE_SCREENS below, the code that loads on use some other way.
//
// The service worker (public/sw.js) stores every hashed /_astro/ file it
// serves, but a lazily loaded screen is only fetched the first time someone
// opens it. Without this, a phone that never opened 標籤 or 設定 while online
// shows a load error there offline (measured 2026-10-19). Fetching them here
// lets the service worker keep them.
//
// Contract: does nothing unless a service worker controls the page (the web
// build; the Android app ships its files locally), the device is online and
// the person has not asked to save data. Each import failing is ignored: the
// screen then loads on first use as before. Runs at most once per page, and
// once per build on a device: after a complete run the service worker holds
// those files, so later launches skip the work (importing also runs the
// modules, which costs a phone noticeable main-thread time).

import { serviceWorkerContainer } from "./storagePersist";
import { isBrowserOnline, prefersSavedData } from "./data";
import { BUILD_ID, takeUnwarmedScreens } from "./lazyWithReload";
import { PREFS, getPref, setPref } from "./prefs";

type WarmupEnv = {
  controlled: boolean;
  online: boolean;
  saveData: boolean;
  /** The build whose screens this device already warmed, if any. */
  warmedBuild?: string | null;
};

function readWarmedBuild(): string | null {
  return getPref(PREFS.offlineWarmBuild);
}

/** Storage off: warm again next launch. */
function markWarmed(): void {
  setPref(PREFS.offlineWarmBuild, BUILD_ID);
}

/** Code kept available offline that lazyWithReload does not list by itself: loaders
 *  called by hand, and files that are not a screen. Each entry is the same module
 *  the app loads on use, so the warmed file is the one used. */
export const OFFLINE_SCREENS: ReadonlyArray<() => Promise<unknown>> = [
  () => import("../modules").then((m) => m.loadTasksMode()),
  () => import("../settings/SettingsModal"),
  () => import("../components/OverviewPreview"),
  () => import("../components/workspace").then((m) => m.loadPaletteHost()),
  () => import("../components/CreateSheet"),
  () => import("../components/workspace").then((m) => m.loadWorkspaceContextMenu()),
  () => import("../components/collections").then((m) => m.loadViewBuilder()),
  () => import("../components/collections").then((m) => m.loadCollectionView()),
  () => import("../components/NoteTagCards"),
  // The info panel's tabs load on use (components/NodeInspector): 功能, the paragraphs on 標籤 and AI.
  // Missing here, opening the panel offline failed to load InfoParagraphs and took the whole app to the
  // error screen (found by the full e2e run, 2026-11-07).
  () => import("../components/InfoFunctions"),
  () => import("../components/infoFunctions"),
  () => import("../components/functionCatalog"),
  () => import("../components/InfoParagraphs"),
  () => import("../components/infoAi"),
  // A board's ink layer (components/KnowledgeWorkspace): the board itself loads at boot
  // (workspace/bootHooks useWorkspaceChunks) but this part only on use; offline it took the app down too.
  () => import("../components/CanvasInkLayer"),
  () => import("../components/InkNodeView"),
  // A note's sub-notes with their view tabs (NoteRelations).
  () => import("../components/SubNotesList"),
  // What modules load on use and works offline: the capture box, the quick-add
  // task sheet and the view layouts.
  () => import("../modules").then((m) => m.loadOfflineModuleScreens()),
  // Typo-tolerant search and command-palette matching (lib/lazyFuse.ts).
  () => import("./lazyFuse").then((m) => m.loadFuse()),
  () => import("@onden/markdown/snippet"),
  // Importing a JSON Canvas file (hooks/useCanvasActions) parses it with this.
  () => import("./jsonCanvas"),
  // Note export expands excerpt embeds with this when a note has one.
  () => import("./noteExportExcerpts"),
  // The note templates (new note from a template works offline).
  () => import("./noteTemplates"),
  // The shell's dialogs and cards that load when first shown (components/lateShell.ts).
  () => import("../components/lateShell").then((m) => m.loadLateShellScreens()),
  // The Chinese wording of every screen above (lib/i18n.app.ts loads it after boot).
  () => import("./i18n.zh-TW.late"),
];

function currentEnv(): WarmupEnv {
  return {
    controlled: !!serviceWorkerContainer()?.controller,
    online: isBrowserOnline(),
    saveData: prefersSavedData(),
    warmedBuild: readWarmedBuild(),
  };
}

let started = false;

/** A page inside a dialog inside a page: more rounds than that means something defines screens without end. */
const LAZY_ROUNDS_MAX = 8;

/** Load OFFLINE_SCREENS, then every screen lazyWithReload listed (`lazyScreens`), when
 *  `env` allows it; resolves with how many loaded (0 when skipped). */
export async function warmOfflineScreens(
  env: WarmupEnv = currentEnv(),
  screens: ReadonlyArray<() => Promise<unknown>> = OFFLINE_SCREENS,
  lazyScreens: () => ReadonlyArray<() => Promise<unknown>> = takeUnwarmedScreens,
): Promise<number> {
  if (started || !env.controlled || !env.online || env.saveData || env.warmedBuild === BUILD_ID) return 0;
  started = true;
  let loaded = 0;
  let asked = 0;
  // One at a time: this is background work on a phone connection.
  const run = async (batch: ReadonlyArray<() => Promise<unknown>>) => {
    for (const load of batch) {
      asked++;
      try { await load(); loaded++; } catch { /* loads on first use instead */ }
    }
  };
  await run(screens);
  // A screen's file can define more screens once it has loaded.
  for (let round = 0; round < LAZY_ROUNDS_MAX; round++) {
    const batch = lazyScreens();
    if (batch.length === 0) break;
    await run(batch);
  }
  if (loaded === asked) markWarmed();
  return loaded;
}

/** Run warmOfflineScreens when the page is idle (or after `timeoutMs`). On a
 *  first visit no service worker controls the page yet: public/sw.js takes it
 *  over a moment after boot (clients.claim), so wait for that rather than
 *  leaving the screens unfetched until the next launch. Where no worker is
 *  registered (the Android app) that never happens and nothing runs, as before. */
export function scheduleOfflineWarmup(timeoutMs = 10_000): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  const run = () => { void warmOfflineScreens(); };
  const onIdle = () => {
    if (typeof ric === "function") ric(run, { timeout: timeoutMs });
    else setTimeout(run, Math.min(timeoutMs, 2_000));
  };
  const sw = serviceWorkerContainer();
  if (sw && !sw.controller) sw.addEventListener("controllerchange", onIdle, { once: true });
  else onIdle();
}

/** Tests only: allow another run. */
export function resetOfflineWarmupForTest(): void { started = false; }
