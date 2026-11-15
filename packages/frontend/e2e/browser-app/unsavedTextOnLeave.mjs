// npm run build:browser (repo root), then: node e2e/browser-app/unsavedTextOnLeave.mjs [chromium|mobile-chrome] [--dir dist-browser]
// Text typed into an attribute box and a table cell, then the page is hidden and closed WITHOUT leaving the box (no
// blur, no Enter), is there when the app is opened again: in the box and on the server side of the browser app.
// mobile-chrome is Chromium with Pixel 5's window, touch and pixel ratio: an emulation, not a phone.
// Exit code 1 when a check fails; 2 when the browser cannot start.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { serve } from "./serve.mjs";
import { contextOptions, VIEWPORTS, READY_TEXT, waitSaved } from "../layout-audit/env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = process.argv[2] === "mobile-chrome" ? "mobile-chrome" : "chromium";
const dirArg = process.argv.indexOf("--dir");
const vp = VIEWPORTS.find((v) => v.id === (engine === "mobile-chrome" ? "pixel5" : "1280"));
const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} [${engine}] ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(what); };

let browser;
try { browser = await playwright.chromium.launch(); } catch (error) { console.log(`SKIPPED: ${String(error).slice(0, 160)}`); process.exit(2); }
const site = await serve(resolve(here, "../..", dirArg > 0 ? process.argv[dirArg + 1] : "dist-browser"));
const context = await browser.newContext(contextOptions(vp));
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TAG = id(7001), NOTE = id(7002), PARENT = id(7003), ROW = id(7004);
const ATTRIBUTE_TEXT = "離開前打的屬性文字", CELL_TEXT = "離開前打的儲存格文字";

const openPage = async (path) => {
  const page = await context.newPage();
  await page.goto(`${site.base}${path}`);
  await page.getByText(READY_TEXT).first().waitFor({ state: "attached", timeout: 120_000 });
  return page;
};
const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}, { method, path, body });
/** The page is going away with the box still focused: the events a closing tab or a killed app gives, then the tab goes. */
const leave = async (page) => {
  await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); });
  await page.waitForTimeout(400);
  await page.close();
};
const attributeValue = (page, nodeId, key) => page.evaluate(async ({ nodeId, key }) => {
  const rows = await (await fetch(`/api/nodes/${nodeId}/attributes?keys=${key}`)).json();
  return (Array.isArray(rows) ? rows : []).find((a) => a.key === key)?.value ?? null;
}, { nodeId, key });
const until = async (probe, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 400)); } return false; };

// Setup: a tag with a text field on a note; a parent note whose table view lists a child's "price".
let page = await openPage("");
await call(page, "POST", "/api/tags", { id: TAG, name: "離開測試" });
await call(page, "PATCH", `/api/tags/${TAG}/schema`, { fields: [{ name: "topic", type: "text" }] });
await call(page, "POST", "/api/nodes", { id: NOTE, title: "屬性測試筆記", markdown: "內文", tag_ids: [TAG] });
await call(page, "POST", "/api/nodes", { id: PARENT, title: "表格測試筆記", markdown: "" });
await call(page, "POST", "/api/nodes", { id: ROW, title: "表格列", markdown: "", parent_id: PARENT });
await call(page, "PUT", `/api/nodes/${ROW}/attributes/price`, { value: "1", value_type: "text" });
const view = await call(page, "POST", `/api/nodes/${PARENT}/views`, { name: "表格", layout: "table", visible_fields: ["title", "price"] });
await waitSaved(page);
await page.close();

// 1. An attribute box.
page = await openPage(`?view=notes&node=${NOTE}&lens=editor`);
// The note's own field chip opens the same box as the info panel's (attributes/TextValueField).
await page.locator(".ff-cell", { hasText: "topic" }).first().click();
const box = page.locator('[aria-label="topic"]').first();
await box.waitFor({ state: "visible", timeout: 30_000 });
await box.click();
await box.fill(ATTRIBUTE_TEXT);
check(await box.evaluate((el) => document.activeElement === el), "the attribute box still has focus (no blur before leaving)");
await leave(page);
page = await openPage(`?view=notes&node=${NOTE}&lens=editor`);
check(await until(async () => (await attributeValue(page, NOTE, "topic")) === ATTRIBUTE_TEXT), "the attribute text is stored after the page was closed", String(await attributeValue(page, NOTE, "topic")));
await page.close();

// 2. A table cell.
page = await openPage(`?view=notes&node=${PARENT}&lens=editor&tab=${view.id}`);
const cell = page.locator(".cv-table-cell-edit").first();
await cell.waitFor({ state: "visible", timeout: 30_000 });
await cell.click();
const input = page.locator(".cv-table-cell-input");
await input.fill(CELL_TEXT);
check(await input.evaluate((el) => document.activeElement === el), "the table cell still has focus (no blur before leaving)");
await leave(page);
page = await openPage(`?view=notes&node=${PARENT}&lens=editor&tab=${view.id}`);
check(await until(async () => (await attributeValue(page, ROW, "price")) === CELL_TEXT), "the table cell text is stored after the page was closed", String(await attributeValue(page, ROW, "price")));
check(await until(async () => (await page.locator(".cv-table-cell-edit").first().innerText().catch(() => "")).includes(CELL_TEXT)), "the table shows the text when reopened");
await page.close();

await browser.close();
await site.close?.();
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
