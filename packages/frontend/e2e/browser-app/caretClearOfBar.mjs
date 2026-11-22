#!/usr/bin/env node
// 游標不被鍵盤工具列蓋住: on a phone, wherever the person taps, once the keyboard and the formatting bar are up the
// caret's line sits fully above the bar (browser app, real editor):
//   node e2e/browser-app/caretClearOfBar.mjs [mobile-chrome | tablet | ios]
// Keyboard simulation: window.visualViewport is replaced by a fake whose height shrinks and fires `resize`
// (what useVirtualKeyboard reads). `tablet` (lib/devices.mjs TAB_S9, 1204x714) does what the owner's tablet does,
// resizes-content: the WINDOW shrinks and the fake follows it. NOT a real device: no real IME, no browser-made pan.
// Two kinds of rise: ONE instant resize (a phone's keyboard), and STAGES (150 px, then +120, then +80 with 300 ms between:
// the Samsung Keyboard's extra top row rises slower; the 2026-11-20 miss was a scroll that ran after stage 1 only).
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
import { TAB_S9 } from "./lib/devices.mjs";
// tablet and mobile-chrome: Android, where the keyboard shrinks the WINDOW (resizes-content) and the fake visualViewport follows it;
// ios: an iPhone window where only the visual viewport shrinks (the editor's room under the last line is for this one).
const mode = process.argv[2] ?? "mobile-chrome";
const tablet = mode === "tablet";
const resizes = mode !== "ios";
const device = tablet ? TAB_S9 : mode === "ios" ? playwright.devices["iPhone 13"] : playwright.devices["Pixel 5"];
const KEYBOARD = tablet ? 350 : 300;
const STAGES = [150, 120, 80];
const site = await serve(resolve(here, "../..", "dist-browser"));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...device, locale: "zh-TW" });
await context.addInitScript(() => {
  const target = new EventTarget();
  const vv = Object.assign(target, { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  window.__setKeyboard = (px) => { vv.height = window.innerHeight - px; vv.dispatchEvent(new Event("resize")); };
  window.__followWindow = () => window.addEventListener("resize", () => { vv.height = window.innerHeight; vv.dispatchEvent(new Event("resize")); });
});
const page = await context.newPage();
if (resizes) await page.addInitScript(() => window.__followWindow());
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
  const FULL = device.viewport.height;
  const setKeyboardNow = (px) => resizes ? page.setViewportSize({ width: device.viewport.width, height: FULL - px }) : page.evaluate((p) => window.__setKeyboard(p), px);
  const setKeyboard = async (px) => { await setKeyboardNow(px); await page.waitForTimeout(700); };
  const riseInStages = async (pause = 300) => {
    let total = 0;
    for (const step of STAGES) { total += step; await setKeyboardNow(total); await page.waitForTimeout(pause); }
    await page.waitForTimeout(700);
  };
  // Geometry of the caret's line against the bar, in layout px.
  const geometry = () => page.evaluate(() => {
    const bar = document.querySelector(".md-mobile-toolbar")?.getBoundingClientRect();
    const sel = window.getSelection();
    const r = sel?.rangeCount ? sel.getRangeAt(0).getClientRects()[0] ?? (sel.focusNode?.parentElement ?? sel.focusNode)?.getBoundingClientRect?.() : null;
    const line = [...document.querySelectorAll(".md-editor-cm .cm-line")].find((l) => l.contains(sel?.focusNode ?? null))?.getBoundingClientRect();
    return { barTop: bar ? Math.round(bar.top) : null, lineTop: line ? Math.round(line.top) : null, lineBottom: line ? Math.round(line.bottom) : null, caretBottom: r ? Math.round(r.bottom) : null, scrollY: Math.round(window.scrollY), vh: window.innerHeight };
  });
  const lineIndexAt = (index) => page.locator(".md-editor-cm .cm-line").nth(index);
  const tapLineAtOrBelow = async (yMin) => {
    // The first visible line whose centre is at least yMin down the window.
    const idx = await page.evaluate((y) => {
      const lines = [...document.querySelectorAll(".md-editor-cm .cm-line")];
      return lines.findIndex((l) => { const b = l.getBoundingClientRect(); return b.height > 0 && b.top + b.height / 2 >= y && b.bottom < window.innerHeight - 4; });
    }, yMin);
    const box = await lineIndexAt(idx).boundingBox();
    await page.touchscreen.tap(box.x + 20, box.y + box.height / 2);
    return idx;
  };

  const body = Array.from({ length: 90 }, (_, i) => `第 ${i + 1} 行文字內容`).join("\n\n");
  const note = await api("/api/nodes", "POST", { title: `長筆記 ${Date.now()}`, markdown: body });
  await open(note.json.id);
  const vh = await page.evaluate(() => window.innerHeight);
  const content = page.locator(".md-editor-cm .cm-content").first();

  // 1. Keyboard not open yet; tap a line the keyboard is about to cover; then the keyboard rises.
  await content.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(300);
  // A line under where the keyboard will be but above the bottom navigation (iPhone window: the navigation covers the lowest 56 px).
  await tapLineAtOrBelow(mode === "ios" ? vh - 230 : vh - 160);
  await page.waitForTimeout(300);
  await setKeyboard(KEYBOARD);
  let g = await geometry();
  check("tap under the future keyboard: the line ends above the bar", g.barTop !== null && g.lineBottom !== null && g.lineBottom <= g.barTop, JSON.stringify(g));

  // 2. Caret near the top of the window: nothing scrolls.
  await page.evaluate(() => window.scrollTo(0, window.scrollY));
  const before = await page.evaluate(() => window.scrollY);
  const topIdx = await page.evaluate(() => [...document.querySelectorAll(".md-editor-cm .cm-line")].findIndex((l) => { const b = l.getBoundingClientRect(); return b.top > 120 && b.top < 200; }));
  const topBox = await lineIndexAt(topIdx).boundingBox();
  await page.touchscreen.tap(topBox.x + 20, topBox.y + topBox.height / 2);
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => window.scrollY);
  check("caret already visible above the bar: the page does not scroll", Math.abs(after - before) <= 1, `${before} -> ${after}`);

  // 3. Keyboard already open; tap another line down at the bar's edge.
  const barTop = (await geometry()).barTop;
  await tapLineAtOrBelow(barTop - 70);
  await page.waitForTimeout(700);
  g = await geometry();
  check("keyboard already open, tap a line near the bar: it ends above the bar", g.lineBottom <= g.barTop, JSON.stringify(g));

  // 4. The last line of the note.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  await setKeyboard(0);
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(400);
  const lastIdx = await page.locator(".md-editor-cm .cm-line").count() - 1;
  await page.locator(".md-editor-cm .cm-line").nth(lastIdx).scrollIntoViewIfNeeded();
  const lastBox = await lineIndexAt(lastIdx).boundingBox();
  await page.touchscreen.tap(lastBox.x + 20, lastBox.y + lastBox.height / 2);
  await page.waitForTimeout(300);
  await setKeyboard(KEYBOARD);
  g = await geometry();
  check("last line of the note: it ends above the bar", g.barTop !== null && g.lineBottom <= g.barTop, JSON.stringify(g));

  // 6. The keyboard rises in STAGES (150, +120, +80 px, 300 ms apart), the caret under where it ends up.
  // pause: between steps. 300 ms is longer than the editor's wait (6 frames); 150 ms and 40 ms are about as long and shorter than it.
  for (const [name, pickY, pause] of [["a line near the bottom", () => FULL - 170, 300], ["the last line of the note", null, 300], ["a line near the bottom, 150 ms between steps", () => FULL - 170, 150], ["a line near the bottom, 40 ms between steps", () => FULL - 170, 40]]) {
    await setKeyboard(0);
    await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
    await page.waitForTimeout(500);
    if (pickY) {
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.waitForTimeout(300);
      await tapLineAtOrBelow(pickY());
    } else {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const idx = await page.locator(".md-editor-cm .cm-line").count() - 1;
      await page.locator(".md-editor-cm .cm-line").nth(idx).scrollIntoViewIfNeeded();
      const b = await lineIndexAt(idx).boundingBox();
      await page.touchscreen.tap(b.x + 20, b.y + b.height / 2);
    }
    await page.waitForTimeout(300);
    await riseInStages(pause);
    g = await geometry();
    check(`staged rise, ${name}: it ends above the bar`, g.barTop !== null && g.lineBottom !== null && g.lineBottom <= g.barTop, JSON.stringify(g));
  }

  // 5. Closing the keyboard does not scroll.
  const s1 = await page.evaluate(() => window.scrollY);
  await setKeyboard(0);
  const s2 = await page.evaluate(() => window.scrollY);
  check("keyboard closing does not scroll", Math.abs(s1 - s2) <= 1, `${s1} -> ${s2}`);
  check("no script errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  site.close();
}
console.log(`${mode}: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
