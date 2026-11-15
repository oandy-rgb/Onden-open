#!/usr/bin/env node
// 手機鍵盤開著捲動不抖、打字游標停在工具列上方: with the keyboard up (fake visualViewport, like caretClearOfBar),
// (1) a hand scroll in small steps while the visual viewport pans every frame makes the page code call no
// scrollTo/scrollBy/scrollIntoView and scrollY never reverses; (2) typing with the caret behind the bar brings it
// above the bar. Run: node e2e/browser-app/keyboardScrollNoJitter.mjs
// NOT a phone: no real IME, no browser-made pan. The real-device check is the owner's, over adb.
// Keyboard simulation: window.visualViewport is replaced by a fake whose height shrinks and fires `resize`
// (what useVirtualKeyboard reads). This is NOT a phone: no real IME, no browser-made pan of the page.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const device = playwright.devices["Pixel 5"];
const KEYBOARD = 300;
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
  // The browser pans the visual viewport while a hand scroll goes on: bounce offsetTop like the real phone did.
  window.__pan = (top) => { vv.offsetTop = top; vv.dispatchEvent(new Event("scroll")); };
  // Count every scroll the page's own code asks for; the test scrolls with the originals saved here.
  window.__orig = { scrollBy: window.scrollBy.bind(window), scrollTo: window.scrollTo.bind(window) };
  window.__calls = [];
  for (const name of ["scrollBy", "scrollTo"]) window[name] = (...a) => { window.__calls.push(name); return window.__orig[name](...a); };
  for (const name of ["scrollIntoView", "scrollBy", "scrollTo"]) {
    const o = Element.prototype[name];
    Element.prototype[name] = function (...a) { window.__calls.push(`Element.${name}`); return o.apply(this, a); };
  }
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
  const open = async (id) => {
    for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) break; await page.waitForTimeout(400); }
    await page.goto(`${site.base}?view=notes&node=${id}`);
    await page.locator(".md-editor-cm .cm-content").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(800);
  };
  const setKeyboard = async (px) => { await page.evaluate((p) => window.__setKeyboard(p), px); await page.waitForTimeout(700); };
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
  const content = page.locator(".md-editor-cm .cm-content").first();
  await content.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.__orig.scrollTo(0, 600));
  await page.waitForTimeout(300);
  // Focus a line near the top of the window, then the keyboard rises.
  const idx = await page.evaluate(() => [...document.querySelectorAll(".md-editor-cm .cm-line")].findIndex((l) => { const b = l.getBoundingClientRect(); return b.top > 150 && b.top < 260; }));
  const box = await lineIndexAt(idx).boundingBox();
  await page.touchscreen.tap(box.x + 20, box.y + box.height / 2);
  await page.waitForTimeout(300);
  await setKeyboard(KEYBOARD);
  await page.waitForTimeout(500);

  // 1. Hand scroll in small steps while the visual viewport bounces every frame.
  await page.evaluate(() => { window.__calls.length = 0; });
  const trace = await page.evaluate(async () => {
    const ys = [];
    const pans = [222, 214, 232, 212, 227, 210, 224, 208];
    for (let i = 0; i < 80; i++) {
      window.__orig.scrollBy(0, 6);
      window.__pan(pans[i % pans.length]);
      await new Promise((r) => requestAnimationFrame(r));
      ys.push(Math.round(window.scrollY));
    }
    return ys;
  });
  const calls = await page.evaluate(() => window.__calls.slice());
  const reversals = trace.slice(1).filter((y, i) => y < trace[i]).length;
  check("hand scroll with the visual viewport bouncing: the page code asks for no scroll", calls.length === 0, calls.join(","));
  check("scrollY only moves forward (no direction reversal)", reversals === 0 && trace.at(-1) > trace[0], `${trace[0]} -> ${trace.at(-1)}, reversals ${reversals}`);
  await page.evaluate(() => window.__pan(0));

  // 2. Typing with the caret behind the bar: move the page so the caret's line is under the bar, type one character.
  await page.evaluate(() => {
    const bar = document.querySelector(".md-mobile-toolbar").getBoundingClientRect();
    const sel = window.getSelection();
    const line = [...document.querySelectorAll(".md-editor-cm .cm-line")].find((l) => l.contains(sel.focusNode));
    window.__orig.scrollBy(0, line.getBoundingClientRect().top - (bar.top + 10)); // the line now sits under the bar
  });
  await page.waitForTimeout(300);
  const behind = await geometry();
  check("setup: the caret line is behind the bar", behind.lineTop >= behind.barTop, JSON.stringify(behind));
  await page.keyboard.type("x");
  await page.waitForTimeout(500);
  const typed = await geometry();
  check("typing: the caret's line ends above the bar", typed.barTop !== null && typed.lineBottom !== null && typed.lineBottom <= typed.barTop, `before ${JSON.stringify(behind)} after ${JSON.stringify(typed)}`);
  check("no script errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  site.close();
}
console.log(`mobile-chrome: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
