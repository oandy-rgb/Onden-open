// Stale code-split chunks after a deploy, handled in one place.
//
// The app loads features through `lazy(() => import(...))` (hashed files under
// /_astro/). A tab opened before a deploy keeps running the old JS; the new
// frontend no longer serves the old hashed files, so the next lazy feature's
// import fails ("Failed to fetch dynamically imported module", a 404 HTML
// page in place of JS) and the error screen shows until the person reloads.
//
// Here a chunk-load failure does ONE full reload, but only when the server shows the
// file is gone (fileIsGoneFromServer); a request that merely failed on the network, even if
// the connection is back by the time the handler runs, leaves the page alone. It does ONE reload, after the open draft is
// flushed, so the page picks up the new index and its new chunk names. The
// guard (sessionStorage) keeps it from looping: at most one automatic reload
// per build of the app, and none within RELOAD_WINDOW_MS of the previous one.
// When the guard says no, or the draft could not be saved, the import error
// reaches the error boundary as before, with its 重新載入 button.
//
// Every code-split component goes through lazyWithReload (raw `lazy(` is
// forbidden elsewhere: src/test/lazyWithReload.test.tsx).

import { pageHref, reloadPage } from "./api";
import { dictionariesReady } from "./i18n";
import { isBrowserOnline } from "./browserNetwork";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { ReloadGate } from "./data";
import { SESSION_KEYS, readSession, removeSession, sessionAvailable, writeSession } from "./sessionPrefs";

/** This build of the app (astro.config.mjs defines it per build); "dev" in
 *  tests and the native build. */
declare const __ONDEN_BUILD_ID__: string | undefined;
export const BUILD_ID: string = typeof __ONDEN_BUILD_ID__ === "string" ? __ONDEN_BUILD_ID__ : "dev";

export const RELOAD_WINDOW_MS = 30_000;
/** How long a reload waits for the open draft to be saved. */
const FLUSH_TIMEOUT_MS = 3_000;

/** The page reload, behind a seam tests can observe (jsdom can't stub location). */
export const chunkReloadPage = { reload: () => reloadPage() };

/** What the app says about reloading now. `unknown`: it could not tell. */
export type ReloadVerdict = ReloadGate | { kind: "unknown" };
const SAFE: ReloadVerdict = { kind: "safe", recovered: [] };

type BeforeReload = () => Promise<ReloadVerdict>;
let beforeReload: BeforeReload = async () => SAFE;

/** The app entry registers how to make unsaved work safe before a reload
 *  (flush the open draft, check what lives only in memory). Anything but
 *  `safe` means text would be lost: no reload. */
export function setBeforeChunkReload(fn: BeforeReload): void {
  beforeReload = fn;
}

const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|Failed to fetch|Unable to preload CSS|is not a valid JavaScript MIME type|module script.*MIME type|ChunkLoadError|Loading (CSS )?chunk .* failed/i;

/** A failed dynamic import / chunk preload (Chrome, Firefox, Safari wording). */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  return typeof message === "string" && CHUNK_ERROR.test(message);
}

type Mark = { build: string; at: number };

function readMark(): Mark | null | undefined {
  if (!sessionAvailable()) return undefined; // no guard, so no automatic reload
  try {
    const raw = readSession(SESSION_KEYS.chunkReload);
    if (!raw) return null;
    const mark = JSON.parse(raw) as Partial<Mark>;
    return typeof mark.build === "string" && typeof mark.at === "number" ? { build: mark.build, at: mark.at } : null;
  } catch {
    return null; // an unreadable mark guards nothing, like an absent one
  }
}

/** The browser says it has no network: a file that did not load was never
 *  fetched, not replaced by a deploy (components/AppErrorBoundary says so). */
export function browserOffline(): boolean {
  return !isBrowserOnline();
}

/** Whether an automatic reload is allowed now (synchronous: the preload event
 *  must decide on the spot). */
export function canAutoReload(now = Date.now()): boolean {
  // Offline, a failed import is the network, not a deploy, and a reload would
  // leave the app for the browser's offline page: keep the error screen.
  if (browserOffline()) return false;
  const mark = readMark();
  if (mark === undefined) return false;
  if (!mark) return true;
  return mark.build !== BUILD_ID && now - mark.at >= RELOAD_WINDOW_MS;
}

function withTimeout(work: Promise<ReloadVerdict>, ms: number): Promise<ReloadVerdict> {
  // Timing out still reloads: a save that is in flight is kept by the page-exit
  // path (pagehide keepalive flush, unconfirmed-write recovery).
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(SAFE), ms);
    work.then(
      (verdict) => { clearTimeout(timer); resolve(verdict); },
      (cause) => { clearTimeout(timer); console.warn("[reload] blocked: could not check unsaved text", cause); resolve({ kind: "unknown" }); },
    );
  });
}

// The sentence "N notes are in recovery" is for after the reload: the page
// that knows it is gone a moment later.

function rememberReloadNotice(recovered: number): void {
  if (recovered === 0) return;
  writeSession(SESSION_KEYS.reloadNotice, String(recovered)); // unwritten: the recovery panel shows them anyway
}

/** How many notes' unsent text the last reload left in recovery (once). */
export function takeReloadNotice(): number {
  const raw = readSession(SESSION_KEYS.reloadNotice);
  removeSession(SESSION_KEYS.reloadNotice);
  return raw ? Number(raw) || 0 : 0;
}

/** How long the "is the file really gone?" check may take before it counts as a network problem. */
const PROBE_TIMEOUT_MS = 4_000;

const FILE_URL = /https?:\/\/[^\s"')]+|\/[\w./@~-]+\.(?:m?js|css)\b/i;

/** The file a chunk-load error names (Chrome: "...module: <url>", Vite CSS: "...CSS for <path>"). */
function failedFileUrl(failure: unknown): string | null {
  const message = failure && typeof failure === "object" ? (failure as { message?: unknown }).message : null;
  const hit = typeof message === "string" ? FILE_URL.exec(message) : null;
  if (!hit) return null;
  try { return new URL(hit[0], pageHref()).href; } catch { return null; }
}

/** The one place that tells a deploy from a network failure. A file that failed to load is "gone" only
 *  when the server ANSWERS and no longer has it (404/410, or its HTML page where the file should be).
 *  A request that gets no answer (offline, a blip that is already over when this runs, a timeout) or a
 *  server error is the network. The probe is a HEAD with cache "no-store" on purpose: public/sw.js
 *  answers only GET (a cached build file, or the offline shell page), so a HEAD always reaches the
 *  real server and an offline answer can never pass for "the file is gone"
 *  (src/test/serviceWorkerCache.test.ts holds the worker to that). On "network" the page stays and the
 *  lazy part retries later. Without a file name in the error (Safari), "the server answers at all" is
 *  the evidence. */
async function fileIsGoneFromServer(failure: unknown): Promise<boolean> {
  if (typeof fetch !== "function") return false;
  const file = failedFileUrl(failure);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(file ?? new URL("/", pageHref()).href, { method: "HEAD", cache: "no-store", signal: controller.signal });
    if (!file) return true;
    if (response.status === 404 || response.status === 410) return true;
    return response.ok && /text\/html/i.test(response.headers.get("content-type") ?? "");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let reloading: Promise<boolean> | null = null;

/** Reload once for a stale chunk. Resolves true when the page is reloading
 *  (callers should then wait, not show an error), false when the guard or an
 *  unsaved draft stopped it. Concurrent failures share one attempt. */
function reloadForStaleChunk(failure: unknown): Promise<boolean> {
  if (reloading) return reloading;
  if (!canAutoReload()) return Promise.resolve(false);
  const attempt = (async () => {
    // Only a deploy justifies a reload; a failed request must leave the page as it is.
    if (!(await fileIsGoneFromServer(failure))) { reloading = null; return false; }
    let verdict: ReloadVerdict;
    try { verdict = await withTimeout(beforeReload(), FLUSH_TIMEOUT_MS); } catch { verdict = { kind: "unknown" }; }
    if (verdict.kind !== "safe") { reloading = null; return false; }
    if (!writeSession(SESSION_KEYS.chunkReload, JSON.stringify({ build: BUILD_ID, at: Date.now() }))) {
      reloading = null;
      return false; // without the mark a reload could loop
    }
    rememberReloadNotice(verdict.recovered.length);
    chunkReloadPage.reload();
    return true;
  })();
  reloading = attempt;
  return attempt;
}

/** Reload once, by itself, because this page is too old for the server (the boot watchdog, components/BootWatchdog).
 *  Same once-per-build guard and draft-saving step as a stale chunk. Resolves true when the page is reloading. */
export function reloadOnceForNewVersion(): Promise<boolean> { return reloadForStaleChunk(); }

/** Reload now because the person asked (the server runs a newer build): the
 *  same draft-saving step as a stale chunk, but no once-per-build guard, since
 *  a click is not a loop. Anything but `safe` means text would be lost: the
 *  page stays, and the verdict says why. */
export async function reloadForNewVersion(): Promise<ReloadVerdict> {
  let verdict: ReloadVerdict;
  try { verdict = await withTimeout(beforeReload(), FLUSH_TIMEOUT_MS); } catch { verdict = { kind: "unknown" }; }
  if (verdict.kind !== "safe") return verdict;
  rememberReloadNotice(verdict.recovered.length);
  chunkReloadPage.reload();
  return verdict;
}

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

const NEVER = new Promise<never>(() => {});

type LazyFactory = () => Promise<unknown>;
// Every screen defined below, until the offline warm-up takes them (lib/offlineWarmup):
// it fetches each once while idle, so the first opening after an update does not wait
// for the download and the screen opens without a connection.
const unwarmed = new Set<LazyFactory>();

/** The screens defined since the last call. A screen's file may define more when it loads
 *  (a dialog inside a page), so the warm-up asks again until none are left. */
export function takeUnwarmedScreens(): LazyFactory[] {
  const taken = [...unwarmed];
  unwarmed.clear();
  return taken;
}

/** React.lazy that survives a deploy: a chunk-load failure reloads the page
 *  once (see above) and keeps the Suspense fallback up meanwhile.
 *  `warm: false` keeps a large, rarely opened screen out of the offline warm-up:
 *  it is fetched when first opened. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same constraint as React.lazy
export function lazyWithReload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  { warm = true }: { warm?: boolean } = {},
): LazyExoticComponent<T> {
  if (warm) unwarmed.add(factory);
  return lazy(async () => {
    let failure: unknown;
    try {
      // The screen's wording is registered before it first renders (lib/i18n dictionariesReady).
      const [mod] = await Promise.all([factory(), dictionariesReady()]);
      // Vite resolves the import to undefined when a vite:preloadError
      // listener (below) took the failure over.
      if (mod && mod.default) return mod;
      failure = new Error("Failed to fetch dynamically imported module (resolved empty)");
    } catch (error) {
      if (!isChunkLoadError(error)) throw error;
      failure = error;
    }
    if (await reloadForStaleChunk(failure)) return NEVER;
    throw failure;
  });
}

/** Vite's own signal for a failed chunk or CSS preload (and, in Vite 7, a
 *  failed dynamic import of the module itself). Taking it over
 *  (preventDefault) makes the import resolve undefined instead of throwing;
 *  only do that when the reload will happen. Idempotent; returns an uninstaller. */
let installed: (() => void) | null = null;
export function installChunkReloadHandler(target: Window = window): () => void {
  if (installed) return installed;
  const onPreloadError = (event: Event) => {
    if (!canAutoReload()) return;
    event.preventDefault();
    console.warn("[chunk] a code-split file is missing (new deploy?): reloading once", (event as Event & { payload?: unknown }).payload);
    void reloadForStaleChunk((event as Event & { payload?: unknown }).payload);
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  installed = () => {
    target.removeEventListener("vite:preloadError", onPreloadError);
    installed = null;
  };
  return installed;
}

/** Tests: forget the in-progress attempt. */
export function resetChunkReloadForTests(): void {
  reloading = null;
  beforeReload = async () => SAFE;
}
