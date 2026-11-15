#!/usr/bin/env node
// Smoke test of the browser app in a real engine: open → write a note → reload → it is still there → export, and the
// friends-batch cases (docs/architecture/browser-app.md §3–§6): a change made right before a reload is not lost, an
// older saved copy is upgraded, a newer or un-upgradable one is left alone, a sub-path works, a newer build is offered,
// the help page and its report hold no note text.
//   node e2e/browser-app/smoke.mjs [chromium|mobile-chrome|webkit|mobile-safari] [--dir dist-browser] [--store indexeddb]
// --store indexeddb makes the app skip OPFS (the path Safari without usable file access takes) in any engine.
// Needs the `playwright` library and the engine's browser installed (npx playwright install webkit).
// What it proves is written in docs/architecture/browser-app.md §9; WebKit here is Playwright's build of
// WebKit, not an iPhone: it is the closest to iOS Safari that runs on Linux, not a replacement for a device.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { serve } from "./serve.mjs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();

const engineName = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "chromium";
const dirFlag = process.argv.indexOf("--dir");
const root = resolve(here, "../..", dirFlag > 0 ? process.argv[dirFlag + 1] : "dist-browser");
const site = await serve(root);
const sites = [site];
const server = { close: () => sites.forEach((s) => s.close()) };
const storeFlag = process.argv.indexOf("--store");
const wantedStore = storeFlag > 0 ? process.argv[storeFlag + 1] : null;
const base = site.base + (wantedStore ? `?store=${wantedStore}` : "");


const results = [];
const info = (name, ok, detail = "") => console.log(`${ok ? "INFO+" : "INFO-"} ${name}${detail ? `  (${detail})` : ""}`);
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const DEVICES = { chromium: "Desktop Chrome", "mobile-chrome": "Pixel 5", webkit: "Desktop Safari", "mobile-safari": "iPhone 13" };
const device = playwright.devices[DEVICES[engineName]];
if (!device) { console.log(`unknown engine ${engineName}: ${Object.keys(DEVICES).join(", ")}`); process.exit(2); }
const browserType = engineName.endsWith("chrome") || engineName === "chromium" ? playwright.chromium : playwright.webkit;
let browser;
try {
  browser = await browserType.launch();
} catch (error) {
  console.log(`SKIP  ${engineName}: the browser could not be started: ${String(error.message).split("\n")[0]}`);
  server.close();
  process.exit(2);
}
const errors = [];
const logs = [];
const SAMPLE_TEXT = "歡迎來到 Onden 試用版";

/** A fresh browser profile (empty storage) with the page; `dropFlush` lets a test stop the page's "save now" message,
 *  which is what a killed or suspended tab never gets to send. */
async function open({ permissions = [] } = {}) {
  const context = await browser.newContext({ ...device, locale: "zh-TW" });
  // WebKit knows no clipboard permissions (it fails at newPage, not here); it lets a page with the user's gesture use
  // the clipboard anyway, so only Chromium is given them.
  if (permissions.length && browserType === playwright.chromium) await context.grantPermissions(permissions).catch(() => {});
  await context.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (globalThis.__dropFlush && message && message.t === "flush") return undefined;
      return post.call(this, message, ...rest);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
  page.on("console", (message) => logs.push(message.text()));
  return { context, page };
}
/** The app's own "這次更新" card floats over dialogs for a while after a new build; it is closed like a person would. */
async function dismissWhatsNew(p) {
  const title = p.getByText("這次更新", { exact: true }).first();
  if (await title.isVisible().catch(() => false)) await title.locator("xpath=following-sibling::button").first().click().catch(() => {});
}
/** The avatar's menu: the desktop has the avatar chip in the top bar; the phone has the avatar on the notes list
 *  (the note that is open is left with its back button first). */
async function openAccountMenu(p) {
  await dismissWhatsNew(p);
  const chip = p.locator(".user-chip").first();
  // A phone with a note open shows the note's own top bar (no avatar): go back to the list, whose bar has it. The
  // note slides away first, and a back press made while the page is still settling can be lost, so try a few times.
  // On a phone the app can also open a note a moment after the list first shows, covering the avatar mid-click.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await chip.isVisible().catch(() => false)) {
      try { await chip.click({ timeout: 3_000 }); return; } catch { /* covered by a note that just opened: go back */ }
    }
    await p.getByRole("button", { name: "返回" }).first().click({ timeout: 3_000 }).catch(() => {});
    await chip.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  }
  await chip.click();
}
/** Settings: a computer has the gear at the end of the top bar; a phone has a row in the avatar's sheet. */
async function openSettings(p) {
  await dismissWhatsNew(p);
  const gear = p.locator(".app-topbar .topbar-settings");
  if (await gear.isVisible().catch(() => false)) { await gear.click(); return; }
  await openAccountMenu(p);
  await p.getByRole("button", { name: "設定", exact: true }).first().click();
}
/** The trial's panel lives where the app shows its save status: the avatar's menu, then the line that says the
 *  notes are only in this browser (no badge of its own; owner, 2026-11-02). */
async function openTrialPanel(p) {
  await openAccountMenu(p);
  await p.getByRole("button", { name: /只存在這個瀏覽器/ }).first().click();
}
const until = async (page, probe, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return true; await page.waitForTimeout(400); } return false; };
/** The worker is up and /api is bridged to it (a static server answers /api/… with 404 before that). */
const workerUp = (page) => until(page, () => page.evaluate(async () => { try { return (await fetch("/api/browser-app/state")).ok; } catch { return false; } }), 90_000);
const search = (page, word) => page.evaluate(async (q) => (await (await fetch(`/api/nodes/search?q=${encodeURIComponent(q)}`)).json()).length, word);
const saveState = (page) => page.evaluate(async () => (await fetch("/api/browser-app/state")).json());
const makeNote = (page, title) => page.evaluate(async (t) => (await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: t, markdown: "x" }) })).status, title);
const savedAll = (page) => until(page, async () => { const s = await saveState(page); return !s.unsaved && s.lastSavedAt !== null; });
const shot = (page, name) => page.screenshot({ path: join(here, `failed-${engineName}-${name}.png`) }).catch(() => {});

// ── The copy an older app left, planted in IndexedDB (the store the Safari path uses) ─────────────────────────────────
const backendDir = resolve(here, "../../../backend");
const made = {};
const copyDir = mkdtempSync(join(tmpdir(), "browser-app-smoke-")); // the older copies are made here, not in the repository
function oldCopy(mode) {
  if (!made[mode]) {
    const out = join(copyDir, `old-copy-${mode}.tar.gz`);
    const line = execFileSync("npx", ["tsx", "src/browser/makeOldCopy.ts", out, mode], { cwd: backendDir, encoding: "utf8" }).trim().split("\n").pop();
    made[mode] = { bytes: readFileSync(out), ...JSON.parse(line) };
  }
  return made[mode];
}
async function plantCopy(page, copy, schema) {
  await page.route("**/__copy.bin", (route) => route.fulfill({ body: copy.bytes, contentType: "application/octet-stream" }));
  await page.goto(`${site.base}favicon.svg`);
  await page.evaluate(async (meta) => {
    const bytes = await (await fetch("__copy.bin")).arrayBuffer();
    const request = indexedDB.open("onden-browser-app", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("copies"); };
    const db = await new Promise((ok, fail) => { request.onsuccess = () => ok(request.result); request.onerror = () => fail(request.error); });
    await new Promise((ok, fail) => {
      const transaction = db.transaction("copies", "readwrite");
      transaction.objectStore("copies").put({ bytes, type: "application/x-gzip", meta }, "database");
      transaction.oncomplete = ok;
      transaction.onerror = () => fail(transaction.error);
    });
    db.close();
  }, { journalSeq: 0, schema });
}
const storedCopy = (page) => page.evaluate(async () => {
  const request = indexedDB.open("onden-browser-app", 1);
  const db = await new Promise((ok, fail) => { request.onsuccess = () => ok(request.result); request.onerror = () => fail(request.error); });
  const saved = await new Promise((ok, fail) => { const get = db.transaction("copies").objectStore("copies").get("database"); get.onsuccess = () => ok(get.result); get.onerror = () => fail(get.error); });
  db.close();
  return saved ? { size: saved.bytes.byteLength, schema: saved.meta?.schema ?? "" } : null;
});

try {
  // ── 1. The basic round trip ──────────────────────────────────────────────────────────────────────────────────────────
  const { context, page } = await open({ permissions: ["clipboard-read", "clipboard-write"] });
  const t0 = Date.now();
  await page.goto(base);
  await page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
  check("opens and shows the sample notes", true, `${Date.now() - t0} ms`);
  // (the line sits in the avatar's menu since the notice moved into the app's own save status)
  await openAccountMenu(page);
  await page.getByRole("button", { name: /只存在這個瀏覽器/ }).first().waitFor({ timeout: 30_000 });
  check("says the data stays in this browser", true);
  await page.keyboard.press("Escape");

  // Write a note. A desktop window has the 建立 button of the notes list; a phone has the 捕捉 button of its bottom bar
  // (quick capture), which makes a note from a sentence. Both are the app's own way to write a note.
  const title = `冒煙測試 ${Date.now()}`;
  if (!engineName.startsWith("mobile")) {
    await page.waitForTimeout(2_000); // the app's first landing (on the welcome note) has settled, as it has for a person who reads before typing
    await page.getByRole("button", { name: "建立", exact: true }).first().click();
    // The button opens the create popover: 建立 there makes the note. (The app opens on the welcome note, so the
    // editor already on screen is NOT the new note: wait until the welcome note has made way for it.)
    await page.getByRole("dialog").getByRole("button", { name: "建立", exact: true }).click();
    await page.getByRole("heading", { name: "歡迎來到 Onden 試用版" }).waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
    const editor = page.locator(".cm-content").first();
    await editor.waitFor({ timeout: 20_000 });
    await editor.click();
    await page.keyboard.type(`# ${title}\n\n這是一則試用版的測試筆記。`);
  } else {
    await page.getByRole("button", { name: "捕捉", exact: true }).click();
    await page.getByPlaceholder("在想什麼？").fill(`${title}。這是一則試用版的測試筆記。`);
    await page.getByRole("button", { name: "儲存", exact: true }).click();
  }
  const needle = "試用版的測試筆記";
  const inDatabase = await until(page, async () => (await search(page, needle)) > 0);
  check("the new note is in the database", inDatabase);
  if (!inDatabase) await shot(page, "note");
  check("the browser's storage has caught up", await savedAll(page));
  const store = (await saveState(page)).store;
  check("a saved copy exists", wantedStore ? store === wantedStore : store === "opfs" || store === "indexeddb", `store: ${store}`);
  check("changes are also logged before they are applied (the journal is on)", (await saveState(page)).journal === true);

  const t1 = Date.now();
  await page.goto(base); // the app tidies unknown query parameters off the address, so the flag is sent again
  await page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
  check("the note is still there after a reload", (await search(page, needle)) >= 1, `reopened in ${Date.now() - t1} ms`);

  // ── 2. A change right before a reload is not lost (required) ─────────────────────────────────────────────────────────
  // The page's "save now" message is dropped, as if the tab were killed: only the journal can have the change.
  await page.evaluate(() => { globalThis.__dropFlush = true; });
  const quick = `急速重載 ${Date.now()}`;
  check("the write is acknowledged", (await makeNote(page, quick)) < 300);
  const afterAck = await saveState(page);
  info("right after the answer, the change is in no database copy yet (only in the journal)", afterAck.unsaved === true);
  await page.goto(base);
  await page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
  check("a change made just before an immediate reload survived", (await search(page, quick.slice(0, 4))) >= 1, afterAck.unsaved ? "journal path" : "copy path: the idle save came first");
  info("the page said a change was recovered", await page.getByText("找回了頁面關閉前最後的").first().isVisible().catch(() => false));
  const quickest = `連續兩次 ${Date.now()}`;
  await page.evaluate(() => { globalThis.__dropFlush = true; });
  await makeNote(page, `${quickest} 甲`); await makeNote(page, `${quickest} 乙`);
  await page.goto(base);
  await page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
  check("two changes right before a reload both survived, once each", (await search(page, quickest.slice(0, 4))) === 2);

  // 2 s after an edit is past the save's quiet period.
  const soon = `兩秒後重載 ${Date.now()}`;
  await makeNote(page, soon);
  await page.waitForTimeout(2_000);
  await page.goto(base);
  await page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
  check("a note made 2 s before a reload survived", (await search(page, soon.slice(0, 5))) >= 1);

  // ── 3. The trial notice, the help page and the report ────────────────────────────────────────────────────────────────
  await openTrialPanel(page);
  await page.getByText("你還沒有備份過").first().waitFor({ timeout: 10_000 });
  check("the notice says no backup has been made yet", true);
  const storageLine = await page.getByText(/瀏覽器(已答應|還沒答應|沒有說明)/).first().isVisible().catch(() => false);
  check("the notice says whether the browser keeps the data", storageLine);
  await dismissWhatsNew(page);
  await page.getByRole("button", { name: "說明與回報問題" }).click();
  await page.getByRole("heading", { name: "資料存在哪裡" }).waitFor({ timeout: 10_000 });
  check("the help page opens", true);
  await page.getByRole("button", { name: "複製診斷資訊" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  if (copied === null) info("the copied report was read back (this engine would not allow reading the clipboard)", false);
  else {
    check("the report says it holds no notes and names the browser and the storage", copied.includes("不含任何筆記內容") && copied.includes("瀏覽器：") && copied.includes("儲存方式："));
    check("the report holds none of the notes' text", !copied.includes("冒煙測試") && !copied.includes("歡迎來到") && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(copied));
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // ── 4. The sample notes go with one switch, and only they do ─────────────────────────────────────────────────────────
  const titles = () => page.evaluate(async () => ((await (await fetch("/api/bootstrap")).json()).nodes ?? []).map((n) => n.title));
  const before = await titles();
  const cleared = await page.evaluate(async () => (await (await fetch("/api/browser-app/clear-samples", { method: "POST" })).json()).cleared);
  const after = await titles();
  const samples = ["歡迎來到 Onden 試用版", "快速上手", "今天要做的事", "讀書筆記：作業系統", "資料存在哪裡", "範例", "讀書"];
  check("clearing the sample notes removes them (notes for good, tags to the trash)", cleared === samples.length && samples.every((t) => before.includes(t) && !after.includes(t)), `${cleared} removed`);
  check("clearing leaves the notes the person made", (await search(page, needle)) >= 1 && (await search(page, soon.slice(0, 5))) >= 1, `${await search(page, needle)} / ${await search(page, soon.slice(0, 5))}`);
  check("the worker no longer counts any sample notes", (await saveState(page)).sampleNotes === 0);

  // ── 5. Export ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const state = await saveState(page);
  console.log(`      last copy: ${state.lastCopyMs} ms, ${state.lastCopyBytes} bytes`);
  const exported = await page.evaluate(async () => {
    const response = await fetch("/api/backup/full.zip");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes);
    return { status: response.status, size: bytes.length, zip: bytes[0] === 0x50 && bytes[1] === 0x4b, entries: (text.match(/\.md/g) ?? []).length };
  });
  check("the full backup is a zip with notes in it", exported.status === 200 && exported.zip && exported.entries > 0, `${exported.size} bytes, ${exported.entries} .md names`);
  // The same backup with version history (format 3): a zip that names the history section, and the size it announced.
  const withHistory = await page.evaluate(async () => {
    const size = await (await fetch("/api/backup/history-size")).json();
    const response = await fetch("/api/backup/full.zip?history=1");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes);
    return { status: response.status, zip: bytes[0] === 0x50 && bytes[1] === 0x4b, files: (text.match(/\.onden\/history\/[0-9a-f-]{36}\.jsonl/g) ?? []).length, versions: size.versions };
  });
  check("the backup with version history is a zip with a history file per note", withHistory.status === 200 && withHistory.zip && withHistory.versions > 0 && withHistory.files > 0, JSON.stringify(withHistory));
  await context.close();

  // ── 5b. Backup → erase everything → restore ─────────────────────────────────────────────────────────────────────────
  {
    const o = await open();
    await o.page.goto(base);
    await o.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    const stamp = Date.now();
    await makeNote(o.page, `還原甲 ${stamp}`);
    await makeNote(o.page, `還原乙 ${stamp}`);
    check("two notes are saved before the backup", await savedAll(o.page));
    const zip = await o.page.evaluate(async () => Array.from(new Uint8Array(await (await fetch("/api/backup/full.zip")).arrayBuffer())));
    await openTrialPanel(o.page);
    await o.page.getByRole("button", { name: "重新開始" }).click();
    const reloaded = o.page.waitForEvent("load", { timeout: 90_000 });
    await o.page.getByRole("button", { name: "清除並重新開始" }).click();
    await reloaded;
    // The app tidies the test flag off the address, so its own reload used the browser's default store: open again with the flag.
    await o.page.goto(base);
    await o.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    await workerUp(o.page);
    check("starting over erased the notes", (await search(o.page, "還原甲")) === 0);
    const restored = await o.page.evaluate(async (bytes) => {
      const upload = await fetch("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(bytes) });
      if (!upload.ok) return { step: "upload", status: upload.status };
      const { upload_id: id } = await upload.json();
      const spaces = (await (await fetch("/api/spaces")).json()).spaces;
      const space = spaces.find((s) => s.is_default) ?? spaces[0];
      const apply = await fetch(`/api/backup/restore/${id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: space.id, mode: "merge" }) });
      if (apply.status !== 202 && apply.status !== 200) return { step: "apply", status: apply.status };
      const job = (await apply.json()).job.id;
      for (let i = 0; i < 100; i++) {
        const state = (await (await fetch(`/api/backup/restore/jobs/${job}`)).json()).job;
        if (state.status !== "running") return { step: "done", status: state.status };
        await new Promise((r) => setTimeout(r, 200));
      }
      return { step: "wait", status: "timeout" };
    }, zip);
    check("the backup restores", restored.step === "done" && restored.status === "done", JSON.stringify(restored));
    check("the restored notes are back", (await search(o.page, "還原甲")) === 1 && (await search(o.page, "還原乙")) === 1);
    check("and are saved", await savedAll(o.page));
    await o.page.goto(base);
    await o.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    check("and are still there after a reload", (await search(o.page, "還原甲")) === 1);
    await o.context.close();
  }

  // ── 5b2. Backup → start over → move the whole workspace into the fresh one ──────────────────────────────────────────
  // The fresh browser database holds only the sample notes, so it is "new": the move clears them and brings the
  // backup's notes (and their spaces, slugs and links) back as they were.
  {
    const o = await open();
    await o.page.goto(base);
    await o.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    const stamp = Date.now();
    await makeNote(o.page, `搬家甲 ${stamp}`);
    await makeNote(o.page, `搬家乙 ${stamp}`);
    check("two notes are saved before the move", await savedAll(o.page));
    const zip = await o.page.evaluate(async () => Array.from(new Uint8Array(await (await fetch("/api/backup/full.zip?history=1")).arrayBuffer())));
    await openTrialPanel(o.page);
    await o.page.getByRole("button", { name: "重新開始" }).click();
    const reloaded = o.page.waitForEvent("load", { timeout: 90_000 });
    await o.page.getByRole("button", { name: "清除並重新開始" }).click();
    await reloaded;
    await o.page.goto(base);
    await o.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    await workerUp(o.page);
    check("starting over erased the notes", (await search(o.page, "搬家甲")) === 0);
    const moved = await o.page.evaluate(async (bytes) => {
      const upload = await fetch("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(bytes) });
      if (!upload.ok) return { step: "upload", status: upload.status };
      const { upload_id: id } = await upload.json();
      const spaces = (await (await fetch("/api/spaces")).json()).spaces;
      const personal = spaces.find((s) => s.kind === "personal");
      if (!personal) return { step: "space", status: "no personal space" };
      const shown = await (await fetch(`/api/backup/restore/${id}/preview?space=${personal.id}&mode=workspace`)).json();
      if (shown.refusal) return { step: "preview", status: shown.refusal, spaces: spaces.map((s) => [s.name, s.kind, s.is_default, s.permission]), notes: await (await fetch("/api/nodes?limit=50")).json().then((r) => (r.nodes ?? r).map?.((n) => [n.title, n.node_type, n.source_type, n.hidden]) ?? r).catch((e) => String(e)) };
      const apply = await fetch(`/api/backup/restore/${id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: personal.id, mode: "workspace" }) });
      if (apply.status !== 202 && apply.status !== 200) return { step: "apply", status: apply.status };
      const job = (await apply.json()).job.id;
      for (let i = 0; i < 150; i++) {
        const state = (await (await fetch(`/api/backup/restore/jobs/${job}`)).json()).job;
        if (state.status !== "running") return { step: "done", status: state.status, cleared: state.result?.moved?.cleared, history: state.result?.moved?.history };
        await new Promise((r) => setTimeout(r, 200));
      }
      return { step: "wait", status: "timeout" };
    }, zip);
    check("the whole workspace moves into the fresh browser database", moved.step === "done" && moved.status === "done", JSON.stringify(moved));
    check("the moved notes are back", (await search(o.page, "搬家甲")) === 1 && (await search(o.page, "搬家乙")) === 1);
    check("the move carried the notes' version history, none of it failed", (moved.history?.versions ?? 0) > 0 && moved.history.failed.length === 0, JSON.stringify(moved.history));
    // The backup holds the old database's own sample notes, so they come back once with it; the fresh database's
    // samples were cleared first, so none is doubled.
    const samples = await o.page.evaluate(async (word) => (await (await fetch(`/api/nodes/search?q=${encodeURIComponent(word)}`)).json()).filter((n) => !n.deleted_at).map((n) => n.title), SAMPLE_TEXT);
    check("the fresh database's sample notes were cleared by the move, not doubled", samples.length > 0 && new Set(samples).size === samples.length, JSON.stringify(samples));
    check("and the move is saved", await savedAll(o.page));
    await o.context.close();
  }

  // ── 5c. Pictures and files: shown by the media Service Worker, kept in the browser's file space ───────────────────────
  {
    // A fresh profile: this load is the very first visit, so the Service Worker is installed while the page starts.
    const o = await open();
    const p = o.page;
    await p.goto(base);
    await p.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    check("the picture helper (Service Worker) is in charge of the page on the very first visit", await p.evaluate(() => !!navigator.serviceWorker?.controller));
    // A picture made in the page: a PNG, and a JPEG that carries a camera's rotation (stored 300×200, shown 200×300).
    const uploadPicture = (kind) => p.evaluate(async (what) => {
      const canvas = document.createElement("canvas");
      canvas.width = what === "rotated" ? 300 : 640; canvas.height = what === "rotated" ? 200 : 480;
      const context = canvas.getContext("2d");
      context.fillStyle = "#2a7"; context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise((done) => canvas.toBlob(done, what === "rotated" ? "image/jpeg" : "image/png"));
      let file = new File([blob], what === "rotated" ? "camera.jpg" : "shot.png");
      if (what === "rotated") {
        const jpeg = new Uint8Array(await blob.arrayBuffer());
        const exif = Uint8Array.from([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
        const out = new Uint8Array(jpeg.length + exif.length);
        out.set(jpeg.subarray(0, 2)); out.set(exif, 2); out.set(jpeg.subarray(2), 2 + exif.length);
        file = new File([out], "camera.jpg", { type: "image/jpeg" });
      }
      const form = new FormData(); form.append("file", file);
      const response = await fetch("/api/media", { method: "POST", body: form });
      return { status: response.status, ...(await response.json()) };
    }, kind);

    // Pasting into the editor (desktop); the phone layout has no open editor on its home screen, so there the same
    // picture goes in through the upload route and a note that shows it.
    let noteTitle = `PicNote ${Date.now()}`;
    if (!engineName.startsWith("mobile")) {
      await p.getByRole("button", { name: "建立", exact: true }).first().click();
      const editor = p.locator(".cm-content").first();
      await editor.waitFor({ timeout: 20_000 });
      await editor.click();
      await p.keyboard.type(`# ${noteTitle}\n\n`);
      await p.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 640; canvas.height = 480;
        const context = canvas.getContext("2d");
        context.fillStyle = "#2a7"; context.fillRect(0, 0, 640, 480);
        const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
        const data = new DataTransfer();
        data.items.add(new File([blob], "pasted.png", { type: "image/png" }));
        for (let i = 0; i < 50 && !document.querySelector(".cm-content"); i++) await new Promise((r) => setTimeout(r, 100)); // the editor may be re-mounted for a moment
        document.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      });
    } else {
      const made = await uploadPicture("plain");
      check("a picture is accepted by the upload route", made.status === 200 && /^\/api\/media\//.test(made.url), JSON.stringify({ status: made.status }));
      await p.evaluate(async ({ title, url }) => { await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, markdown: `![圖](${url})` }) }); }, { title: noteTitle, url: made.url });
      // The page learns of a note made through the API when it next starts: open the page again, then the note from the list.
      await p.goto(base);
      await p.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
      await p.getByRole("button", { name: "返回" }).first().click({ timeout: 3_000 }).catch(() => {});
      await p.getByText(noteTitle, { exact: true }).first().click();
    }
    // The note in the list, by the title the database gives it (a desktop "建立" lands in the day's note, whose title is the date).
    const openPicNote = async () => {
      const title = await p.evaluate(async () => (await (await fetch("/api/nodes/search?q=PicNote")).json())[0]?.title ?? null);
      await p.getByRole("button", { name: "返回" }).first().click({ timeout: 2_000 }).catch(() => {}); // the phone shows the note alone
      if (title) await p.getByText(title, { exact: true }).first().click({ timeout: 8_000 }).catch(() => {}); // already open: nothing to click
    };
    const shown = (page) => page.evaluate(() => [...document.querySelectorAll("img")].filter((i) => /\/api\/media\//.test(i.getAttribute("src") ?? "") || /\/api\/media\//.test(i.currentSrc)).map((i) => ({ w: i.naturalWidth, h: i.naturalHeight })));
    // The note's text reaches the database a moment after it is typed; a reload before that would drop it (as for any text).
    const noteHoldsPicture = () => p.evaluate(async () => {
      const found = await (await fetch("/api/nodes/search?q=PicNote")).json();
      return found.length > 0 && /\/api\/media\//.test((await (await fetch(`/api/nodes/${found[0].id}`)).json()).markdown ?? "");
    });
    check("the note holding the picture reached the database", await until(p, noteHoldsPicture, 30_000));
    const appeared = await until(p, async () => (await shown(p)).some((i) => i.w > 0), 30_000);
    check("the picture is shown in the note (it really loaded)", appeared, JSON.stringify(await shown(p)));
    if (!appeared) await shot(p, "picture");
    check("the picture and the note are saved", await savedAll(p));
    const usage = (await saveState(p)).media;
    check("the worker counts the stored file", usage.files >= 1 && usage.bytes > 0, JSON.stringify(usage));
    await p.goto(base);
    await p.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    await openPicNote();
    check("after a reload the picture is still shown", await until(p, async () => (await shown(p)).some((i) => i.w > 0), 30_000), JSON.stringify(await shown(p)));

    // The camera's rotation is applied, and the file is stored upright and re-encoded.
    const rotated = await uploadPicture("rotated");
    const dimensions = await p.evaluate(async (url) => {
      const response = await fetch(url);
      const bitmap = await createImageBitmap(await response.blob());
      return { type: response.headers.get("content-type"), w: bitmap.width, h: bitmap.height };
    }, rotated.url);
    check("a photo with a camera rotation is stored upright", dimensions.w === 200 && dimensions.h === 300, JSON.stringify(dimensions));
    check("an upload of a type the app does not know is refused, not stored", await p.evaluate(async () => {
      const form = new FormData(); form.append("file", new File(["MZ"], "run.exe"));
      return (await fetch("/api/media", { method: "POST", body: form })).status;
    }) === 400);

    // Range requests (audio and video seek with them) and a file that is not there.
    const range = await p.evaluate(async (url) => { const r = await fetch(url, { headers: { Range: "bytes=0-9" } }); return { status: r.status, size: (await r.arrayBuffer()).byteLength }; }, rotated.url);
    check("a byte range of a file is answered (so audio and video can seek)", range.status === 206 && range.size === 10, JSON.stringify(range));
    check("a file that does not exist is a 404", await p.evaluate(async () => (await fetch("/api/media/00000000000000000000000000000000.png")).status) === 404);
    check("the browser's own request for a picture goes through the Service Worker", await p.evaluate(async (url) => {
      const image = new Image(); image.src = url; await image.decode(); return image.naturalWidth > 0;
    }, rotated.url));
    check("the Service Worker leaves other requests alone", await p.evaluate(async () => (await fetch("favicon.svg")).headers.get("content-type")?.includes("svg") ?? false));

    // A backup holds the files; starting over erases them; restoring brings them back.
    check("everything is saved before the backup", await savedAll(p));
    const backup = await p.evaluate(async () => {
      const bytes = new Uint8Array(await (await fetch("/api/backup/full.zip")).arrayBuffer());
      return { bytes: Array.from(bytes), attachments: (new TextDecoder("latin1").decode(bytes).match(/attachments\/[0-9a-f]{32}\.\w+/g) ?? []).length };
    });
    check("the backup holds the picture files (attachments/)", backup.attachments >= 2, `${backup.attachments} names`);
    await openTrialPanel(p);
    await p.getByRole("button", { name: "重新開始" }).click();
    const reloaded = p.waitForEvent("load", { timeout: 90_000 });
    await p.getByRole("button", { name: "清除並重新開始" }).click();
    await reloaded;
    await p.goto(base);
    await p.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    await workerUp(p);
    check("starting over erased the stored files too", (await saveState(p)).media.files === 0);
    const restored = await p.evaluate(async (bytes) => {
      const upload = await fetch("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(bytes) });
      if (!upload.ok) return { step: "upload", status: upload.status, body: await upload.text() };
      const { upload_id: id } = await upload.json();
      const spaces = (await (await fetch("/api/spaces")).json()).spaces;
      const space = spaces.find((s) => s.is_default) ?? spaces[0];
      const apply = await fetch(`/api/backup/restore/${id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: space.id, mode: "merge" }) });
      if (apply.status !== 202 && apply.status !== 200) return { step: "apply", status: apply.status };
      const job = (await apply.json()).job.id;
      for (let i = 0; i < 150; i++) {
        const state = (await (await fetch(`/api/backup/restore/jobs/${job}`)).json()).job;
        if (state.status !== "running") return { step: "done", status: state.status, error: state.error };
        await new Promise((r) => setTimeout(r, 200));
      }
      return { step: "wait", status: "timeout" };
    }, backup.bytes);
    check("a backup with pictures restores", restored.step === "done" && restored.status === "done", JSON.stringify(restored));
    check("the restored files are back in the browser's file space", (await saveState(p)).media.files >= 1, JSON.stringify((await saveState(p)).media));
    check("the restore is saved", await savedAll(p));
    await p.goto(base);
    await p.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    // The restore went through the API, not the settings screen, so the note list on the page is not refreshed by it:
    // what is checked is the restored note's own picture, loaded by the browser the way an <img> does.
    const restoredPicture = await p.evaluate(async () => {
      // The search index catches up with a restore in the background: ask again for a while before giving up.
      let url;
      for (let i = 0; i < 25 && !url; i++) {
        const found = await (await fetch("/api/nodes/search?q=PicNote")).json();
        const markdown = found.length ? (await (await fetch(`/api/nodes/${found[0].id}`)).json()).markdown ?? "" : "";
        url = /\/api\/media\/[\w.]+/.exec(markdown)?.[0];
        if (!url) await new Promise((r) => setTimeout(r, 400));
      }
      if (!url) return { url: null, w: 0 };
      const image = new Image(); image.src = url; await image.decode();
      return { url: true, w: image.naturalWidth };
    });
    check("the restored note's picture loads (the browser's own request, answered from the restored file)", restoredPicture.url === true && restoredPicture.w === 640, JSON.stringify(restoredPicture));
    await o.context.close();
  }

  // ── 5d. Leaving at once after typing loses nothing; "done" means saved; the trial says the truth (docs/architecture/browser-app.md §16) ──
  {
    const phone = engineName.startsWith("mobile");
    const stamp = Date.now();
    const reload0 = async (p) => { await p.goto(base); await p.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 }); }; // no waiting: the leave is as abrupt as it gets
    const foundSoon = (p, word) => until(p, async () => (await search(p, word)) > 0, 60_000);
    const panelGone = (p) => until(p, async () => (await p.getByText("這筆變更無法儲存").count()) === 0, 30_000);
    const editorOf = async (p) => { const editor = p.locator(".cm-content").first(); await editor.waitFor({ timeout: 20_000 }); await editor.click(); return editor; };
    const fresh = async () => {
      const o = await open();
      await o.page.goto(base);
      await o.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
      await o.page.waitForTimeout(2_000); // the first sync of the page has run; typing starts after it, like a person's
      await dismissWhatsNew(o.page);
      return o;
    };

    // A new note: typed, then the page is reloaded in the same breath (the phone has no "create" dialog; its notes open in the day note).
    {
      const o = await fresh();
      const word = `新筆記零秒${stamp}`;
      if (!phone) {
        await o.page.getByRole("button", { name: "建立", exact: true }).first().click();
        await o.page.waitForTimeout(500);
        await o.page.getByRole("button", { name: "建立", exact: true }).last().click();
      }
      await editorOf(o.page);
      await o.page.keyboard.type(`# 標題${stamp}\n\n${word}`);
      await reload0(o.page);
      check(`${phone ? "text typed in a note" : "a new note with its text"}, reloaded at once (0 s), is back`, await foundSoon(o.page, word));
      check("and nothing is left in the recovery panel", await panelGone(o.page));
      await o.context.close();
    }
    // Text added at the end of an existing note.
    {
      const o = await fresh();
      const word = `尾端零秒${stamp}`;
      if (!phone) await o.page.getByText("快速上手").first().click();
      await editorOf(o.page);
      await o.page.keyboard.press("Control+End");
      await o.page.keyboard.type(` ${word}`);
      await reload0(o.page);
      check("text added at the end of a note, reloaded at once (0 s), is back", await foundSoon(o.page, word));
      await o.context.close();
    }
    // A burst of forty words and the tab is closed; a new tab is opened.
    {
      const o = await fresh();
      const words = Array.from({ length: 40 }, (_, i) => `連打${i}x${stamp}`);
      await editorOf(o.page);
      await o.page.keyboard.type(words.join(" "), { delay: 0 });
      const next = await o.context.newPage();
      await o.page.close();
      await next.goto(base);
      await next.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
      check("forty words typed in a burst, tab closed at once, are in the new tab", await foundSoon(next, words[39]));
      check("including the first word", (await search(next, words[0])) > 0);
      await o.context.close();
    }
    // What an earlier page left on its way out is written back by itself, into its own note, without making another one.
    {
      const o = await fresh();
      const target = await o.page.evaluate(async () => { const n = (await (await fetch("/api/bootstrap")).json()).nodes.find((x) => x.title === "快速上手"); return { id: n.id, markdown: n.markdown ?? "" }; });
      const word = `留在面板${stamp}`;
      const countNotes = () => o.page.evaluate(async () => (await (await fetch("/api/bootstrap")).json()).nodes.filter((n) => !/^\d{4}-\d{2}-\d{2}$/.test(n.title)).length);
      const before = await countNotes();
      await o.page.evaluate(({ id, markdown, word }) => {
        const key = Object.keys(localStorage).find((k) => k.includes(":account-v1:")).replace(/^[^:]+/, "onden.lostWrites");
        const entry = { method: "PATCH", path: `/api/nodes/${id}`, body: JSON.stringify({ markdown: `${markdown}\n${word}`, base_markdown: markdown }), idemKey: crypto.randomUUID(), id: crypto.randomUUID(), text: word, at: Date.now(), life: "an-earlier-page-load", exited: true };
        localStorage.setItem(key, JSON.stringify([entry]));
      }, { ...target, word });
      await reload0(o.page);
      check("a change an earlier page left unanswered is written into its own note by the next start", await foundSoon(o.page, word));
      check("and no other note was made for it", (await countNotes()) === before);
      check("and the recovery panel is empty", await panelGone(o.page));
      await o.context.close();
    }
    // A folder import and a restore, each followed at once by a reload that never gets to say "save now".
    {
      const o = await fresh();
      await o.page.evaluate(() => { globalThis.__dropFlush = true; });
      const imported = await o.page.evaluate(async (tag) => {
        const files = Array.from({ length: 40 }, (_, i) => ({ path: `匯入${tag}/筆記 ${i}.md`, content: `# 筆記 ${i}\n\n匯入內文${tag}n${i}\n` }));
        const response = await fetch("/api/import/obsidian", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files, upsert: true, source: { id: "00000000-0000-4000-8000-0000000000a1", name: "smoke" } }) });
        return { status: response.status, imported: (await response.json()).imported };
      }, String(stamp));
      check("a folder import answers done", imported.status === 200 && imported.imported === 40, JSON.stringify(imported));
      await reload0(o.page);
      check("the imported notes are still there after an immediate reload", await foundSoon(o.page, `匯入內文${stamp}n39`) && (await search(o.page, `匯入內文${stamp}n0`)) > 0);
      await o.context.close();
    }
    {
      const o = await fresh();
      const tag = `還原後零秒${stamp}`;
      await makeNote(o.page, tag);
      check("a note is saved before the backup that holds it", await savedAll(o.page));
      const zip = await o.page.evaluate(async () => Array.from(new Uint8Array(await (await fetch("/api/backup/full.zip")).arrayBuffer())));
      const names = await o.page.evaluate((bytes) => new TextDecoder("latin1").decode(new Uint8Array(bytes)), zip);
      await o.page.evaluate(async () => { await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "2031-03-04", markdown: "" }) }); });
      const names2 = await o.page.evaluate(async () => Array.from(new Uint8Array(await (await fetch("/api/backup/full.zip")).arrayBuffer())));
      const emptyDays = await o.page.evaluate(async () => (await (await fetch("/api/bootstrap")).json()).nodes.filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n.title) && !(n.markdown ?? "").trim()).map((n) => n.title));
      check("the backup holds no empty tag pages (tag-….md); their data stays in .onden/", !/tag-[\w-]+\.md/.test(names) && names.includes(".onden/"));
      check("the backup holds no empty day note the app made by itself", emptyDays.includes("2031-03-04") && !new TextDecoder("latin1").decode(new Uint8Array(names2)).includes("2031-03-04.md"), emptyDays.join(","));
      await openTrialPanel(o.page);
      await o.page.getByRole("button", { name: "重新開始" }).click();
      const reloaded = o.page.waitForEvent("load", { timeout: 90_000 });
      await o.page.getByRole("button", { name: "清除並重新開始" }).click();
      await reloaded;
      await o.page.goto(base);
      await o.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
      await workerUp(o.page);
      check("starting over is the person's choice: no \"your notes are gone\" notice", !(await o.page.getByText("這個瀏覽器裡的筆記不見了").first().isVisible().catch(() => false)));
      await o.page.evaluate(() => { globalThis.__dropFlush = true; });
      const done = await o.page.evaluate(async (bytes) => {
        const upload = await fetch("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(bytes) });
        const { upload_id: id } = await upload.json();
        const space = ((await (await fetch("/api/spaces")).json()).spaces).find((s) => s.is_default) ?? (await (await fetch("/api/spaces")).json()).spaces[0];
        const apply = await fetch(`/api/backup/restore/${id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: space.id, mode: "merge" }) });
        const job = (await apply.json()).job.id;
        for (let i = 0; i < 150; i++) {
          const state = (await (await fetch(`/api/backup/restore/jobs/${job}`)).json()).job;
          if (state.status !== "running") return state.status;
          await new Promise((r) => setTimeout(r, 100));
        }
        return "timeout";
      }, zip);
      check("the restore says done", done === "done", done);
      const sayingDone = await saveState(o.page);
      check("when it says done, the restored notes are already in the browser's storage", sayingDone.unsaved === false, JSON.stringify({ unsaved: sayingDone.unsaved }));
      await reload0(o.page); // at once, and the page's "save now" never arrives
      check("the restored note survives an immediate reload", await foundSoon(o.page, tag.slice(0, 7)));
      await o.context.close();
    }
    // Notes that went missing from the browser are not passed over in silence (Chromium: the engine's own clear-site-data).
    if (browserType === playwright.chromium) {
      const [what, types] = wantedStore === "indexeddb" ? ["the browser's database store is cleared", "indexeddb"] : ["the file space (OPFS) alone is cleared", "file_systems"];
      {
        const o = await fresh();
        await makeNote(o.page, `會被清掉${stamp}`);
        check(`(${what}) a copy is saved first`, await savedAll(o.page));
        const session = await o.context.newCDPSession(o.page);
        await o.page.goto("about:blank");
        await session.send("Storage.clearDataForOrigin", { origin: new URL(base).origin, storageTypes: types });
        await o.page.goto(base);
        await o.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
        check(`(${what}) the person is told their notes are gone, once, and pointed at the restore`, await o.page.getByText("這個瀏覽器裡的筆記不見了").first().waitFor({ timeout: 30_000 }).then(() => true, () => false));
        check(`(${what}) the sample notes are what is shown, not the lost ones`, (await search(o.page, "會被清掉")) === 0);
        await o.page.getByRole("button", { name: "從備份還原" }).click();
        check("the restore button opens the backup settings", await o.page.getByText("從備份還原", { exact: true }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false));
        await o.page.keyboard.press("Escape");
        await o.page.waitForTimeout(1_000); // the settings are closing; a navigation in the middle of that is aborted by the page's own one
        await reload0(o.page);
        await o.page.waitForTimeout(1_500);
        check(`(${what}) the notice does not come back once the browser holds a copy again`, !(await o.page.getByText("這個瀏覽器裡的筆記不見了").first().isVisible().catch(() => false)));
        await o.context.close();
      }
    } else info("clear-site-data cases (they need the Chromium DevTools protocol)", false);
    // Where the notes are kept, said truthfully; the download says what it made; backups hold no system tag pages.
    {
      const o = await fresh();
      await openSettings(o.page);
      await o.page.getByText("資料與備份", { exact: true }).first().click();
      await o.page.getByText("筆記存在哪", { exact: true }).first().waitFor({ timeout: 15_000 });
      const body = await o.page.locator("body").innerText();
      check("settings say the notes are in this browser and clearing the data erases them", /這台裝置上：這個瀏覽器/.test(body) && /清除網站資料會將它刪除/.test(body));
      check("settings do not say the notes are on a server, nor \"Synced\" / \"Connected\"", !/伺服器上|還在伺服器|已同步|已連線/.test(body), body.match(/.{0,20}(伺服器上|已同步|已連線).{0,20}/)?.[0] ?? "");
      const [download] = await Promise.all([o.page.waitForEvent("download", { timeout: 20_000 }).catch(() => null), o.page.getByRole("link", { name: "下載" }).first().click()]);
      check("the settings download makes a backup file", !!download && /^onden-backup-.*\.zip$/.test(download.suggestedFilename()));
      check("and the page says it was downloaded, by name", await o.page.getByText(/已下載「onden-backup-.*\.zip」/).first().waitFor({ timeout: 15_000 }).then(() => true, () => false));
      await o.context.close();
    }
  }

  // ── 6. An older saved copy is upgraded; nothing is lost ──────────────────────────────────────────────────────────────
  {
    const copy = oldCopy("old");
    const o = await open();
    await plantCopy(o.page, copy, copy.last);
    await o.page.goto(`${site.base}?store=indexeddb`);
    check("an older saved copy opens", await workerUp(o.page), `copy made with ${copy.applied} migrations, app has ${copy.latest}`);
    check("the notes of the older copy are all there", (await search(o.page, "舊版留下的筆記")) === 2);
    check("a note an older app had put on read-later is still there, its tag now an ordinary tag", (await search(o.page, "舊版稍後讀的文章")) === 1
      && await o.page.evaluate(async () => { const text = await (await fetch("/api/tags")).text(); return text.includes("read-later") && !text.includes("read_later"); }));
    // Migrations 195 and 196: a note and a paragraph that were review cards through the old module tag are cards of their own now.
    check("the old copy's two review cards (a note, a paragraph) are still in the review queue", (await search(o.page, "舊版複習的卡片")) === 1
      && await o.page.evaluate(async () => {
        const queue = await (await fetch("/api/review/queue")).json();
        return queue.total === 2 && queue.cards.some((card) => card.block !== null) && queue.cards.some((card) => card.block === null);
      }));
    check("the upgraded copy no longer has a review module tag, but keeps the note it was on", await o.page.evaluate(async () => {
      const tags = await (await fetch("/api/tags")).json();
      return !JSON.stringify(tags).includes('"schema_module":"review"');
    }));
    // Migration 201: the capture inbox tag and the spaces an older app made had random ids; they have computed ones now, and the note is still in the inbox.
    const computed = await o.page.evaluate(async () => {
      const derived = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
      const tags = await (await fetch("/api/tags")).json();
      const inbox = (Array.isArray(tags) ? tags : tags.tags ?? []).find((tag) => (tag.name ?? tag.title ?? tag.path) === "收件匣");
      // (a shared space somebody made by hand keeps its random id: only the default and personal ones are made by the app itself)
      const spaces = ((await (await fetch("/api/spaces")).json()).spaces ?? []).filter((space) => space.kind === "personal" || space.is_default);
      return { inboxFound: !!inbox, inboxComputed: !!inbox && derived(inbox.id), spaces: spaces.length, spacesComputed: spaces.filter((space) => derived(space.id)).length };
    });
    check("the old copy's capture inbox keeps its note, and its tag and the spaces now have computed ids",
      (await search(o.page, "舊版收件匣的筆記")) === 1 && computed.inboxComputed && computed.spaces >= 2 && computed.spacesComputed === computed.spaces, JSON.stringify(computed));
    check("the start reports the upgrade", copy.leftOut >= 1 && logs.some((line) => line.includes(`upgraded ${copy.leftOut},`)), logs.filter((l) => l.includes("[browser-app]")).slice(-1)[0] ?? "");
    check("the upgraded copy replaced the old one in storage", await until(o.page, async () => (await storedCopy(o.page))?.schema === copy.latest), JSON.stringify(await storedCopy(o.page)));
    await o.page.goto(`${site.base}?store=indexeddb`);
    check("the upgraded copy opens again, without upgrading", (await workerUp(o.page)) && (await search(o.page, "舊版留下的筆記")) === 2);
    await o.context.close();
  }

  // ── 7. A copy made by a newer app is refused and left as it was ──────────────────────────────────────────────────────
  {
    const copy = oldCopy("newer");
    const o = await open();
    await plantCopy(o.page, copy, "999_from_a_newer_app");
    const planted = await storedCopy(o.page);
    await o.page.goto(`${site.base}?store=indexeddb`);
    await o.page.getByText("這份資料比這個版本新").first().waitFor({ timeout: 90_000 });
    check("a copy from a newer app is refused with an explanation", true);
    await o.page.waitForTimeout(1_500);
    const kept = await storedCopy(o.page);
    check("the refused copy was not changed", kept?.size === planted.size && kept?.schema === planted.schema);
    await o.context.close();
  }

  // ── 8. An upgrade that fails leaves the old copy and offers it for download ──────────────────────────────────────────
  {
    const copy = oldCopy("poisoned");
    const o = await open();
    await plantCopy(o.page, copy, copy.last);
    const planted = await storedCopy(o.page);
    await o.page.goto(`${site.base}?store=indexeddb`);
    await o.page.getByText("資料升級沒有成功").first().waitFor({ timeout: 90_000 });
    check("an upgrade that fails is explained", true);
    const [download] = await Promise.all([o.page.waitForEvent("download"), o.page.getByRole("button", { name: "下載舊資料" }).click()]);
    const path = await download.path();
    check("the old data can be downloaded, byte for byte", path !== null && readFileSync(path).length === planted.size, `${planted.size} bytes`);
    const kept = await storedCopy(o.page);
    check("the failed upgrade left the stored copy as it was", kept?.size === planted.size && kept?.schema === planted.schema);
    await o.context.close();
  }

  // ── 9. A sub-path, as on GitHub Pages ────────────────────────────────────────────────────────────────────────────────
  {
    const sub = await serve(root, { prefix: "/onden-trial/" });
    sites.push(sub);
    const o = await open();
    await o.page.goto(sub.base);
    await o.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    check("opens from a sub-path", true, sub.base);
    const word = `子路徑 ${Date.now()}`;
    await makeNote(o.page, word);
    check("a note is saved there", await savedAll(o.page));
    await o.page.goto(sub.base);
    await o.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    check("and is still there after a reload", (await search(o.page, word.slice(0, 3))) >= 1);
    // A picture from a sub-path: the page's address for it is the absolute /api/media/…, which only the Service Worker can answer.
    const subPicture = await o.page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 40; canvas.height = 30;
      canvas.getContext("2d").fillRect(0, 0, 40, 30);
      const form = new FormData(); form.append("file", new File([await new Promise((done) => canvas.toBlob(done, "image/png"))], "sub.png"));
      const { url } = await (await fetch("/api/media", { method: "POST", body: form })).json();
      const image = new Image(); image.src = url; await image.decode();
      return { url, w: image.naturalWidth, controlled: !!navigator.serviceWorker?.controller };
    });
    check("a picture is shown from a sub-path too (the Service Worker answers the absolute address)", subPicture.controlled && subPicture.w === 40, JSON.stringify(subPicture));
    await o.context.close();
  }

  // ── 10. A newer build is offered ─────────────────────────────────────────────────────────────────────────────────────
  {
    const newer = await serve(root, { buildId: "a-newer-build" });
    const same = await serve(root);
    sites.push(newer, same);
    const o = await open();
    await o.page.goto(newer.base);
    check("a newer published build is offered for reload", await o.page.getByText("有新版，重新載入").first().waitFor({ timeout: 90_000 }).then(() => true, () => false));
    await o.context.close();
    const p = await open();
    await p.page.goto(same.base);
    await p.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    await p.page.waitForTimeout(2_000);
    check("no reload is offered when the build is the same", !(await p.page.getByText("有新版，重新載入").first().isVisible().catch(() => false)));
    await p.context.close();
  }

  // ── 11. A temporary session (?temp=1): nothing stays in the browser, an ordinary session's data is not touched ──────────
  {
    const TEMP = `${site.base}?temp=1`;
    /** Everything the page's origin keeps in this browser, as plain data (read from a page that is NOT a temporary session). */
    const inventory = (page) => page.evaluate(async () => {
      const files = [];
      const walk = async (dir, prefix) => {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === "directory") await walk(handle, `${prefix}${name}/`);
          else files.push(`${prefix}${name}:${(await handle.getFile()).size}`);
        }
      };
      await walk(await navigator.storage.getDirectory(), "");
      const databases = (await indexedDB.databases()).map((d) => d.name).sort();
      const journal = databases.includes("onden-browser-journal") ? await new Promise((ok) => {
        const open = indexedDB.open("onden-browser-journal");
        // The ordinary session's own journal changes by itself now and then; what matters is whether the temporary session's writing ("課堂") is in it.
        open.onsuccess = () => { const all = open.result.transaction("entries").objectStore("entries").getAll(); all.onsuccess = () => { open.result.close(); ok(all.result.filter((e) => new TextDecoder().decode(e.body ?? new ArrayBuffer(0)).includes("課堂") || String(e.path).includes("課堂")).length); }; };
        open.onerror = () => ok(-1);
      }) : 0;
      return { files: files.sort(), databases, journalHoldsSession: journal, local: JSON.stringify(Object.entries(localStorage).sort()), caches: (await caches.keys()).sort(), cookie: document.cookie };
    });
    const pdf = (text) => `%PDF-1.4\n% ${text}\n`;
    const writeThings = (page, stamp) => page.evaluate(async ({ stamp, pdfText }) => {
      const form = new FormData(); form.append("file", new File([pdfText], "slides.pdf", { type: "application/pdf" }));
      const upload = await fetch("/api/media", { method: "POST", body: form });
      const { url } = await upload.json();
      const post = (body) => fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const lecture = await (await post({ title: `課堂 ${stamp}`, markdown: `今天講的內容。\n\n[講義](${url})\n` })).json();
      const child = await (await post({ title: `小抄 ${stamp}`, markdown: "一小段。", parent_id: lecture.id ?? lecture.node?.id })).json();
      return { upload: upload.status, url, lecture: lecture.id ?? lecture.node?.id, child: child.id ?? child.node?.id };
    }, { stamp, pdfText: pdf(stamp) });

    // The ordinary session first: it has notes and a saved copy, which the temporary one must leave exactly as they are.
    const ordinary = await open();
    await ordinary.page.goto(base);
    await ordinary.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    await workerUp(ordinary.page);
    await makeNote(ordinary.page, `平常的筆記 ${Date.now()}`);
    check("(temporary) the ordinary session has saved its own notes first", await savedAll(ordinary.page));
    const before = await inventory(ordinary.page);
    check("(temporary) the ordinary session keeps a copy, a journal and a media folder to compare", before.files.length > 0 && before.databases.length > 0, JSON.stringify({ files: before.files.length, databases: before.databases }));

    // A temporary session in the same browser (the ordinary tab stays open: it holds the tab lock, which this one does not need).
    const stamp = String(Date.now());
    const temp = await ordinary.context.newPage();
    temp.on("pageerror", (error) => errors.push(`(temporary) ${error.message}`));
    await temp.goto(TEMP);
    check("(temporary) the worker starts without the ordinary session's lock", await workerUp(temp));
    const state = await saveState(temp);
    check("(temporary) it says it is temporary and keeps nothing", state.temporary === true && state.store === "none" && state.media.store === "none", JSON.stringify({ temporary: state.temporary, store: state.store, media: state.media }));
    check("(temporary) no sample notes", (await search(temp, SAMPLE_TEXT)) === 0);
    check("(temporary) an empty workspace with one blank note", (await search(temp, "未命名")) === 1);
    check("(temporary) the page's storage is memory only", await temp.evaluate(async () => {
      localStorage.setItem("probe", "1"); sessionStorage.setItem("probe", "1");
      return typeof indexedDB === "undefined" && typeof caches === "undefined" && navigator.storage.getDirectory === undefined && localStorage.getItem("probe") === "1";
    }));
    check("(temporary) the app shows the sentence in the account menu", await (async () => { await openAccountMenu(temp); return temp.getByRole("button", { name: /不會留在這台電腦/ }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false); })());
    await temp.keyboard.press("Escape");

    const wrote = await writeThings(temp, stamp);
    check("(temporary) a note with a child and an uploaded file are written", wrote.upload === 200 && !!wrote.lecture && !!wrote.child, JSON.stringify(wrote));
    check("(temporary) the file is kept in memory", (await saveState(temp)).media.files === 1);
    await temp.waitForTimeout(2_500); // longer than the ordinary session's save delay: a copy would have been written by now
    check("(temporary) nothing was saved (no copy was ever made)", (await saveState(temp)).lastSavedAt === null);
    const after = await inventory(ordinary.page);
    check("(temporary) the ordinary session's stored data is exactly as it was (files, databases, journal, preferences, caches)", JSON.stringify(after) === JSON.stringify(before), JSON.stringify(Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => ({ k, before: before[k], after: after[k] }))).slice(0, 900));

    // Leaving: the browser's own question while there is writing that was not downloaded.
    const asked = [];
    temp.on("dialog", async (dialog) => { asked.push(dialog.type()); await dialog.dismiss().catch(() => {}); });
    await temp.mouse.click(5, 5); // the page needs a gesture before it may ask
    await temp.close({ runBeforeUnload: true }).catch(() => {});
    await ordinary.page.waitForTimeout(1_500); // the question reaches the handler a moment after close() returns
    check("(temporary) closing the tab with writing that was not downloaded asks first", asked.includes("beforeunload"), asked.join(","));
  }

  // The same, in a profile with nothing in it, and then every kind of persistent storage is listed.
  {
    const o = await open();
    const stamp = String(Date.now() + 1);
    await o.page.goto(`${site.base}?temp=1`);
    await workerUp(o.page);
    const wrote = await o.page.evaluate(async ({ stamp, pdfText }) => {
      const form = new FormData(); form.append("file", new File([pdfText], "slides.pdf", { type: "application/pdf" }));
      const { url } = await (await fetch("/api/media", { method: "POST", body: form })).json();
      const post = (body) => fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const lecture = await (await post({ title: `課堂 ${stamp}`, markdown: `講義 [檔案](${url})` })).json();
      await post({ title: `小抄 ${stamp}`, markdown: "x", parent_id: lecture.id ?? lecture.node?.id });
      return url;
    }, { stamp, pdfText: `%PDF-1.4\n% ${stamp}\n` });
    check("(temporary) a fresh profile: a note and a file are written", !!wrote);
    await o.page.waitForTimeout(2_500);

    // Download what was written (the notice's button) and look inside.
    await openAccountMenu(o.page);
    await o.page.locator("button.sync-status--btn").first().click(); // the save line (the avatar button carries the same words as its badge)
    const download = o.page.waitForEvent("download", { timeout: 30_000 });
    await o.page.getByRole("button", { name: "下載我寫的內容" }).click();
    const file = await download;
    const zipPath = join(copyDir, "temporary-session.zip");
    await file.saveAs(zipPath);
    const zipText = readFileSync(zipPath).toString("latin1");
    const noteEntries = zipText.match(/\.onden\/notes\/[0-9a-f-]{36}\.json/g) ?? [];
    const noteCount = new Set(noteEntries).size;
    const attachments = new Set(zipText.match(/attachments\/[0-9a-f]{32}\.pdf/g) ?? []).size;
    check("(temporary) the download holds the two written notes and the file, not the blank note", noteCount === 2 && attachments === 1, `${noteCount} notes, ${attachments} files`);
    check("(temporary) after the download, closing the tab asks nothing", await (async () => {
      const dialogs = [];
      o.page.on("dialog", async (dialog) => { dialogs.push(dialog.type()); await dialog.dismiss().catch(() => {}); });
      await o.page.keyboard.press("Escape");
      await o.page.mouse.click(5, 5);
      const gone = o.page.close({ runBeforeUnload: true }).catch(() => {});
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3_000))]);
      await new Promise((r) => setTimeout(r, 1_500));
      return dialogs.length === 0 && o.page.isClosed();
    })());

    // Another page of the same profile, an ordinary one that opens nothing: what does this origin hold?
    const probe = await o.context.newPage();
    await probe.goto(`${site.base}favicon.svg`);
    const held = await probe.evaluate(async () => {
      const names = [];
      const walk = async (dir, prefix) => { for await (const [name, handle] of dir.entries()) { names.push(prefix + name); if (handle.kind === "directory") await walk(handle, `${prefix}${name}/`); } };
      await walk(await navigator.storage.getDirectory(), "");
      return { files: names, databases: (await indexedDB.databases()).map((d) => d.name), local: Object.keys(localStorage), session: Object.keys(sessionStorage), caches: await caches.keys(), cookie: document.cookie };
    });
    const cookies = await o.context.cookies();
    check("(temporary) afterwards the browser holds nothing of the session: no files, databases, preferences, caches or cookies", held.files.length === 0 && held.databases.length === 0 && held.local.length === 0 && held.session.length === 0 && held.caches.length === 0 && cookies.length === 0, JSON.stringify({ held, cookies: cookies.map((c) => c.name) }));

    // A reload of a temporary session starts empty again.
    const again = await o.context.newPage();
    await again.goto(`${site.base}?temp=1`);
    await workerUp(again);
    check("(temporary) a reload starts empty: the earlier writing is gone", (await search(again, stamp)) === 0);
    await again.close({ runBeforeUnload: false }).catch(() => {});

    // The download goes into an ordinary session by a merge restore, under one new parent note.
    const ordinary = await open();
    await ordinary.page.goto(base);
    await ordinary.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    await workerUp(ordinary.page);
    const sampleBefore = await search(ordinary.page, SAMPLE_TEXT);
    const bytes = Array.from(readFileSync(zipPath));
    const outcome = await ordinary.page.evaluate(async ({ bytes, title }) => {
      const upload = await (await fetch("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(bytes) })).json();
      const spaces = (await (await fetch("/api/spaces")).json()).spaces;
      const space = spaces.find((s) => s.is_default) ?? spaces[0];
      const shown = await (await fetch(`/api/backup/restore/${upload.upload_id}/preview?space=${space.id}&mode=merge&parent_title=${encodeURIComponent(title)}`)).json();
      const started = await (await fetch(`/api/backup/restore/${upload.upload_id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: space.id, mode: "merge", parent_title: title }) })).json();
      let job = started.job;
      for (let i = 0; i < 150 && job.status === "running"; i++) { await new Promise((r) => setTimeout(r, 200)); job = (await (await fetch(`/api/backup/restore/jobs/${job.id}`)).json()).job; }
      return { newParent: shown.new_parent, status: job.status, report: job.result };
    }, { bytes, title: `課堂 ${stamp}` });
    check("(temporary) the download merges into an ordinary session under one new parent note", outcome.status === "done" && outcome.newParent?.title === `課堂 ${stamp}` && outcome.report?.created === 2 && !!outcome.report?.parent_note_id, JSON.stringify(outcome));
    check("(temporary) the ordinary session's own notes are still there", (await search(ordinary.page, SAMPLE_TEXT)) === sampleBefore);
    const under = await ordinary.page.evaluate(async (parentId) => {
      const children = await (await fetch(`/api/nodes/${parentId}/children`)).json().catch(() => null);
      return children;
    }, outcome.report?.parent_note_id);
    info("(temporary) the new parent's children", true, JSON.stringify(under)?.slice(0, 200));
    await ordinary.context.close();
    await o.context.close();
  }

  // ── The view tabs above a note's whiteboard stay the note's ────────────────────────────────────────────────────────────
  // (docs/agents/decisions-ui.md, 筆記與標籤頁的視角分頁.) Selecting a card on the board, or clicking empty board space
  // (which clears the selection), must not change or remove the tabs; 內容 returns to the note whose board it is.
  {
    const o = await open();
    const stamp = Date.now();
    const parentTitle = `白板主人 ${stamp}`;
    await o.page.goto(base);
    await o.page.getByText(SAMPLE_TEXT).first().waitFor({ state: "attached", timeout: 90_000 });
    await workerUp(o.page);
    const parentId = await o.page.evaluate(async (title) => {
      const post = async (body) => (await (await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json());
      const parent = await post({ title, markdown: "主人的內文" });
      await post({ title: "白板上的子筆記甲", markdown: "x", parent_id: parent.id });
      await post({ title: "白板上的子筆記乙", markdown: "x", parent_id: parent.id });
      return parent.id;
    }, parentTitle);
    await savedAll(o.page);
    await o.page.goto(`${base}?view=notes&node=${parentId}&lens=canvas`);
    await o.page.waitForSelector(".react-flow__pane", { timeout: 60_000 });
    await o.page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length >= 2, null, { timeout: 30_000 });
    await dismissWhatsNew(o.page);
    const phone = engineName.includes("mobile");
    // A wide screen: the title strip's tabs. A phone's full-screen board: the title button that opens the tab sheet.
    const tabsHere = async () => phone
      ? (await o.page.locator(".board-note-title").count()) === 1
      : (await o.page.locator(".center-lens-bar").getByRole("tab", { name: "內容" }).count()) === 1;
    const where = engineName;
    check(`(board tabs, ${where}) the board has the note's tabs`, await tabsHere());
    await o.page.locator(".react-flow__node").nth(1).click({ position: { x: 10, y: 10 } });
    await o.page.waitForTimeout(800);
    check(`(board tabs, ${where}) after selecting a card the tabs are still there`, await tabsHere());
    await o.page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 }, force: true });
    await o.page.waitForTimeout(800);
    check(`(board tabs, ${where}) after clearing the selection the tabs are still there`, await tabsHere());
    if (!phone) {
      await o.page.locator(".react-flow__node").nth(1).click({ position: { x: 10, y: 10 } });
      await o.page.waitForTimeout(500);
      await o.page.locator(".center-lens-bar").getByRole("tab", { name: "內容" }).click();
      const title = o.page.locator(".obsidian-title-input");
      await title.waitFor({ timeout: 30_000 });
      check(`(board tabs, ${where}) 內容 returns to the note whose board it is, not to the selected card`, (await title.inputValue()) === parentTitle, await title.inputValue());
    }
    await o.context.close();
  }

  // ── Not done in this batch (reported, so a pass is never mistaken for coverage) ──────────────────────────────────────
  check("no script errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  check(`run to the end (${String(error.message).split("\n")[0]})`, false);
}
await browser.close();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${engineName}: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
