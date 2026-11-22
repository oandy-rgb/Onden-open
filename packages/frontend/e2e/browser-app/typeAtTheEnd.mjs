#!/usr/bin/env node
// 打字時最下面不要突然塞空白: with the keyboard up, typing at the LAST line and pressing Enter ten times, the page's height grows by
// one line per Enter and by nothing else (no room under the last line that appears or grows), and the last line stays whole above the bar:
//   node e2e/browser-app/typeAtTheEnd.mjs [--profile pixel5|tablet|iphone13]
// Android (Pixel 5, the 1204x714 tablet): the window shrinks for the keyboard (resizes-content). iPhone: only the visual viewport shrinks;
// there the room under the last line is put in once, when the keyboard has settled, before any typing. Emulation, not a device.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { TAB_S9 } from "./lib/devices.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const only = process.argv.includes("--profile") ? process.argv[process.argv.indexOf("--profile") + 1] : null;
const PROFILES = [
  { name: "pixel5", device: playwright.devices["Pixel 5"], resizes: true, keyboard: 330 },
  { name: "tablet-1204x714", device: TAB_S9, resizes: true, keyboard: 350 },
  { name: "iphone13", device: playwright.devices["iPhone 13"], resizes: false, keyboard: 300 },
].filter((p) => !only || p.name.includes(only));
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const site = await serve(resolve(here, "../..", "dist-browser"));
const browser = await playwright.chromium.launch();
try {
  for (const profile of PROFILES) {
    const context = await browser.newContext({ ...profile.device, locale: "zh-TW" });
    await context.addInitScript(() => {
      const vv = Object.assign(new EventTarget(), { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
      window.__setKeyboard = (px) => { vv.height = window.innerHeight - px; vv.dispatchEvent(new Event("resize")); };
      window.__followWindow = () => window.addEventListener("resize", () => { vv.height = window.innerHeight; vv.dispatchEvent(new Event("resize")); });
    });
    const page = await context.newPage();
    if (profile.resizes) await page.addInitScript(() => window.__followWindow());
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await page.goto(site.base);
    await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
    const api = (path, method = "GET", body) => page.evaluate(async ([p, m, b]) => {
      const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, ...(b ? { body: JSON.stringify(b) } : {}) });
      return { status: r.status, json: await r.json().catch(() => null) };
    }, [path, method, body]);
    // A long note (its end is at the bottom of the screen at once) and a short one (typing brings its last line down to the bottom:
    // that is where a room that appears on the way used to make the page jump).
    for (const scenario of [{ name: "long note", lines: 40 }, { name: "short note", lines: 6 }]) {
      // Start each note with the keyboard down and nothing focused.
      await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
      if (profile.resizes) await page.setViewportSize({ width: profile.device.viewport.width, height: profile.device.viewport.height }); else await page.evaluate(() => window.__setKeyboard(0));
      await page.waitForTimeout(500);
      const note = await api("/api/nodes", "POST", { title: `打到底 ${scenario.name} ${Date.now()}`, markdown: Array.from({ length: scenario.lines }, (_, i) => `第 ${i + 1} 行文字內容`).join("\n\n") });
      for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) break; await page.waitForTimeout(400); }
      await page.goto(`${site.base}?view=notes&node=${note.json.id}`);
      await page.locator(".md-editor-cm .cm-content").first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(800);
      const FULL = profile.device.viewport.height;
      const keyboardTo = async (px) => profile.resizes ? page.setViewportSize({ width: profile.device.viewport.width, height: FULL - px }) : page.evaluate((p) => window.__setKeyboard(p), px);
      // Go to the end of the note, tap below its last line, let the keyboard come up.
      await page.evaluate(() => { const m = document.querySelector(".obsidian-main"); const el = m && m.scrollHeight > m.clientHeight ? m : document.scrollingElement; el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(400);
      const below = await page.evaluate(() => { const last = [...document.querySelectorAll(".md-editor-cm .cm-line")].at(-1).getBoundingClientRect(); return { x: last.left + 40, y: Math.min(last.bottom + 12, innerHeight - 4) }; });
      await page.touchscreen.tap(below.x, below.y);
      await page.waitForTimeout(300);
      await keyboardTo(profile.keyboard);
      await page.waitForTimeout(1200);
      const measure = () => page.evaluate(() => {
        const m = document.querySelector(".obsidian-main");
        const el = m && m.scrollHeight > m.clientHeight ? m : document.scrollingElement;
        const shown = (e) => e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().height > 0;
        const top = Math.max(0, ...[".app-topbar", ".center-lens-bar", ".phone-view-tabs", ".overview-mobile-tabs"].map((s) => document.querySelector(s)).filter(shown).map((e) => Math.round(e.getBoundingClientRect().bottom)));
        const bar = document.querySelector(".md-mobile-toolbar")?.getBoundingClientRect();
        const lines = [...document.querySelectorAll(".md-editor-cm .cm-line")];
        const sel = window.getSelection();
        const line = lines.find((l) => l.contains(sel?.focusNode ?? null))?.getBoundingClientRect();
        return { height: el.scrollHeight, top, barTop: bar ? Math.round(bar.top) : null, lineTop: line ? Math.round(line.top) : null, lineBottom: line ? Math.round(line.bottom) : null, lineHeight: line ? Math.round(line.height) : 0, room: !!document.querySelector(".cm-end-room") };
      });
      let m = await measure();
      console.log(`${profile.name} ${scenario.name}: start`, JSON.stringify(m));
      check(`${profile.name} ${scenario.name}: the caret line is whole above the bar before typing`, m.barTop !== null && m.lineBottom <= m.barTop && m.lineTop >= m.top - 1, JSON.stringify(m));
      check(`${profile.name} ${scenario.name}: ${profile.resizes ? "no room under the last line" : "the room is already there once the keyboard has settled"}`, profile.resizes ? !m.room : m.room, `room ${m.room}`);
      let heights = [m.height], inside = true;
      for (let i = 0; i < 10; i++) {
        await page.keyboard.type("x");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(250);
        m = await measure();
        heights.push(m.height);
        if (!(m.barTop !== null && m.lineBottom <= m.barTop && m.lineTop >= m.top - 1)) { inside = false; console.log(`  step ${i + 1} outside`, JSON.stringify(m)); }
      }
      const deltas = heights.slice(1).map((h, i) => h - heights[i]);
      const oneLine = m.lineHeight;
      check(`${profile.name} ${scenario.name}: ten Enters grow the page by one line each and nothing else`, deltas.every((d) => Math.abs(d - oneLine) <= 2), `line ${oneLine}, deltas ${JSON.stringify(deltas)}`);
      check(`${profile.name} ${scenario.name}: the last line stays whole above the bar at every step`, inside);
      check(`${profile.name} ${scenario.name}: no script errors`, errors.length === 0, errors.join(" | "));
    }
    await context.close();
  }
} finally {
  await browser.close();
  site.close();
}
console.log(failures ? `${failures} failure(s)` : "all passed");
process.exit(failures ? 1 : 0);
