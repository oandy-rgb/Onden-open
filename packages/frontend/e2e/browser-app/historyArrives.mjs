// npm run build:browser (repo root), then: node e2e/browser-app/historyArrives.mjs [chromium|mobile-chrome] [--dir dist-browser] [--shots <folder>]
// A device file whose notes are all in but whose earlier versions are not (the file stopped after the notes), through the real screens of
// two browser versions (review of PR #1988, round 1, point 1):
//   device D takes the file cut in the middle of a line of the notes: the screen says nothing was kept and the device is empty (it is: readiness says ready);
//   device B takes the file cut in the middle of the first line of earlier versions (round 2, point 1: the screen is what the database holds): the screen says the notes are here and the earlier versions are not all here, never that everything came,
//   and offers the same file again or to stop waiting; Settings › 帶到另一台裝置 on B says why no file can be made and what to do; the
//   way back from Settings leads to the same screen; the whole file then brings the rest (B has every earlier version A has) and B can
//   make a file itself;
//   device C takes the cut file and stops waiting: its notes stay, and it has no earlier versions now, so (the owner's decision of 2026-11-23) Settings
//   says it on the row and refuses to make a file with the reason; the way back from Settings leads to the screen that says "this device has no earlier
//   versions"; A's file brings them in without touching the notes, and then C can make a file.
// mobile-chrome is Chromium with a 390×844 phone window, touch and pixel ratio 2: an emulation, not a phone.
// Exit code 1 when a check fails; 2 when the browser cannot start.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const work = join(tmpdir(), `history-arrives-${process.pid}`);
mkdirSync(work, { recursive: true });
const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} [${engine}] ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(what); };

let browser;
try { browser = await playwright.chromium.launch(); } catch (error) { console.log(`SKIPPED: ${String(error).slice(0, 160)}`); process.exit(2); }
const site = await serve(resolve(here, "../..", flag("--dir") ?? "dist-browser"));
const windowOptions = engine === "mobile-chrome"
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
  : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const freshDevice = async () => {
  const context = await browser.newContext({ ...windowOptions, locale: "zh-TW", timezoneId: "UTC", reducedMotion: "reduce" });
  await context.addInitScript(() => { delete window.showSaveFilePicker; });
  return context;
};
const openPage = async (context) => {
  const page = await context.newPage();
  await page.goto(site.base);
  await page.getByText(READY_TEXT).first().waitFor({ state: "attached", timeout: 120_000 });
  return page;
};
const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}, { method, path, body });
const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path: join(shotsDir, `${engine}-history-${name}.png`) }); };
const text = (page) => page.locator("body").innerText();
const technical = (s) => /snapshot|ndjson|json|stamp|join_|history_|[0-9a-f]{8}-[0-9a-f]{4}/i.test(s);
/** The earlier versions of a note, as the note's history lists them (every version, not grouped). */
const versionsOf = async (page, note) => { const r = await call(page, "GET", `/api/nodes/${note}/versions?raw=1`); return (Array.isArray(r) ? r : r.versions ?? []).length; };

const openSettingsData = async (page) => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("onden:open-settings", { detail: "data" })));
  await page.getByText("完整備份", { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByText("帶到另一台裝置", { exact: true }).first().scrollIntoViewIfNeeded();
};
/** Settings › 帶到另一台裝置 › 製作檔案: the path of the file, or null with what the dialog said instead. */
async function makeFile(page, name) {
  await openSettingsData(page);
  await page.getByRole("button", { name: "製作檔案…" }).click();
  const download = page.waitForEvent("download", { timeout: 120_000 }).catch(() => null);
  await page.getByRole("button", { name: "製作檔案", exact: true }).click();
  const outcome = await Promise.race([
    page.getByText(/已交給瀏覽器下載/).waitFor({ timeout: 60_000 }).then(() => "made"),
    page.locator(".device-file-dialog").getByRole("button", { name: "取消", exact: true }).waitFor({ timeout: 60_000 }).then(() => "refused"),
  ]);
  if (outcome === "refused") return { path: null, said: await page.getByRole("dialog").last().innerText() };
  const got = await download;
  const path = join(work, `${name}.onden`);
  await got.saveAs(path);
  await page.getByRole("button", { name: "完成", exact: true }).click().catch(() => {});
  return { path, said: "" };
}
/** A fresh copy (it holds the sample notes) erases them through the way in and arrives at the screen that asks for the file. */
async function toBringScreen(page) {
  await openSettingsData(page);
  await page.getByText("從另一台裝置帶過來", { exact: true }).first().scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "帶過來…" }).click();
  const loaded = page.waitForEvent("load", { timeout: 90_000 });
  await page.getByRole("button", { name: "清除全部並繼續", exact: true }).click();
  await page.getByRole("button", { name: "清除並繼續", exact: true }).click();
  await loaded;
  await page.getByRole("button", { name: "選擇你另一台裝置的檔案…" }).waitFor({ timeout: 120_000 });
}
const chooseFile = (page, path) => page.locator('input[type="file"]').setInputFiles(path);
const NOTES_IN = "你的筆記都在，舊版本還沒全部到";
const ARRIVED = "你的筆記到了";

try {
  // ── device A: a note saved three times, so it has earlier versions; its file ──
  const ctxA = await freshDevice();
  const pageA = await openPage(ctxA);
  const N1 = "00000000-0000-4000-8000-000000009301";
  await call(pageA, "POST", "/api/nodes", { id: N1, title: "有歷史的筆記", markdown: "第一版" });
  await call(pageA, "PATCH", `/api/nodes/${N1}`, { markdown: "第二版" });
  await call(pageA, "PATCH", `/api/nodes/${N1}`, { markdown: "第三版" });
  await waitSaved(pageA);
  const versionsA = await versionsOf(pageA, N1);
  check(versionsA >= 3, "device A's note has its earlier versions", String(versionsA));
  const full = await makeFile(pageA, "A");
  check(full.path !== null, "device A makes the file", full.said.slice(0, 80));
  await ctxA.close();
  // the same file, stopped right after the notes: its earlier versions never came
  const lines = readFileSync(full.path, "utf8").split("\n");
  const rowsDone = lines.findIndex((l) => l.startsWith('{"kind":"rows-done"'));
  check(rowsDone > 0 && rowsDone < lines.length - 2, "the file has a part after the notes (their earlier versions)", `${rowsDone} of ${lines.length} lines`);
  const cut = join(work, "cut.onden");
  writeFileSync(cut, lines.slice(0, rowsDone + 1).join("\n") + "\n");
  // cut in the middle of a line: of the notes (D), of the earlier versions (B)
  const cutInNotes = join(work, "cut-in-notes.onden");
  writeFileSync(cutInNotes, `${lines.slice(0, rowsDone - 1).join("\n")}\n${lines[rowsDone - 1].slice(0, Math.floor(lines[rowsDone - 1].length / 2))}`);
  const cutInVersions = join(work, "cut-in-versions.onden");
  writeFileSync(cutInVersions, `${lines.slice(0, rowsDone + 1).join("\n")}\n${lines[rowsDone + 1].slice(0, Math.floor(lines[rowsDone + 1].length / 2))}`);

  // ── device D: cut in the middle of a line of the notes ──
  const ctxD = await freshDevice();
  const pageD = await openPage(ctxD);
  await toBringScreen(pageD);
  await chooseFile(pageD, cutInNotes);
  await pageD.getByText("筆記沒有帶過來").first().waitFor({ timeout: 300_000 });
  const saidD = await text(pageD);
  const readyD = await call(pageD, "GET", "/api/snapshot/readiness");
  check(/什麼都沒有留下：這台裝置又是空的了/.test(saidD) && readyD.ready === true, "D, cut in a line of the notes, says nothing was kept, and it is empty", saidD.replace(/\s+/g, " ").slice(0, 120));
  check(!technical(saidD), "D's screen uses no technical words");
  await shot(pageD, "D-1-cut-in-notes");
  await ctxD.close();

  // ── device B: the cut file, then Settings, then the whole file ──
  const ctxB = await freshDevice();
  let pageB = await openPage(ctxB);
  await toBringScreen(pageB);
  await chooseFile(pageB, cutInVersions);
  await pageB.getByText(NOTES_IN).first().waitFor({ timeout: 300_000 });
  await shot(pageB, "B-1-notes-in");
  let said = await text(pageB);
  check(!said.includes(ARRIVED) && !/連同筆記的舊版本|全部內容/.test(said), "B never says everything came", said.replace(/\s+/g, " ").slice(0, 120));
  check(/舊版本沒有全部到/.test(said) && /你的筆記都帶過來了/.test(said), "B says the notes came and the earlier versions did not all come");
  check(/這個檔案在舊版本還沒完的地方就結束了/.test(said) && !/什麼都沒有留下|又是空的/.test(said), "B, cut in a line of the earlier versions, says the file ended there, and never that nothing was kept", said.replace(/\s+/g, " ").slice(0, 160));
  check(await pageB.getByRole("button", { name: "再選一次同一個檔案…" }).isVisible() && await pageB.getByRole("button", { name: "不再等這些舊版本" }).isVisible(), "B offers the same file again and to stop waiting");
  check(!technical(said), "B's screen uses no technical words");
  // the notes are usable now
  const loadedB = pageB.waitForEvent("load", { timeout: 60_000 });
  await pageB.getByRole("button", { name: "打開我的筆記" }).click();
  await loadedB;
  await pageB.getByText(READY_TEXT).first().waitFor({ state: "attached", timeout: 120_000 });
  const noteOnB = (await call(pageB, "GET", "/api/bootstrap")).nodes.find((n) => n.id === N1);
  check(noteOnB?.markdown?.includes("第三版"), "B's notes are usable before the earlier versions are all in");
  // Settings: no file yet, why, and what to do
  const refused = await makeFile(pageB, "B-early");
  await shot(pageB, "B-2-settings-refused");
  check(refused.path === null && /舊版本還沒全部到/.test(refused.said), "B's Settings says why it cannot make a file yet", refused.said.replace(/\s+/g, " ").slice(0, 140));
  check(/再給這台裝置一次|不再等/.test(refused.said) && !technical(refused.said), "and what to do, in plain words");
  check(!/再確認一次/.test(refused.said), "and does not offer to confirm again, which cannot help");
  // the way back from Settings: the same screen, never an erase
  await pageB.getByRole("button", { name: "帶進舊版本…" }).click();
  await pageB.getByRole("button", { name: "繼續", exact: true }).waitFor({ timeout: 30_000 });
  check(!/清除全部/.test(await pageB.getByRole("dialog").last().innerText()), "the way back does not offer to erase the notes");
  const reloadB = pageB.waitForEvent("load", { timeout: 60_000 });
  await pageB.getByRole("button", { name: "繼續", exact: true }).click();
  await reloadB;
  await pageB.getByText(NOTES_IN).first().waitFor({ timeout: 120_000 });
  // the whole file brings the rest
  const arrived = pageB.getByText(ARRIVED).first().waitFor({ timeout: 300_000 });
  await chooseFile(pageB, full.path);
  await arrived;
  await shot(pageB, "B-3-arrived");
  said = await text(pageB);
  check(/連同筆記的舊版本/.test(said) && !technical(said), "B now says everything up to the file came, with the earlier versions");
  await pageB.waitForEvent("load", { timeout: 60_000 }).catch(() => {});
  await pageB.getByText(READY_TEXT).first().waitFor({ state: "attached", timeout: 120_000 });
  check(await versionsOf(pageB, N1) === versionsA, "B has every earlier version A has", `${await versionsOf(pageB, N1)} vs ${versionsA}`);
  const fromB = await makeFile(pageB, "B");
  check(fromB.path !== null, "B can now make a file itself", fromB.said.slice(0, 80));
  await ctxB.close();

  // ── device C: the cut file, then stop waiting ──
  const ctxC = await freshDevice();
  const pageC = await openPage(ctxC);
  await toBringScreen(pageC);
  await chooseFile(pageC, cut);
  await pageC.getByText(NOTES_IN).first().waitFor({ timeout: 300_000 });
  await pageC.getByRole("button", { name: "不再等這些舊版本" }).click();
  await pageC.getByRole("button", { name: "不再等", exact: true }).click();
  await pageC.getByText(/這台裝置不再等這些舊版本/).waitFor({ timeout: 60_000 });
  await shot(pageC, "C-1-stopped");
  said = await text(pageC);
  check(!technical(said) && !/連同筆記的舊版本/.test(said), "C says it no longer waits, and not that the earlier versions came");
  check(/補進來之前，不能從這台替另一台裝置做檔案/.test(said), "C says that until they are brought in no file can be made from it");
  const loadedC = pageC.waitForEvent("load", { timeout: 60_000 });
  await pageC.getByRole("button", { name: "打開我的筆記" }).click();
  await loadedC;
  await pageC.getByText(READY_TEXT).first().waitFor({ state: "attached", timeout: 120_000 });
  check((await call(pageC, "GET", "/api/bootstrap")).nodes.find((n) => n.id === N1)?.markdown?.includes("第三版"), "C's notes stayed");
  const readyC = await call(pageC, "GET", "/api/snapshot/readiness");
  check(readyC.code === "join_history_missing", "C is not waiting any more: it has no earlier versions", JSON.stringify(readyC).slice(0, 80));
  await openSettingsData(pageC);
  const rowC = await pageC.locator("body").innerText();
  check(/這台沒有筆記的舊版本，所以還不能替另一台裝置做檔案/.test(rowC), "C's Settings row says it has no earlier versions, before anything is tried");
  const refusedC = await makeFile(pageC, "C-early");
  await shot(pageC, "C-2-settings-refused");
  check(refusedC.path === null && /沒有舊版本/.test(refusedC.said) && /那台會拿到沒有歷史的筆記/.test(refusedC.said), "C cannot make a file, and says why in plain words", refusedC.said.replace(/\s+/g, " ").slice(0, 140));
  check(!/再確認一次|不再等/.test(refusedC.said) && !technical(refusedC.said), "and offers neither to confirm again nor to stop waiting");
  // the way back from Settings: the screen that says it, then A's file brings only the earlier versions
  const notesC = JSON.stringify((await call(pageC, "GET", "/api/bootstrap")).nodes.map((n) => [n.id, n.title, n.markdown]));
  await pageC.getByRole("button", { name: "帶進舊版本…" }).click();
  await pageC.getByRole("button", { name: "繼續", exact: true }).waitFor({ timeout: 30_000 });
  check(!/清除全部/.test(await pageC.getByRole("dialog").last().innerText()), "the way back does not offer to erase the notes");
  const reloadC = pageC.waitForEvent("load", { timeout: 60_000 });
  await pageC.getByRole("button", { name: "繼續", exact: true }).click();
  await reloadC;
  await pageC.getByText("這台沒有舊版本", { exact: true }).waitFor({ timeout: 120_000 });
  await shot(pageC, "C-3-no-history");
  said = await text(pageC);
  check(/只會從檔案收舊版本，這台的筆記不會改/.test(said) && !technical(said), "C's screen says it has no earlier versions and that a file brings only those");
  const refilled = pageC.getByText(/筆記的舊版本現在都在這台了/).waitFor({ timeout: 300_000 });
  await chooseFile(pageC, full.path);
  await refilled;
  await shot(pageC, "C-4-refilled");
  const loadedC2 = pageC.waitForEvent("load", { timeout: 60_000 });
  await pageC.getByRole("button", { name: "打開我的筆記" }).click().catch(() => {});
  await loadedC2.catch(() => {});
  await pageC.getByText(READY_TEXT).first().waitFor({ state: "attached", timeout: 120_000 });
  check(JSON.stringify((await call(pageC, "GET", "/api/bootstrap")).nodes.map((n) => [n.id, n.title, n.markdown])) === notesC, "C's notes were not changed by bringing the earlier versions in");
  check(await versionsOf(pageC, N1) === versionsA, "C now has every earlier version A has", `${await versionsOf(pageC, N1)} vs ${versionsA}`);
  const fromC = await makeFile(pageC, "C");
  check(fromC.path !== null, "C can make a file now", fromC.said.slice(0, 80));
  await ctxC.close();
} catch (error) {
  console.log(`FAIL unexpected error: ${error?.stack ?? error}`);
  failures.push("unexpected error");
}
await browser.close();
site.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed in ${engine}`); process.exit(1); }
console.log(`\nall checks passed in ${engine}`);
