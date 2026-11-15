#!/usr/bin/env node
// 寫到底不黏底: the room under the last line shows only when needed (browser app, real editor):
//   node e2e/browser-app/endRoomNoJump.mjs [chromium|mobile-chrome]
// 1. An empty note: the line under the body (the relations block) is at the same y with the caret in the title and in the body.
// 2. A long note: with the caret on the last line, that line has risen off the bottom of the visible window.
// The mobile-chrome viewport is an emulation (Pixel 5 size, touch), not a phone.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "chromium";
const device = playwright.devices[engine === "mobile-chrome" ? "Pixel 5" : "Desktop Chrome"];
const site = await serve(resolve(here, "../..", "dist-browser"));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...device, ...(engine === "chromium" ? { viewport: { width: 1280, height: 800 } } : {}), locale: "zh-TW" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  const api = (path, method = "GET", body) => page.evaluate(async ([p, m, b]) => {
    const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, ...(b ? { body: JSON.stringify(b) } : {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, method, body]);
  const open = async (id) => {
    for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) break; await page.waitForTimeout(400); }
    await page.goto(`${site.base}?view=notes&node=${id}`);
    await page.locator(".md-editor-cm .cm-content").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(800);
  };
  const relationsTop = async () => { const h = page.locator(".note-relations").first(); await h.waitFor({ state: "visible", timeout: 20_000 }); return h.evaluate((el) => Math.round(el.getBoundingClientRect().top)); };
  const blurEditor = () => page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

  // 1. Empty body: where the caret is must not move the layout.
  const empty = await api("/api/nodes", "POST", { title: `空內文 ${Date.now()}`, markdown: "" });
  // A sub-note makes the relations block (and its divider) appear under the body.
  const child = await api("/api/nodes", "POST", { title: `子筆記 ${Date.now()}`, markdown: "子筆記內文", parent_id: empty.json.id });
  check("sub-note created", child.status === 200 || child.status === 201, `status ${child.status}`);
  await open(empty.json.id);
  await page.locator(".obsidian-title-input").first().click();
  await page.waitForTimeout(400);
  const inTitle = await relationsTop();
  await page.locator(".md-editor-cm .cm-content").first().click();
  await page.waitForTimeout(600);
  const inBody = await relationsTop();
  check("empty note: the line under the body stays put when the caret enters the body", inTitle === inBody, `title ${inTitle}, body ${inBody}`);
  check("empty note: no room block while focused", await page.locator(".cm-end-room").count() === 0);
  await page.keyboard.type("hello");
  await page.waitForTimeout(400);
  check("short note: typing does not add room", await page.locator(".cm-end-room").count() === 0);
  await blurEditor();
  await page.waitForTimeout(400);

  // 2. Long note: writing on the last line lifts it off the bottom edge.
  const lines = Array.from({ length: 90 }, (_, i) => `第 ${i + 1} 行文字內容`).join("\n\n");
  const long = await api("/api/nodes", "POST", { title: `長筆記 ${Date.now()}`, markdown: lines });
  await open(long.json.id);
  await page.locator(".md-editor-cm .cm-content").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" 結尾");
  await page.waitForTimeout(800);
  const gap = await page.evaluate(() => {
    const all = document.querySelectorAll(".md-editor-cm .cm-line");
    const last = all[all.length - 1].getBoundingClientRect();
    return Math.round((window.visualViewport?.height ?? window.innerHeight) - last.bottom);
  });
  check("long note: the last line rose off the bottom edge", gap >= 40, `${gap}px above the bottom`);
  check("long note: room block is there while writing", await page.locator(".cm-end-room").count() === 1);
  await blurEditor();
  await page.waitForTimeout(600);
  check("long note: room is gone after leaving the editor", await page.locator(".cm-end-room").count() === 0);
  check("no script errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  site.close();
}
console.log(`${engine}: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
