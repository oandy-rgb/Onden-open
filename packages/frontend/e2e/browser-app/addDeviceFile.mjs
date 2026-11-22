// npm run build:browser (repo root), then: node e2e/browser-app/addDeviceFile.mjs [chromium|mobile-chrome] [--dir dist-browser] [--shots <folder>]
// "Take my notes to another device" through one file, end to end between two browser versions (each its own fresh browser context =
// its own empty copy):
//   device A has notes (tags, a task, a view, a handwriting page) and saves the file from 設定 › 你的資料 › 帶到另一台裝置;
//   device B, a second fresh copy that still has the sample notes, opens 從另一台裝置帶過來 and takes the file: it shows the same notes,
//   still after a reload, as a node of its own (not A's), and the samples are gone;
//   then a bigger file (2,000 notes) is taken into a third copy, with the tab's memory measured, and a fourth copy is closed in the
//   middle of taking it: it must reopen as a usable EMPTY copy that says what happened.
// mobile-chrome is Chromium with a 390×844 phone window, touch and pixel ratio 2: an emulation, not a phone.
// Prints `measure …` lines (file size, time, renderer memory) for the PR. Exit code 1 when a check fails; 2 when the browser cannot start.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { serve } from "./serve.mjs";
import { READY_TEXT, waitSaved } from "../layout-audit/env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = process.argv[2] === "mobile-chrome" ? "mobile-chrome" : "chromium";
const flag = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
const shotsDir = flag("--shots");
const BIG = Number(flag("--notes") ?? 2000);
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const work = join(tmpdir(), `add-device-${process.pid}`);
mkdirSync(work, { recursive: true });
const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} [${engine}] ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(what); };
const measure = (what, value) => console.log(`measure [${engine}] ${what}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

let browser;
try { browser = await playwright.chromium.launch(); } catch (error) { console.log(`SKIPPED: ${String(error).slice(0, 160)}`); process.exit(2); }
const dirArg = process.argv.indexOf("--dir");
const site = await serve(resolve(here, "../..", dirArg > 0 ? process.argv[dirArg + 1] : "dist-browser"));
const phone = engine === "mobile-chrome";
const windowOptions = phone
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
  : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const freshDevice = async () => {
  const context = await browser.newContext({ ...windowOptions, locale: "zh-TW", timezoneId: "UTC", reducedMotion: "reduce" });
  // The save-file picker needs a native dialog; a phone has none either. The ordinary download path is what is checked here.
  await context.addInitScript(() => {
    delete window.showSaveFilePicker;
    // what name the page asks the browser to save under (Chromium's own suggested name drops some non-ASCII names in headless runs)
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.__downloadName = this.download; return click.call(this); };
  });
  return context;
};

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const openPage = async (context, path = "") => {
  const page = await context.newPage();
  await page.goto(`${site.base}${path}`);
  await page.getByText(READY_TEXT).first().waitFor({ state: "attached", timeout: 120_000 });
  return page;
};
const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}, { method, path, body });
const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path: join(shotsDir, `${engine}-${name}.png`) }); };
const until = async (probe, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 300)); } return false; };

const openSettingsData = async (page) => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("onden:open-settings", { detail: "data" })));
  await page.getByText("完整備份", { exact: true }).first().waitFor({ timeout: 30_000 });
};

// ── memory of the tab: every renderer process on the machine (the test is the only browser; the page and its worker live in them) ──
const rendererKb = () => {
  let kb = 0;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (!readFileSync(`/proc/${name}/cmdline`, "utf8").includes("--type=renderer")) continue;
      kb += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${name}/status`, "utf8"))?.[1] ?? 0);
    } catch { /* gone */ }
  }
  return Math.round(kb / 1024);
};
const watchMemory = () => {
  const samples = [rendererKb()];
  const timer = setInterval(() => samples.push(rendererKb()), 250);
  return { stop: () => { clearInterval(timer); return { start: samples[0], peak: Math.max(...samples), samples: samples.length }; } };
};

/** Device A saves the file from Settings; resolves the path it was saved to and how long it took. */
async function saveFile(page, name) {
  await openSettingsData(page);
  await page.getByText("帶到另一台裝置", { exact: true }).first().scrollIntoViewIfNeeded();
  await shot(page, `${name}-1-settings-row`);
  await page.getByRole("button", { name: "製作檔案…" }).click();
  await page.getByRole("button", { name: "製作檔案", exact: true }).waitFor();
  await shot(page, `${name}-2-confirm`);
  const text = await page.getByRole("dialog").last().innerText();
  check(/這是複製/.test(text) && /不會互相更新/.test(text) && /全部的筆記/.test(text) && /圖片與檔案/.test(text), `${name}: the dialog says what the file is and is not`, text.slice(0, 80));
  check(!/snapshot|ndjson|json|stamp|快照/i.test(text), `${name}: the dialog uses no technical words`);
  const started = Date.now();
  const download = page.waitForEvent("download", { timeout: 300_000 });
  await page.getByRole("button", { name: "製作檔案", exact: true }).click();
  const got = await download;
  const asked = await page.evaluate(() => window.__downloadName);
  await page.getByText(/已交給瀏覽器下載/).waitFor({ timeout: 60_000 });
  const ms = Date.now() - started;
  const path = join(work, `${name}.onden`);
  check(/^Onden 筆記 \d{4}-\d{2}-\d{2}\.onden$/.test(asked ?? ""), `${name}: the file is named in plain words with a date`, String(asked));
  await got.saveAs(path);
  await shot(page, `${name}-3-done`);
  return { path, ms, bytes: statSync(path).size };
}

/** A copy still holding its sample notes opens the way in from Settings and arrives at the screen that asks for the file. */
async function toBringScreen(page, name) {
  await openSettingsData(page);
  await page.getByText("從另一台裝置帶過來", { exact: true }).first().scrollIntoViewIfNeeded();
  await shot(page, `${name}-1-settings-row`);
  await page.getByRole("button", { name: "帶過來…" }).click();
  await page.getByRole("button", { name: "清除全部並繼續", exact: true }).waitFor();
  const entry = await page.getByRole("dialog").last().innerText();
  check(/已經有自己的內容：\d+ (則|篇)筆記/.test(entry), `${name}: the entry says what the backend counted`, entry.replace(/\s+/g, " ").slice(0, 90));
  await shot(page, `${name}-2-entry`);
  const loaded = page.waitForEvent("load", { timeout: 90_000 });
  await page.getByRole("button", { name: "清除全部並繼續", exact: true }).click();
  await page.getByRole("button", { name: "清除並繼續", exact: true }).click(); // everything is erased: asked first, with the counts
  await loaded;
  await page.getByRole("button", { name: "選擇你另一台裝置的檔案…" }).waitFor({ timeout: 120_000 });
  await shot(page, `${name}-3-choose`);
}
const chooseFile = (page, path) => page.locator('input[type="file"]').setInputFiles(path);

async function snapshotOf(page, ids) {
  const all = (await call(page, "GET", "/api/bootstrap")).nodes;
  const picked = {};
  for (const note of ids) {
    const n = all.find((x) => x.id === note);
    picked[note] = n && { title: n.title, markdown: n.markdown, tags: [...(n.class_tag_ids ?? []), ...(n.label_tag_ids ?? [])].sort() };
  }
  return picked;
}
/** A copy that was only opened has no new copy to save: "nothing unsaved" is the thing to wait for. */
const settled = async (page, ms = 30_000) => { if (!(await until(async () => !(await stateOf(page)).unsaved, ms))) throw new Error("the browser app did not settle"); };
const readinessOf = (page) => call(page, "GET", "/api/snapshot/readiness");
const stateOf = (page) => page.evaluate(async () => (await fetch("/api/browser-app/state?node=1")).json());

try {
  // ── device A: the sample notes plus notes of its own ──
  const ctxA = await freshDevice();
  const pageA = await openPage(ctxA);
  const TAG = id(9001), TAG2 = id(9002), N1 = id(9011), N2 = id(9012), TASKS = id(9013), INK = id(9014), VIEWED = id(9015);
  await call(pageA, "POST", "/api/tags", { id: TAG, name: "裝置搬家" });
  await call(pageA, "POST", "/api/tags", { id: TAG2, name: "第二個標籤" });
  await call(pageA, "POST", "/api/nodes", { id: N1, title: "搬家筆記一", markdown: "第一則\n\n含 [[搬家筆記二]] 的連結", tag_ids: [TAG] });
  await call(pageA, "POST", "/api/nodes", { id: N2, title: "搬家筆記二", markdown: "第二則", tag_ids: [TAG, TAG2] });
  await call(pageA, "POST", "/api/nodes", { id: TASKS, title: "搬家任務", markdown: "- [ ] 買牛奶 {task}\n- [x] 已完成的事 {task}" });
  await call(pageA, "POST", "/api/nodes", { id: VIEWED, title: "有檢視的筆記", markdown: "" });
  await call(pageA, "POST", "/api/nodes", { id: INK, title: "手寫頁", markdown: "" });
  const ink = JSON.stringify({ version: 1, strokes: [{ id: "s1", points: [[0, 0], [10, 10], [20, 5]], color: "#000", width: 2 }], erased: {}, page: { width: 1000 } });
  await call(pageA, "PUT", `/api/nodes/${INK}/attributes/ink_data`, { value: ink, value_type: "text" });
  let viewMade = true;
  try { await call(pageA, "POST", `/api/nodes/${VIEWED}/views`, { name: "我的表格", layout: "table" }); } catch (error) { viewMade = false; console.log(`note: no view made (${String(error).slice(0, 100)})`); }
  await waitSaved(pageA);
  const MINE = [N1, N2, TASKS, INK, VIEWED];
  const before = await snapshotOf(pageA, MINE);
  const viewsA = viewMade ? await call(pageA, "GET", `/api/nodes/${VIEWED}/views`).catch(() => null) : null;
  const inkA = (await call(pageA, "GET", `/api/nodes/${INK}/attributes?keys=ink_data`)).find((a) => a.key === "ink_data")?.value;
  const stateA = await stateOf(pageA);
  const readyA = await readinessOf(pageA);
  check(!readyA.ready && readyA.holds.own_notes >= 5, "device A has notes of its own (the backend counts them)", JSON.stringify(readyA.holds));

  const small = await saveFile(pageA, "A");
  measure("sample workspace + 5 notes: file", `${small.bytes} bytes (${Math.round(small.bytes / 1024)} KB), made in ${small.ms} ms (the whole dialog, download included)`);
  const head = readFileSync(small.path, "utf8").split("\n");
  check(JSON.parse(head[0]).kind === "hello" && JSON.parse(head.filter(Boolean).at(-1)).kind === "manifest", "the file starts with its hello and ends with its manifest");
  check(!/ndjson|snapshot/.test(await pageA.locator("body").innerText()), "device A's screen never says the file's technical name");
  await waitSaved(pageA);
  const aStillThere = (await snapshotOf(pageA, [N1]))[N1]?.title === "搬家筆記一";
  check(aStillThere, "device A is unchanged after making the file");

  // ── device B: a second fresh copy; it first holds the samples, so the way in erases them for good ──
  const ctxB = await freshDevice();
  let pageB = await openPage(ctxB);
  const stateB0 = await stateOf(pageB);
  const readyB0 = await readinessOf(pageB);
  check(stateB0.sampleNotes > 0 && !readyB0.ready && readyB0.holds.own_notes > 0, "device B starts with the sample notes, which the backend counts as content to erase", JSON.stringify(readyB0.holds));
  await toBringScreen(pageB, "B");
  const stateB1 = await stateOf(pageB);
  const readyB1 = await readinessOf(pageB);
  check(stateB1.sampleNotes === 0 && readyB1.ready === true, "after the way in B is completely empty: the backend would take a file", JSON.stringify(readyB1));
  const bodyText = await pageB.locator("body").innerText();
  check(/不會互相更新/.test(bodyText) && /不會上傳|沒有任何東西上傳/.test(bodyText) && /圖片與檔案/.test(bodyText), "B's screen says: a copy, no updates between the devices, nothing uploaded, pictures not yet");
  check(!/同步|snapshot|ndjson|json|stamp/i.test(bodyText), "B screen never says 同步 and uses no technical words");

  // a wrong file first: told at once, nothing touched
  const wrong = join(work, "wrong.txt");
  execFileSync("sh", ["-c", `echo 'not what you think' > ${wrong}`]);
  await chooseFile(pageB, wrong);
  await pageB.getByText(/不是你另一台裝置做的檔案/).waitFor({ timeout: 20_000 });
  await shot(pageB, "B-4-wrong-file");
  check((await readinessOf(pageB)).ready === true, "a wrong file leaves B empty");

  if (process.env.E2E_TRACE) { pageB.on("console", (m) => console.log("B console:", m.text().slice(0, 160))); pageB.on("framenavigated", (f) => console.log("B navigated", f.url())); const tick = setInterval(async () => console.log("B says:", (await pageB.locator("body").innerText().catch(() => "?")).replace(/\n+/g, " | ").slice(0, 160)), 700); setTimeout(() => clearInterval(tick), 20000); }
  const joinStart = Date.now();
  await chooseFile(pageB, small.path);
  // The done screen stays for 3.5 s before the page reloads itself: the wait for it starts before anything slow (a screenshot) is done.
  const arrived = pageB.getByText("你的筆記到了").waitFor({ timeout: 300_000 });
  arrived.catch(() => {});
  await pageB.getByText(/正在帶入筆記|檔案讀完了/).first().waitFor({ timeout: 20_000 }).then(() => shot(pageB, "B-5-reading"), () => {});
  await arrived.catch(async (error) => { console.log(`what B says instead: ${(await pageB.locator("body").innerText()).slice(0, 300)}`); throw error; });
  const joinMs = Date.now() - joinStart;
  await shot(pageB, "B-6-done");
  const doneText = await pageB.locator("body").innerText();
  check(/檔案做好那一刻為止的全部內容/.test(doneText) && /不會互相更新/.test(doneText), "B says it has everything up to the moment the file was made and that the devices do not update each other yet");
  measure("sample workspace + 5 notes: taken in", `${joinMs} ms`);
  await pageB.waitForEvent("load", { timeout: 60_000 }); // it reloads itself into the joined notes
  await pageB.waitForLoadState("domcontentloaded");
  await pageB.getByText("搬家筆記一").first().waitFor({ state: "attached", timeout: 120_000 }).catch(() => {});
  await until(async () => (await pageB.evaluate(async () => (await fetch("/api/browser-app/state")).ok).catch(() => false)));
  const after = await snapshotOf(pageB, MINE);
  check(JSON.stringify(after) === JSON.stringify(before), "B shows the same notes (titles, text, tags) as A", JSON.stringify(after).slice(0, 120));
  const stateB2 = await stateOf(pageB);
  check(stateB2.sampleNotes === 0, "B has no sample notes");
  const welcomes = (page) => call(page, "GET", "/api/bootstrap").then((b) => b.nodes.filter((n) => n.title === "歡迎來到 Onden 試用版").length);
  check((await welcomes(pageB)) === (await welcomes(pageA)), "B's own sample notes were erased: it holds A's sample notes once, not two sets", String(await welcomes(pageB)));
  const inkB = (await call(pageB, "GET", `/api/nodes/${INK}/attributes?keys=ink_data`)).find((a) => a.key === "ink_data")?.value;
  check(inkB === inkA, "the handwriting page is the same");
  if (viewMade) check(JSON.stringify((await call(pageB, "GET", `/api/nodes/${VIEWED}/views`).catch(() => null))?.map?.((v) => v.name)) === JSON.stringify(viewsA?.map?.((v) => v.name)), "the view is the same");
  const tagsB = (await call(pageB, "GET", "/api/tags")).map?.((t) => t.name) ?? [];
  check(tagsB.includes("裝置搬家") && tagsB.includes("第二個標籤"), "both tags are there");
  check(stateB2.ownNode && stateB2.ownNode !== stateA.ownNode, "B is a node of its own, not A", `${stateA.ownNode} vs ${stateB2.ownNode}`);
  await settled(pageB);
  await pageB.reload();
  await pageB.getByText("搬家筆記一").first().waitFor({ state: "attached", timeout: 120_000 }).catch(() => {});
  check(JSON.stringify(await snapshotOf(pageB, MINE)) === JSON.stringify(before), "after another reload B still has the same notes");
  const created = await call(pageB, "POST", "/api/nodes", { title: "B 自己寫的", markdown: "之後的筆記" });
  check(!!created?.id, "B can write notes of its own afterwards");
  check((await snapshotOf(pageA, [N1]))[N1]?.title === "搬家筆記一" && !(await call(pageA, "GET", "/api/bootstrap")).nodes.some((n) => n.title === "B 自己寫的"), "A did not get B's new note: the devices do not update each other");

  // ── a second file into a device that is not empty: said in words ──
  await openSettingsData(pageB);
  await pageB.getByText("從另一台裝置帶過來", { exact: true }).first().scrollIntoViewIfNeeded();
  await pageB.getByRole("button", { name: "帶過來…" }).click();
  await pageB.getByText(/已經有自己的內容/).waitFor({ timeout: 20_000 });
  await shot(pageB, "B-7-not-empty");
  const entryText = await pageB.getByRole("dialog").last().innerText();
  check(/清除全部並繼續/.test(entryText) && /(則|篇)筆記/.test(entryText) && !/[0-9a-f]{8}-|join_|own_notes|stamp/.test(entryText), "a device with notes of its own says what would be erased, in counts and words, with no codes");
  await ctxB.close();
  await ctxA.close(); // from here on one browser context at a time, so the renderer processes measured are the tab's

  // ── a bigger workspace on device C, then taken into D; E is closed half way ──
  const ctxC = await freshDevice();
  const pageC = await openPage(ctxC);
  const made = Date.now();
  for (let from = 0; from < BIG; from += 250) {
    const files = Array.from({ length: Math.min(250, BIG - from) }, (_, i) => ({ path: `大量/筆記 ${from + i}.md`, content: `# 大量筆記 ${from + i}\n\n這是第 ${from + i} 則，帶有一些內文：${"字".repeat(200)}\n\n#大量標籤${(from + i) % 7}\n` }));
    await call(pageC, "POST", "/api/import/obsidian", { files, upsert: true, source: { id: id(9100 + from), name: "e2e" } });
  }
  await waitSaved(pageC, 120_000);
  measure(`${BIG}-note workspace made in`, `${Date.now() - made} ms`);
  const big = await saveFile(pageC, "C");
  measure(`${BIG}-note workspace: file`, `${big.bytes} bytes (${(big.bytes / 1048576).toFixed(1)} MB), made in ${big.ms} ms`);
  const idsOnC = (await call(pageC, "GET", "/api/bootstrap")).nodes.length;
  await ctxC.close();

  const ctxD = await freshDevice();
  const pageD = await openPage(ctxD);
  await toBringScreen(pageD, "D");
  const memD = watchMemory();
  const startedD = Date.now();
  await chooseFile(pageD, big.path);
  await pageD.getByText("你的筆記到了").waitFor({ timeout: 900_000 });
  const mD = memD.stop();
  measure(`${BIG}-note workspace: taken in`, `${Date.now() - startedD} ms; renderer memory MB start ${mD.start}, peak ${mD.peak}`);
  await pageD.waitForEvent("load", { timeout: 60_000 });
  await until(async () => (await pageD.evaluate(async () => (await fetch("/api/bootstrap")).json()).catch(() => null))?.nodes?.length >= idsOnC);
  await pageD.waitForTimeout(3000);
  measure(`${BIG}-note workspace: renderer memory MB after the reload settled`, rendererKb());
  check((await call(pageD, "GET", "/api/bootstrap")).nodes.length === idsOnC, `D holds the same number of notes as C (${idsOnC})`);
  await ctxD.close();

  const ctxE = await freshDevice();
  let pageE = await openPage(ctxE);
  await toBringScreen(pageE, "E");
  await chooseFile(pageE, big.path);
  await pageE.getByText(/正在帶入筆記|檔案讀完了/).first().waitFor({ timeout: 30_000 });
  // Some of the file is in, the rest to come: close as soon as the screen says a few percent have been read (never after the end).
  await until(async () => Number(/已讀 (\d+)%/.exec(await pageE.locator("body").innerText().catch(() => ""))?.[1] ?? 0) >= 5 || /檔案讀完了/.test(await pageE.locator("body").innerText().catch(() => "")), 20_000);
  await shot(pageE, "E-1-reading");
  await pageE.close({ runBeforeUnload: false }); // the tab is killed in the middle
  pageE = await ctxE.newPage();
  await pageE.goto(`${site.base}`);
  await pageE.getByText(/上次筆記沒有帶完/).waitFor({ timeout: 120_000 });
  await shot(pageE, "E-2-interrupted");
  const interruptedText = await pageE.locator("body").innerText();
  check(/什麼都沒有留下/.test(interruptedText) && !/join_|snapshot|stamp/i.test(interruptedText), "the page that was killed reopens and says nothing was kept");
  const stateE = await stateOf(pageE);
  const readyE = await readinessOf(pageE);
  check(readyE.ready === true && stateE.sampleNotes === 0, "the interrupted copy is empty: the backend would take a file", JSON.stringify(readyE));
  const nodesE = (await call(pageE, "GET", "/api/bootstrap")).nodes.filter((n) => /大量筆記/.test(n.title));
  check(nodesE.length === 0, "none of the notes of the half-taken file stayed", String(nodesE.length));
  await pageE.getByRole("button", { name: "這台裝置自己使用" }).click();
  await pageE.getByRole("button", { name: /^(筆記|任務)$/ }).first().waitFor({ timeout: 60_000 });
  const own = await call(pageE, "POST", "/api/nodes", { title: "中斷之後自己寫的", markdown: "能寫" });
  check(!!own?.id, "the interrupted copy opens as a usable empty copy: a note can be written");
  await settled(pageE);
  await pageE.reload();
  await pageE.getByRole("button", { name: /^(筆記|任務)$/ }).first().waitFor({ timeout: 60_000 });
  check((await call(pageE, "GET", "/api/bootstrap")).nodes.some((n) => n.title === "中斷之後自己寫的"), "and it keeps what is written after a reload");
  await ctxE.close();
} catch (error) {
  console.log(`FAIL unexpected error: ${error?.stack ?? error}`);
  failures.push("unexpected error");
}
await browser.close();
site.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed in ${engine}`); process.exit(1); }
console.log(`\nall checks passed in ${engine}`);
