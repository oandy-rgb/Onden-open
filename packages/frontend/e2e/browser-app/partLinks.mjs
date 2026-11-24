#!/usr/bin/env node
// Part links `[[筆記/段落開頭]]` in the browser app (docs/architecture/proposals/block-anchors-2026-11-01.md §12 批 2), in a real engine:
// make a link with `((`, embed with `!((`, rename the heading and reword the paragraph (the link follows), delete the paragraph,
// go offline — taking a screenshot of each state.
//   node e2e/browser-app/partLinks.mjs [chromium|mobile-chrome] [--dir dist-browser] [--out <folder>]
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
const site = await serve(root);
const device = playwright.devices[engine === "mobile-chrome" ? "Pixel 5" : "Desktop Chrome"];
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...device, locale: "zh-TW" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const shot = (name) => page.screenshot({ path: join(out, `${engine}-${name}.png`) });
const WELCOME = "歡迎來到 Onden 試用版";
const open = async () => { await page.goto(site.base); await page.getByText(WELCOME).first().waitFor({ state: "attached", timeout: 90_000 }); };
const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  return r.status === 204 ? null : r.json();
}, [method, path, body]);
const until = async (probe, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return true; await page.waitForTimeout(300); } return false; };
const bodyOf = async (id) => (await api("GET", `/api/nodes/${id}`)).markdown;
const MEAL = "# 晚餐\n\n17:45–21:15 吃飯，很久。\n\n下次少點一道菜。\n";

try {
  await open();
  const meal = await api("POST", "/api/nodes", { title: "吃飯紀錄", markdown: MEAL });
  const src = await api("POST", "/api/nodes", { title: "來源筆記", markdown: "看 " });
  check("the two notes were made", !!meal?.id && !!src?.id, `${meal?.id} ${src?.id}`);
  await page.waitForTimeout(2500); // past the save's quiet period, before the reload
  await open();
  // The address the app itself writes for a note (hooks/useUrlLocation: ?view=notes&node=<id>) opens it.
  const openNote = async (id, first) => {
    await page.goto(`${site.base}?view=notes&node=${id}`);
    await page.locator(".cm-content", { hasText: first }).first().waitFor({ timeout: 40_000 });
  };
  await openNote(src.id, "看");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("((17:45");
  const row = page.locator(".slash-menu-item", { hasText: "吃飯，很久" }).first();
  await row.waitFor({ timeout: 20_000 });
  await shot("1-pick");
  await row.dispatchEvent("mousedown");
  const written = await until(async () => (await editor.innerText()).includes("吃飯紀錄 › 17:45–21:15"));
  check("the link reads 「筆記 › 開頭」 in the editor, not its raw text", written, (await editor.innerText()).slice(0, 80));
  check("the editor's text is the readable link, with no id anywhere", (await page.evaluate(() => document.body.innerText)).search(/\^[0-9a-f]{4,}|[0-9a-f]{8}-[0-9a-f]{4}/) === -1);
  await page.keyboard.type("\n\n!((下次");
  const row2 = page.locator(".slash-menu-item", { hasText: "下次少點" }).first();
  await row2.waitFor({ timeout: 20_000 });
  await row2.dispatchEvent("mousedown");
  await page.keyboard.type("\n\n結束");
  await shot("2-link-and-embed");
  const bound = await until(async () => ((await api("GET", "/api/bootstrap")).note_link_bindings ?? []).some((b) => b.note_id === src.id));
  check("the server bound the link to the paragraph (a table beside the text, not the text)", bound);
  const stored = await until(async () => (await bodyOf(src.id)).includes("[[吃飯紀錄/17:45"));
  check("the saved text is [[筆記/開頭]] — readable, no marker", stored, (await bodyOf(src.id)).replace(/\n/g, "⏎").slice(0, 120));

  // The paragraph's words change and the heading is renamed: the link follows by identity.
  await api("PATCH", `/api/nodes/${meal.id}`, { markdown: MEAL.replace("# 晚餐", "# 晚餐與宵夜").replace("17:45–21:15 吃飯，很久。", "17:45–21:15 吃飯，吃很久。") });
  await page.waitForTimeout(2500);
  await openNote(src.id, "看");
  await page.waitForTimeout(4000); // the sync delta that brings the anchors arrives a moment after the first paint
  // On a failure, what the editor shows instead (only this script's own words): a stale draw and a wrong text differ.
  const editorText = async () => (await page.locator(".cm-content").first().innerText().catch(() => "(no editor)")).replace(/\n/g, "⏎").slice(0, 160);
  const reworded = await until(async () => (await page.locator(".cm-content").first().innerText()).includes("吃飯，吃很久"), 90_000);
  check("after the paragraph is reworded the link shows its new words", reworded, reworded ? "" : `editor: ${await editorText()}`);
  await shot("3-reworded");

  // Offline: the words come from the copy on this device.
  await context.setOffline(true);
  await page.waitForTimeout(1500);
  const offlineReads = await until(async () => (await page.locator(".cm-content").first().innerText()).includes("吃飯紀錄 › 17:45"));
  check("offline, the link still reads 「筆記 › 開頭」", offlineReads, offlineReads ? "" : `editor: ${await editorText()}`);
  await shot("4-offline");
  await context.setOffline(false);

  // The paragraph is deleted: the link falls back to the note and says so.
  await api("PATCH", `/api/nodes/${meal.id}`, { markdown: "# 晚餐與宵夜\n\n下次少點一道菜。\n" });
  await page.waitForTimeout(2500);
  await openNote(src.id, "看");
  await page.waitForTimeout(4000);
  await shot("5-paragraph-deleted");
  const text = await page.locator(".cm-content").first().innerText();
  check("a deleted paragraph is never replaced by another one", !text.includes("吃飯紀錄 › 下次少點一道菜。\n") && !/吃飯紀錄 › 17:45–21:15 吃飯[，。]/.test(text.split("⏎")[0] ?? ""), text.replace(/\n/g, "⏎").slice(0, 120));
  check("no script errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  check(`run to the end (${String(error.message).split("\n")[0]})`, false);
  await shot("failed").catch(() => {});
}
await browser.close();
site.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${engine}: ${results.length - failed}/${results.length} passed; screenshots in ${out}`);
process.exit(failed ? 1 : 0);
