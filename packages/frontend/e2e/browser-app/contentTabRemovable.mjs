#!/usr/bin/env node
// The 「內容」 tab can be removed from any note and added back from 「＋」, in a real engine (browser app, no server):
// remove 「內容」 on a note with text → the row has only the other tab → reload lands on that tab (the default) → the text is
// still found by search → add 「內容」 back from 「＋」 → the text is there, unchanged.
//   node e2e/browser-app/contentTabRemovable.mjs [chromium|mobile-chrome] [--dir dist-browser] [--out <folder>]
// chromium is 1440×900, mobile-chrome is 390×844 (a phone-sized viewport with touch emulation, not a phone).
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "chromium";
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const root = resolve(here, "../..", arg("--dir", "dist-browser"));
const out = resolve(arg("--out", join(here, "shots")));
mkdirSync(out, { recursive: true });
const phone = engine === "mobile-chrome";
const site = await serve(root);
const browser = await playwright.chromium.launch();
const context = await browser.newContext(phone
  ? { ...playwright.devices["Pixel 5"], viewport: { width: 390, height: 844 }, locale: "zh-TW" }
  : { ...playwright.devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, locale: "zh-TW" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const failures = [];
const check = (ok, name, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failures.push(name); };
const shot = (name) => page.screenshot({ path: join(out, `${engine}-${name}.png`) });
const workerUp = async () => { const end = Date.now() + 120_000; while (Date.now() < end) { if (await page.evaluate(async () => { try { return (await fetch("/api/browser-app/state")).ok; } catch { return false; } }).catch(() => false)) return true; await page.waitForTimeout(500); } return false; };
const open = async (query = "") => { await page.goto(`${site.base}${query}`); if (!(await workerUp())) throw new Error("the app's worker did not start"); };
const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  return r.status === 204 ? null : r.json();
}, [method, path, body]);
const until = async (probe, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return true; await page.waitForTimeout(300); } return false; };
const saved = () => until(async () => { const state = await api("GET", "/api/browser-app/state"); return !state.unsaved && state.lastSavedAt !== null; });

const WORD = "xyzzy獨特字句";
const row = () => page.locator(phone ? ".phone-view-tabs" : ".center-lens-bar .view-tabs");
const tabNames = async () => (await row().getByRole("tab").allTextContents()).map((name) => name.trim());
const selectedTab = async () => (await row().locator('[role="tab"][aria-selected="true"]').allTextContents()).map((name) => name.trim()).join("|");
const goNote = async (id) => { await open(`?view=notes&node=${id}&lens=editor`); await row().getByRole("tab").first().waitFor({ timeout: 40_000 }); await page.waitForTimeout(800); };

try {
  await open();
  const note = await api("POST", "/api/nodes", { title: "只用表格的筆記", markdown: `這則筆記有字：${WORD}\n` });
  await api("POST", `/api/nodes/${note.id}/views`, { name: "表格", layout: "table", visible_fields: ["title"] });
  await saved();
  await goNote(note.id);
  check((await tabNames()).join(",") === "內容,表格", "the row has 內容 and 表格", (await tabNames()).join(","));
  await shot("1-before");

  // 1 — remove 內容: the menu offers 「移除分頁」, the question says the text stays and where it is still used.
  await row().getByRole("tab", { name: "內容" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "移除分頁" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor({ timeout: 10_000 });
  const question = (await dialog.textContent()) ?? "";
  check(question.includes("文字還在，只是分頁看不見") && question.includes("搜尋、發布、匯出仍然包含它"), "the question says the text stays and search, publishing and export still include it", question.trim().slice(0, 80));
  await shot("2-question");
  await dialog.getByRole("button", { name: "移除" }).click();
  check(await until(async () => (await tabNames()).join(",") === "表格"), "the row has only 表格", (await tabNames()).join(","));
  check((await selectedTab()) === "表格", "the open page moved to 表格");
  await shot("3-removed");
  await saved();

  // 2 — a reload lands on the tab the note opens on now.
  await goNote(note.id);
  check((await tabNames()).join(",") === "表格" && (await selectedTab()) === "表格", "after a reload the page is on 表格 (the default), without 內容", `${(await tabNames()).join(",")} / ${await selectedTab()}`);
  // The bare address (no note tab, no remembered one) too.
  await page.evaluate(() => localStorage.clear());
  await goNote(note.id);
  check((await selectedTab()) === "表格", "the bare address opens on 表格");

  // 3 — the text is still the note's body, and search finds it.
  const body = await api("GET", `/api/nodes/${note.id}`);
  check(String(body?.markdown ?? "").includes(WORD), "the text is still the note's body");
  const found = await api("GET", `/api/nodes/search?q=${encodeURIComponent("xyzzy")}`);
  check(JSON.stringify(found).includes(note.id), "search finds the note by its text");

  // 4 — add it back from ＋: 「內容」 is offered, comes last, and shows the same text.
  await row().getByRole("button", { name: "新增檢視" }).click();
  const panel = page.getByRole("dialog", { name: "新增檢視" });
  await panel.waitFor({ timeout: 10_000 });
  check(((await panel.getByRole("button").allTextContents())[0] ?? "").trim().startsWith("內容"), "＋ lists 內容 first");
  await shot("4-add");
  await panel.getByRole("button", { name: /^內容/ }).click();
  check(await until(async () => (await tabNames()).join(",") === "表格,內容"), "內容 is back, last", (await tabNames()).join(","));
  check(await until(async () => (await selectedTab()) === "內容"), "and it is the open tab");
  check(await until(async () => (await page.locator(".cm-content, .obsidian-editor, textarea").first().textContent().catch(() => "")).includes(WORD) || (await page.locator("body").textContent()).includes(WORD)), "the text shows in 內容, unchanged");
  const after = await api("GET", `/api/nodes/${note.id}`);
  check(after?.markdown === body?.markdown, "the body is byte for byte what it was");
  await shot("5-back");

  check(errors.length === 0, "no page errors", errors.join(" | "));
} catch (error) {
  check(false, "the script ran to the end", String(error).slice(0, 300));
} finally {
  await browser.close();
  site.close();
}
if (failures.length > 0) { console.log(`\n${failures.length} failed: ${failures.join("; ")}`); process.exit(1); }
console.log(`\nall passed (${engine})`);
