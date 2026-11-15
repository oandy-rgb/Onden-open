import "@testing-library/jest-dom";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { flushNanostoresUnmountTimers, trackNanostoresUnmountTimers } from "./helpers/nanostoresCleanup";
// The app registers its translation tables at boot (bootApp); tests that switch
// locale without booting the app get the same wording.
import "../lib/i18n.app";
// The app fetches the late half after boot; a test that renders a screen directly
// has no such wait, so it gets the whole table at once.
import { registerDictionary } from "../lib/i18n";
import { ZH_TW_LATE } from "../lib/i18n.zh-TW.late";
registerDictionary("zh-TW", ZH_TW_LATE);
// Likewise the rarer server error codes' wording, which readErrorBody loads before an
// ApiError is built: a test that builds an ApiError directly gets it already loaded.
import { ensureWordingFor } from "../lib/serverErrors";
await ensureWordingFor("a code only the late table words");

// jsdom has no requestIdleCallback. useAppData defers the full-bootstrap
// hydration to idle (slim-paint memory/latency win); polyfill it here so that
// deferral fires promptly and deterministically under test instead of falling
// back to the 1.2s setTimeout path.
if (typeof (globalThis as Record<string, unknown>).requestIdleCallback !== "function") {
  (globalThis as Record<string, unknown>).requestIdleCallback = (cb: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void) =>
    setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0) as unknown as number;
  (globalThis as Record<string, unknown>).cancelIdleCallback = (id: number) => clearTimeout(id);
}

// jsdom has no native modal implementation. Unit tests exercise our lifecycle
// and dismissal guards; browser tests verify actual focus/inert behavior.
// The stub keeps the browser's top layer as far as Esc goes: an Esc keydown
// nobody cancelled is a close request to the top open modal dialog only —
// `cancel` (cancelable), then, unless cancelled, close() and `close`.
// (A `@vitest-environment node` file has no DOM at all.)
if (typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal !== "function") {
  const topLayer: HTMLDialogElement[] = [];
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    if (!topLayer.includes(this)) topLayer.push(this);
  };
  HTMLDialogElement.prototype.close = function () {
    const i = topLayer.indexOf(this);
    if (i >= 0) topLayer.splice(i, 1);
    this.open = false;
  };
  const dispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event: Event) {
    const result = dispatch.call(this, event);
    const key = event as KeyboardEvent;
    if (event.type === "keydown" && key.key === "Escape" && !event.defaultPrevented && !key.isComposing) {
      const top = [...topLayer].reverse().find((d) => d.isConnected && d.open);
      if (top && dispatch.call(top, new Event("cancel", { cancelable: true }))) {
        top.close();
        dispatch.call(top, new Event("close"));
      }
    }
    return result;
  };
}

// ── Per-test reset ───────────────────────────────────────────────────────────
// Tests run in a shuffled order (vitest.config.ts › sequence.shuffle), so no
// test may lean on what an earlier one left behind. Each file already gets a
// fresh module graph (isolate); this resets what lives across tests inside
// one file: timers, spies and stubbed globals, browser storage, and nodes or
// attributes a test added to <html> or <head>. <body> is left alone: React
// Testing Library unmounts what render() mounted, and a dialog that mounts its
// own root (moduleDialog, confirmDialog) must be closed by the test that
// opened it — pulling its host out from under a live root throws later.
// Only the body's own style and class are reset.
//
// This file imports no app module on purpose: a module imported here would be
// loaded before the test file's vi.mock() calls and escape them. Module-level
// stores are reset by the tests that use them, through each store's own
// reset hook (resetAppState, resetSpacesForTest, …).
let headBefore = new Set<Node>();
let htmlAttrsBefore = new Map<string, string>();

beforeEach(() => {
  if (typeof document === "undefined") return;
  headBefore = new Set(document.head.childNodes);
  htmlAttrsBefore = new Map([...document.documentElement.attributes].map((a) => [a.name, a.value]));
});

afterEach(async () => {
  if (typeof document === "undefined") return;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  try { localStorage.clear(); } catch { /* storage may be stubbed away */ }
  try { sessionStorage.clear(); } catch { /* storage may be stubbed away */ }
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (idb && typeof idb.databases === "function") {
    for (const { name } of await idb.databases()) if (name) idb.deleteDatabase(name);
  }
  for (const node of [...document.head.childNodes]) if (!headBefore.has(node)) node.remove();
  const html = document.documentElement;
  for (const { name } of [...html.attributes]) if (!htmlAttrsBefore.has(name)) html.removeAttribute(name);
  for (const [name, value] of htmlAttrsBefore) if (html.getAttribute(name) !== value) html.setAttribute(name, value);
  document.body.removeAttribute("style");
  document.body.className = "";
});

// Stores whose last listener left run their teardown on a 1s timer (better-auth's
// session store touches `window` there). Run them before jsdom goes away; see
// helpers/nanostoresCleanup.ts.
trackNanostoresUnmountTimers();
afterAll(() => { flushNanostoresUnmountTimers(); });
