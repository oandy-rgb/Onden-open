// Shared helpers for the real-browser fault-injection group (`@faults`).
//
// Everything here waits on observable state — a visible indicator, the server's
// copy of a note, or the contents of the app's own IndexedDB stores — never on a
// fixed sleep. The IndexedDB readers are read-only and never open a database
// that does not exist yet (opening it would create it empty at version 1 and
// the app's own upgrade would then never run).
import {
  type BrowserContext,
  type CDPSession,
  type Page,
  type TestInfo,
  type Locator,
  devices,
  expect,
  test,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import { BASE, H, openNoteEditor, ready } from "../helpers";

export const FAULTS_TAG = "@faults";
export { BASE };

/** Phone profile for the mobile variants. `defaultBrowserType` is dropped:
 *  Playwright refuses it inside a describe group, and Pixel is Chromium anyway. */
const { defaultBrowserType: _ignored, ...PIXEL_5 } = devices["Pixel 5"];
export const PHONE = PIXEL_5;

/** The group runs by default as its own Playwright project ("faults", see
 *  playwright.config.ts). `E2E_SKIP_FAULTS=1` leaves it out; the config then
 *  does not register the project at all, and this guard additionally skips the
 *  tests if one is run through some other project. Kept as a `beforeEach` hook
 *  so specs that already install it need no change. */
export function skipUnlessRequested({}: object, testInfo: TestInfo): void {
  test.skip(process.env.E2E_SKIP_FAULTS === "1", `fault-injection group skipped: E2E_SKIP_FAULTS=1 (${testInfo.project.name})`);
}

export const uniqueToken = (label: string): string =>
  `${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ── server truth ────────────────────────────────────────────────────────────

export async function seedNote(page: Page, markdown = "top line\n\nbottom line"): Promise<string> {
  const res = await page.request.post("/api/nodes", {
    ...H,
    data: { title: `Fault ${uniqueToken("n")}`, markdown },
  });
  expect(res.ok(), `seed note: ${res.status()}`).toBeTruthy();
  return (await res.json()).id as string;
}

/** The server's current body of a note ("" while it cannot be read). Uses the
 *  context's cookie jar, which per-page emulation and routes do not touch. */
export async function serverMarkdown(page: Page, id: string): Promise<string> {
  const res = await page.request.get(`/api/nodes/${id}`);
  if (!res.ok()) return "";
  return ((await res.json()).markdown as string | undefined) ?? "";
}

export async function expectServerHas(page: Page, id: string, texts: string[], timeout = 45_000): Promise<void> {
  await expect
    .poll(async () => {
      const body = await serverMarkdown(page, id);
      return texts.filter((t) => !body.includes(t));
    }, { timeout, message: `server copy of the note must contain ${texts.join(", ")}` })
    .toEqual([]);
}

// ── opening and typing ──────────────────────────────────────────────────────

export const editor = (page: Page): Locator => page.locator(".cm-content").first();

/** Open a note on desktop or phone and wait until the editor is usable. */
export async function openNote(page: Page, id: string): Promise<void> {
  await ready(page, `/?view=notes&node=${id}`);
  await openNoteEditor(page);
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
}

/** Type at the start or end of the body, then confirm the editor shows it. */
export async function typeInNote(page: Page, where: "start" | "end", text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.press(where === "start" ? "ControlOrMeta+Home" : "ControlOrMeta+End");
  await page.keyboard.type(text);
  await expect.poll(() => editor(page).innerText()).toContain(text);
}

// ── network faults ──────────────────────────────────────────────────────────

const emulation = new WeakMap<Page, CDPSession>();

/** Take ONE page offline (or back online) without touching the rest of the
 *  context. `context.setOffline` would cut every tab, but several scenarios need
 *  a second tab that stays online. The emulation lives as long as the CDP
 *  session, so the session is kept per page. */
export async function setPageOffline(page: Page, offline: boolean): Promise<void> {
  let cdp = emulation.get(page);
  if (!cdp) {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    emulation.set(page, cdp);
  }
  await cdp.send("Network.emulateNetworkConditions", {
    offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await page.evaluate((state) => window.dispatchEvent(new Event(state ? "offline" : "online")), offline);
}

/** The offline indicator in either layout: the desktop status dot or the phone
 *  top-bar badge (the phone shows no standing "connected" dot). */
export const offlineIndicator = (page: Page): Locator =>
  page.locator(".sync-status .status-dot.offline, .user-badge--offline").filter({ visible: true }).first();

// ── the app's own IndexedDB stores ──────────────────────────────────────────

/** Records in the write-ahead journal (queued writes the snapshot lacks). One
 *  record is one durable change, so a rise means a write reached disk and a
 *  drop to zero means a snapshot compaction covered them. */
export function journalEntryCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === "onden-journal")) return 0;
    return new Promise<number>((resolve, reject) => {
      const open = indexedDB.open("onden-journal");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("entries")) { db.close(); resolve(0); return; }
        const req = db.transaction("entries", "readonly").objectStore("entries").count();
        req.onsuccess = () => { db.close(); resolve(req.result); };
        req.onerror = () => { db.close(); reject(req.error); };
      };
    });
  });
}

/** A cheap fingerprint of every local snapshot (key + length + FNV-1a hash):
 *  changes exactly when a snapshot save lands, whichever tab wrote it. */
export function snapshotFingerprint(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === "onden-storage")) return "none";
    return new Promise<string>((resolve, reject) => {
      const open = indexedDB.open("onden-storage");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("sqlite")) { db.close(); resolve("none"); return; }
        const store = db.transaction("sqlite", "readonly").objectStore("sqlite");
        const keys = store.getAllKeys();
        const values = store.getAll();
        values.onsuccess = () => {
          const parts = (keys.result as IDBValidKey[]).map((key, i) => {
            const bytes = new Uint8Array(values.result[i] as ArrayBuffer);
            let hash = 0x811c9dc5;
            for (let j = 0; j < bytes.length; j++) hash = Math.imul(hash ^ bytes[j], 0x01000193);
            return `${String(key)}:${bytes.length}:${hash >>> 0}`;
          });
          db.close();
          resolve(parts.join("|") || "empty");
        };
        values.onerror = () => { db.close(); reject(values.error); };
      };
    });
  });
}

// ── persistent profile (page / context closed under the app) ────────────────

type StorageState = {
  cookies: Parameters<BrowserContext["addCookies"]>[0];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
};

/** Sign a persistent-profile context in with the suite's saved storage state.
 *  `launchPersistentContext` has no `storageState` option, so replay it. */
export async function signInPersistent(context: BrowserContext): Promise<void> {
  const file = process.env.E2E_STORAGE || "/tmp/pw-auth.json";
  const state = JSON.parse(readFileSync(file, "utf8")) as StorageState;
  await context.addCookies(state.cookies);
  const mine = state.origins.find((o) => o.origin === new URL(BASE).origin);
  if (mine) {
    await context.addInitScript((items) => {
      for (const { name, value } of items) {
        if (localStorage.getItem(name) === null) localStorage.setItem(name, value);
      }
    }, mine.localStorage);
  }
}

// ── the final check every scenario ends with ────────────────────────────────

/** Cold reload: a fresh tab (then a reload of it) must show every typed text,
 *  and the server must agree. Other tabs are closed first so nothing is
 *  answered from a live in-memory copy. */
export async function expectColdConvergence(
  context: BrowserContext,
  id: string,
  texts: string[],
  keepOpen: Page[] = [],
): Promise<void> {
  for (const open of context.pages()) if (!keepOpen.includes(open)) await open.close();
  const probe = await context.newPage();
  await expectServerHas(probe, id, texts);
  await openNote(probe, id);
  for (const pass of ["fresh tab", "after reload"]) {
    await expect
      .poll(() => editor(probe).innerText(), { message: `editor (${pass}) must show ${texts.join(", ")}` })
      .toEqual(expect.stringMatching(new RegExp(texts.map((t) => `(?=[\\s\\S]*${t})`).join(""))));
    if (pass === "fresh tab") await openNote(probe, id);
  }
  await expectServerHas(probe, id, texts);
}
