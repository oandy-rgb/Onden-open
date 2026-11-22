#!/usr/bin/env node
// 鍵盤打開、可見高度很小時，頂欄與分頁列讓路，字有更多地方（短高度打字版面）:
//   node e2e/browser-app/shortTypingLayout.mjs [mobile-chrome | tablet]
// Keyboard: the WINDOW shrinks (resizes-content, what the owner's Tab S9 does) and a fake visualViewport follows it, in the
// same three steps as caretClearOfBar.mjs. Emulation, not the tablet.
// Reports the text height before/after: bar top minus the lowest bottom edge of the rows above the text.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { TAB_S9 } from "./lib/devices.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const tablet = process.argv[2] === "tablet";
const device = tablet ? TAB_S9 : playwright.devices["Pixel 5"];
const FULL = device.viewport.height;
// Keyboard sizes that leave 373 px (tablet) / 420 px (phone) visible, as the owner described.
const STAGES = tablet ? [150, 110, 81] : [150, 100, 57];
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const site = await serve(resolve(here, "../..", "dist-browser"));
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...device, locale: "zh-TW" });
await context.addInitScript(() => {
  const vv = Object.assign(new EventTarget(), { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  window.addEventListener("resize", () => { vv.height = window.innerHeight; vv.dispatchEvent(new Event("resize")); });
});
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
  const note = await api("/api/nodes", "POST", { title: `短版面 ${Date.now()}`, markdown: Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行文字內容`).join("\n\n") });
  for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) break; await page.waitForTimeout(400); }
  await page.goto(`${site.base}?view=notes&node=${note.json.id}`);
  await page.locator(".md-editor-cm .cm-content").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);

  const state = () => page.evaluate(() => {
    const shown = (e) => e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().height > 0;
    const rows = [".app-topbar", ".center-lens-bar", ".phone-view-tabs", ".overview-mobile-tabs"].map((s) => document.querySelector(s)).filter(shown);
    const chromeBottom = Math.max(0, ...rows.map((e) => Math.round(e.getBoundingClientRect().bottom)));
    const bar = document.querySelector(".md-mobile-toolbar")?.getBoundingClientRect();
    const sel = window.getSelection();
    const line = [...document.querySelectorAll(".md-editor-cm .cm-line")].find((l) => l.contains(sel?.focusNode ?? null))?.getBoundingClientRect();
    return { attr: document.documentElement.hasAttribute("data-typing-short"), rows: rows.length, chromeBottom, barTop: bar ? Math.round(bar.top) : null, text: bar ? Math.round(bar.top) - chromeBottom : null, lineTop: line ? Math.round(line.top) : null, lineBottom: line ? Math.round(line.bottom) : null, vh: innerHeight };
  });
  const setKeyboard = async (px) => { await page.setViewportSize({ width: device.viewport.width, height: FULL - px }); await page.waitForTimeout(700); };

  const before = await state();
  check("keyboard closed: nothing stepped aside", !before.attr && before.rows > 0, JSON.stringify(before));
  // Scrolled down 400 px, so there is room to scroll back by what the rows give (near the top of a note the text
  // follows its column up by their height: nothing can scroll above the top).
  await page.evaluate(() => { const m = document.querySelector(".obsidian-main"); if (m && m.scrollHeight > m.clientHeight) m.scrollTop = 400; else window.scrollTo(0, 400); });
  await page.waitForTimeout(300);
  // Tap a line high up so it stays clear of the bar at every step (nothing may scroll to keep it in view).
  const idx = await page.evaluate(() => [...document.querySelectorAll(".md-editor-cm .cm-line")].findIndex((l) => { const b = l.getBoundingClientRect(); return b.height > 0 && b.top > 150 && b.bottom < 260; }));
  const box = await page.locator(".md-editor-cm .cm-line").nth(idx).boundingBox();
  await page.touchscreen.tap(box.x + 20, box.y + box.height / 2);
  await page.waitForTimeout(500);

  let total = STAGES[0];
  await page.setViewportSize({ width: device.viewport.width, height: FULL - total });
  await page.waitForTimeout(900);
  const s1 = await state();
  const open1 = await state();
  for (const step of STAGES.slice(1)) { total += step; await page.setViewportSize({ width: device.viewport.width, height: FULL - total }); await page.waitForTimeout(300); }
  await page.waitForTimeout(900);
  const s2 = await state();
  const withKeyboard = s2.vh < 520;
  check(`keyboard up (${s2.vh} px visible): the rows above the text stepped aside (top bar, tab strip)`, withKeyboard ? s2.attr && s2.chromeBottom < before.chromeBottom : !s2.attr, JSON.stringify(s2));
  console.log("INFO  text height in px (keyboard up):", JSON.stringify({ keyboardClosedTopRows: before.chromeBottom, keyboardUpTopRows: s2.chromeBottom, textAboveBarWithRows: s2.barTop - before.chromeBottom, textAboveBarWithout: s2.text }));
  check("the caret's line did not move when they stepped aside", Math.abs(s2.lineTop - s1.lineTop) <= 2, `${s1.lineTop} -> ${s2.lineTop}`);
  check("the caret's line is above the bar", s2.lineBottom <= s2.barTop, JSON.stringify(s2));

  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  await setKeyboard(0);
  const after = await state();
  check("keyboard closed: they are back", !after.attr && after.rows === before.rows, JSON.stringify(after));
  check("no script errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  site.close();
}
console.log(`${tablet ? "tablet" : "mobile-chrome"}: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
