#!/usr/bin/env node
// Daily production probe (owner, 2026-11-23): what no pre-merge check sees — the site as it is deployed.
//   Part 1, the local-edition site (browser version; its backend runs in the page's worker, data only in that browser):
//     a FRESH browser profile (a new context: nothing stored, like a private window), zh-TW, Chromium and WebKit.
//   Part 2, the server site, as a dedicated probe account (an ordinary member, only its own personal space):
//     sign in → new note titled with the date → still there after a reload → delete it for good.
//     Without the three secrets this part says 「略過：巡檢帳號未設定」 and the report shows it.
//   node e2e/probe/prod-probe.mjs [--local-url https://onden.o-andy.com] [--engines chromium,webkit] [--only local|server]
//                                 [--out <dir for failure screenshots and page text>]
//   or, from packages/frontend:  npm run probe:prod     (after a deploy: docs/agents/deploy.md)
// Output lines the report reads (scripts/ciScheduledReport.mjs): `探針新紅 <id>`, `探針已知 <id>`, `探針可刪 <id>`, `探針略過 <原因>`.
// Exit 1 on a fresh red; known reds (e2e/probe-known-baseline.json, only shrinks) and a skip do not fail the run.
// Never touches anything but what it created itself; no secret is printed, screenshotted or written (scrub()).
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { partitionResults, sampleBoot, scrub, serverProbeSkipReason, visibleLinesInPage, englishUiStrings } from "./probeLib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();

/** The most a boot may take, from opening the address to a working editor. First visit downloads the database engine
 *  (docs/architecture/browser-app.md §10: about 4–5 s on a fast line, a minute on a poor one); past this it is stuck. */
const BOOT_LIMIT_MS = 90_000;
const SAVE_LIMIT_MS = 30_000;
const LOCAL_URL_DEFAULT = "https://onden.o-andy.com";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const outDir = resolve(arg("--out", join(here, "probe-artifacts")));
const only = arg("--only", null);
const results = [];
const secrets = [process.env.ONDEN_PROBE_EMAIL, process.env.ONDEN_PROBE_PASSWORD];
const record = (id, ok, detail = "") => {
  results.push({ id, ok, detail: scrub(detail, secrets) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? `  (${scrub(detail, secrets)})` : ""}`);
};
const keep = (name, text) => { mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, name), scrub(text, secrets)); };

const workerUp = (page) => page.evaluate(async () => { try { return (await fetch("/api/browser-app/state")).ok; } catch { return false; } });
const saveState = (page) => page.evaluate(async () => (await fetch("/api/browser-app/state")).json());
const search = (page, word) => page.evaluate(async (q) => (await (await fetch(`/api/nodes/search?q=${encodeURIComponent(q)}`)).json()).length, word);
const bootDone = (page) => async () => (await workerUp(page)) && ((await page.getByText("歡迎來到 Onden 試用版").count()) > 0 || (await page.locator(".cm-content").count()) > 0);

async function localEngine(engineName, url) {
  const id = (name) => `local.${engineName}.${name}`;
  let browser;
  try { browser = await (engineName === "webkit" ? playwright.webkit : playwright.chromium).launch(); }
  catch (e) { record(id("launch"), false, `瀏覽器啟動不了：${String(e.message).split("\n")[0]}`); return; }
  const context = await browser.newContext({ ...playwright.devices[engineName === "webkit" ? "Desktop Safari" : "Desktop Chrome"], locale: "zh-TW" });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));
  const english = new Set();
  let gateSeen = false;
  const evidence = async (why) => {
    await page.screenshot({ path: join(outDir, `${engineName}-${why}.png`) }).catch(() => {});
    keep(`${engineName}-${why}.txt`, (await page.evaluate(visibleLinesInPage).catch(() => [])).join("\n"));
  };
  try {
    mkdirSync(outDir, { recursive: true });
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "commit" });
    const boot = await sampleBoot(page, { done: bootDone(page), limitMs: BOOT_LIMIT_MS });
    boot.lines.forEach((l) => english.add(l)); gateSeen ||= boot.gateSeen;
    record(id("boot-in-time"), boot.doneAt !== null, boot.doneAt !== null ? `${Math.round(boot.doneAt / 1000)} 秒開好（上限 ${BOOT_LIMIT_MS / 1000} 秒）` : `${BOOT_LIMIT_MS / 1000} 秒內沒開好，仍在轉圈或停在閘門`);
    if (boot.doneAt === null) { await evidence("boot"); return; }

    // Write a note the way a person does (the 建立 button, then type) and let the browser's own save catch up.
    const stamp = Date.now();
    const word = `巡檢內文${stamp}`;
    await page.waitForTimeout(2_000);
    await page.getByRole("button", { name: "建立", exact: true }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "建立", exact: true }).click();
    await page.getByRole("heading", { name: "歡迎來到 Onden 試用版" }).waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
    const editor = page.locator(".cm-content").first();
    await editor.waitFor({ timeout: 20_000 });
    await editor.click();
    await page.keyboard.type(`# 巡檢標題${stamp}\n\n${word}`);
    // The typed words reach the database after a short debounce, and `unsaved: false` from the boot's own save is true before
    // that: wait for the words to be in the database first, then for the browser's copy to catch up (as smoke.mjs does).
    const saveEnd = Date.now() + SAVE_LIMIT_MS;
    let saved = false;
    while (Date.now() < saveEnd && !saved) {
      const inDatabase = (await search(page, word).catch(() => 0)) > 0;
      const s = inDatabase ? await saveState(page).catch(() => null) : null;
      saved = !!s && !s.unsaved && s.lastSavedAt !== null;
      if (!saved) await page.waitForTimeout(400);
    }
    record(id("note-saved"), saved, saved ? "" : `${SAVE_LIMIT_MS / 1000} 秒內瀏覽器沒有存好`);

    await page.goto(url, { waitUntil: "commit" });
    const again = await sampleBoot(page, { done: bootDone(page), limitMs: BOOT_LIMIT_MS });
    again.lines.forEach((l) => english.add(l)); gateSeen ||= again.gateSeen;
    const survived = again.doneAt !== null && (await search(page, word).catch(() => 0)) >= 1;
    record(id("note-survives-reload"), survived, survived ? "" : "重新整理後找不到剛打的字");
    if (!survived) await evidence("reload");

    // The local edition has no account: no sign-out button (owner, 2026-11-23; opened last: an open menu in front of the editor ate the typing; fix on the way: fix/local-edition-host-capabilities).
    const chip = page.locator(".user-chip").first();
    if (await chip.isVisible().catch(() => false)) await chip.click({ timeout: 3_000 }).catch(() => {});
    const logout = await page.getByText("登出", { exact: true }).first().isVisible().catch(() => false);
    record(id("no-logout"), !logout, logout ? "本機版的選單裡有「登出」" : "");
    await page.keyboard.press("Escape").catch(() => {});

    const flash = englishUiStrings([...english]);
    record(id("no-english-flash"), flash.length === 0, flash.length ? `畫面上出現英文：${flash.slice(0, 5).join(" ／ ")}` : "");
    record(id("no-member-gate"), !gateSeen, gateSeen ? "看到「正在確認工作區資料」閘門" : "");
    record(id("no-unhandled-errors"), pageErrors.length === 0, pageErrors.slice(0, 3).join(" ／ "));
    if (flash.length || gateSeen || pageErrors.length) await evidence("seen");
  } catch (e) {
    record(id("ran-to-end"), false, `腳本中途停下：${String(e.message).split("\n")[0]}`);
    await evidence("crash");
  } finally { await browser.close(); }
}

async function serverProbe() {
  const skip = serverProbeSkipReason(process.env);
  if (skip) { console.log(`探針略過 ${skip}`); return { skipped: skip }; }
  const base = process.env.ONDEN_PROBE_URL.replace(/\/$/, "");
  const id = (name) => `server.${name}`;
  const api = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  let nodeId = null;
  try {
    const login = await api.post("/api/auth/sign-in/email", { data: { email: process.env.ONDEN_PROBE_EMAIL, password: process.env.ONDEN_PROBE_PASSWORD } });
    record(id("sign-in"), login.ok(), login.ok() ? "" : `登入被拒（${login.status()}）`);
    if (!login.ok()) return {};
    const title = `巡檢 ${new Date().toISOString().slice(0, 10)} ${Math.random().toString(36).slice(2, 8)}`;
    const made = await api.post("/api/nodes", { data: { title, markdown: "巡檢用，會被刪除" }, headers: { "idempotency-key": crypto.randomUUID() } });
    record(id("create-note"), made.status() === 201, `狀態 ${made.status()}`);
    if (made.status() !== 201) return {};
    const node = await made.json();
    nodeId = String(node.id);
    // Only the probe account's own personal space: the note must have landed there.
    const spaces = (await (await api.get("/api/spaces")).json()).spaces ?? [];
    const personal = spaces.filter((s) => s.kind === "personal").map((s) => s.id);
    record(id("note-in-own-personal-space"), !!node.space_id && personal.includes(node.space_id), node.space_id ? "" : "回應沒有說筆記在哪個空間");

    // A reload: a page opened with this session (a new load of the app), then the note read again from the server.
    const browser = await playwright.chromium.launch();
    try {
      const ctx = await browser.newContext({ locale: "zh-TW", storageState: await api.storageState() });
      const page = await ctx.newPage();
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.reload({ waitUntil: "domcontentloaded" });
      const back = await page.evaluate(async (nid) => (await fetch(`/api/nodes/${nid}`)).status, nodeId);
      record(id("note-survives-reload"), back === 200, `狀態 ${back}`);
      if (back !== 200) keep("server-reload.txt", (await page.evaluate(visibleLinesInPage).catch(() => [])).join("\n"));
    } finally { await browser.close(); }
  } catch (e) {
    record(id("ran-to-end"), false, `腳本中途停下：${String(e.message).split("\n")[0]}`);
  } finally {
    if (nodeId) await purgeOwn(api, nodeId, id);
    await api.dispose();
  }
  return {};
}

/** Delete the note this run made, for good: move to trash, read what a purge would take, and purge only if that is exactly
 *  this note. Anything else in the plan → leave it trashed and say so (never take what we did not make). */
async function purgeOwn(api, nodeId, id) {
  try {
    const trashed = await api.delete(`/api/nodes/${nodeId}`);
    if (!trashed.ok()) { record(id("purge-note"), false, `丟進垃圾桶被拒（${trashed.status()}）`); return; }
    const preview = await (await api.get(`/api/nodes/${nodeId}/purge-preview`)).json();
    const ids = (preview.ids ?? []).map(String);
    if (ids.length !== 1 || ids[0] !== nodeId) { record(id("purge-note"), false, `永久刪除的範圍不是只有這篇筆記（${ids.length} 篇），沒有刪，筆記留在垃圾桶`); return; }
    const purged = await api.post(`/api/nodes/${nodeId}/purge`, { data: { expected_ids: ids }, headers: { "idempotency-key": crypto.randomUUID() } });
    record(id("purge-note"), purged.ok(), purged.ok() ? "" : `永久刪除被拒（${purged.status()}）`);
  } catch (e) { record(id("purge-note"), false, `刪除時中斷：${String(e.message).split("\n")[0]}`); }
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const knownFile = join(here, "../probe-known-baseline.json");
const known = JSON.parse(readFileSync(knownFile, "utf8")).checks ?? {};
const engines = arg("--engines", "chromium,webkit").split(",").filter(Boolean);
if (only !== "server") for (const e of engines) await localEngine(e, arg("--local-url", LOCAL_URL_DEFAULT));
const server = only === "local" ? { skipped: "略過：這次只跑本機版" } : await serverProbe();

const { fresh, knownRed, removable } = partitionResults(results, known);
for (const r of knownRed) console.log(`探針已知 ${r.id}：${known[r.id]}（等修正上線）`);
for (const id of removable) console.log(`探針可刪 ${id}（這次通過，可從 e2e/probe-known-baseline.json 刪掉）`);
for (const r of fresh) console.log(`探針新紅 ${r.id}  ${r.detail}`);
console.log(`探針結果：通過 ${results.filter((r) => r.ok).length}、新紅 ${fresh.length}、已知 ${knownRed.length}${server.skipped ? `、伺服器段 ${server.skipped}` : ""}`);
process.exit(fresh.length ? 1 : 0);
