#!/usr/bin/env node
// 游標不被鍵盤工具列蓋住（隨機組合）: a randomized combination test of the one rule "after a tap, with the keyboard up, the caret is where
// the person tapped and its line lies whole between the bottom of the rows above the text and the top of the bar":
//   node e2e/browser-app/caretKeyboardMatrix.mjs [--runs N] [--seed S]      (seed: random each run, printed; replay with --seed)
// Combinations, drawn at random per profile: where the tap lands (a text line / an empty line / below the last line / a line under
// where the keyboard will be) x how the keyboard rises (one instant step / three steps 300 ms apart) x whether a second tap follows
// with the keyboard up x the scroll position of the note x the pause between steps (40 / 150 / 300 ms), on Android (Pixel 5 and the
// 1204x714 touch tablet of lib/devices.mjs: the window shrinks, as under resizes-content) and on an iPhone window (only the visual
// viewport shrinks). Emulation, not a device: no real IME, no browser-made pan.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { TAB_S9 } from "./lib/devices.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const RUNS = Number(arg("runs", process.env.MATRIX_RUNS ?? 8));
const SEED = Number(arg("seed", process.env.KEYBOARD_SEED ?? Math.floor(Math.random() * 2 ** 31)));
const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rand = mulberry(SEED);
const pick = (list) => list[Math.floor(rand() * list.length)];
console.log(`seed ${SEED} (replay: --seed ${SEED})`);

const PROFILES = [
  { name: "pixel5", device: playwright.devices["Pixel 5"], resizes: true, keyboard: 330 },
  { name: "iphone13", device: playwright.devices["iPhone 13"], resizes: false, keyboard: 300 },
  { name: "tablet-1204x714", device: TAB_S9, resizes: true, keyboard: 350 },
];
const TAPS = ["text", "empty line", "below the last line", "line under the keyboard"];
const RISES = ["instant", "in three steps"];
// The pause between two steps of a rise: shorter than the editor's wait (6 frames: 50 ms at 120 Hz, 100 ms at 60 Hz), about as long, and much longer.
const STEP_PAUSES_MS = [40, 150, 300];
let failures = 0;
const site = await serve(resolve(here, "../..", "dist-browser"));
const browser = await playwright.chromium.launch();
try {
  for (const profile of PROFILES.filter((p) => !process.env.MATRIX_ONLY || p.name.includes(process.env.MATRIX_ONLY))) {
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
    if (process.env.MATRIX_TRACE) { page.on("console", (m) => { if (m.text().startsWith("TRACE")) console.log(m.text()); }); await page.addInitScript(() => { const t0 = performance.now(); const log = (k, e) => console.log(`TRACE ${Math.round(performance.now() - t0)} ${k} ${e.target?.className?.toString?.().slice(0, 30) ?? e.target?.nodeName} inner=${innerHeight}`); addEventListener("focusout", (e) => { log("focusout", e); console.log(`TRACE related=${e.relatedTarget?.nodeName} active=${document.activeElement?.nodeName}.${String(document.activeElement?.className).slice(0, 30)}`); }, true); const ob = HTMLElement.prototype.blur; HTMLElement.prototype.blur = function () { console.log(`TRACE blur() ${new Error().stack.split("\n").slice(2, 6).join(" | ")}`); return ob.call(this); }; addEventListener("focusin", (e) => log("focusin", e), true); addEventListener("scroll", () => console.log(`TRACE ${Math.round(performance.now() - t0)} scrollY=${Math.round(scrollY)} attr=${document.documentElement.hasAttribute("data-typing-short")} vv=${Math.round(visualViewport.height)}`), true); addEventListener("resize", () => console.log(`TRACE ${Math.round(performance.now() - t0)} resize inner=${innerHeight}`)); }); }
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await page.goto(site.base);
    await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
    const api = (path, method = "GET", body) => page.evaluate(async ([p, m, b]) => {
      const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, ...(b ? { body: JSON.stringify(b) } : {}) });
      return { status: r.status, json: await r.json().catch(() => null) };
    }, [path, method, body]);
    const note = await api("/api/nodes", "POST", { title: `組合 ${Date.now()}`, markdown: Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行文字內容`).join("\n\n") });
    for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) break; await page.waitForTimeout(400); }
    await page.goto(`${site.base}?view=notes&node=${note.json.id}`);
    await page.locator(".md-editor-cm .cm-content").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(800);

    const FULL = profile.device.viewport?.height ?? 727;
    const keyboardTo = async (px) => profile.resizes ? page.setViewportSize({ width: profile.device.viewport.width, height: FULL - px }) : page.evaluate((p) => window.__setKeyboard(p), px);
    const scrollTo = (frac) => page.evaluate((f) => {
      const m = document.querySelector(".obsidian-main");
      const el = m && m.scrollHeight > m.clientHeight ? m : document.scrollingElement;
      el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * f);
    }, frac);
    // Geometry: the rows above the text and the bar, the line holding the caret.
    const geometry = () => page.evaluate(() => {
      const shown = (e) => e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().height > 0;
      const rows = [".app-topbar", ".center-lens-bar", ".phone-view-tabs", ".overview-mobile-tabs"].map((s) => document.querySelector(s)).filter(shown);
      const top = Math.max(0, ...rows.map((e) => Math.round(e.getBoundingClientRect().bottom)));
      const bar = document.querySelector(".md-mobile-toolbar")?.getBoundingClientRect();
      const sel = window.getSelection();
      const lines = [...document.querySelectorAll(".md-editor-cm .cm-line")];
      const line = lines.find((l) => l.contains(sel?.focusNode ?? null));
      const b = line?.getBoundingClientRect();
      return { top, barTop: bar ? Math.round(bar.top) : null, lineTop: b ? Math.round(b.top) : null, lineBottom: b ? Math.round(b.bottom) : null, lineText: line?.textContent ?? null, index: line ? lines.indexOf(line) : -1, count: lines.length };
    });
    // The point to tap for a kind of tap, with the keyboard closed: { x, y, text } (text: what the tapped line holds).
    const target = (kind, keyboardPx) => page.evaluate(([k, kb, full]) => {
      const content = document.querySelector(".md-editor-cm .cm-content").getBoundingClientRect();
      const lines = [...document.querySelectorAll(".md-editor-cm .cm-line")].map((l) => ({ l, b: l.getBoundingClientRect() })).filter(({ b }) => b.height > 0 && b.top > 130 && b.bottom < innerHeight - 4);
      let c;
      if (k === "text") c = lines.filter(({ l }) => l.textContent.trim());
      else if (k === "empty line") c = lines.filter(({ l }) => !l.textContent.trim());
      else if (k === "line under the keyboard") c = lines.filter(({ b }) => b.bottom > full - kb - 10);
      else { const last = [...document.querySelectorAll(".md-editor-cm .cm-line")].at(-1).getBoundingClientRect(); return last.bottom + 20 < innerHeight ? { x: content.left + 24, y: last.bottom + 20, text: "" , below: true } : null; }
      if (!c.length) return null;
      const { l, b } = c[Math.floor(c.length / 2)];
      return { x: Math.min(b.left + 30, b.right - 4), y: b.top + b.height / 2, text: l.textContent };
    }, [kind, keyboardPx, FULL]);
    const assertIn = (g, expectText, label) => {
      const ok = g.barTop !== null && g.lineTop !== null && g.lineTop >= g.top - 1 && g.lineBottom <= g.barTop && (expectText === null || g.lineText === expectText);
      if (!ok) failures++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${JSON.stringify(g)}${expectText === null ? "" : ` expected line ${JSON.stringify(expectText)}`}`);
    };

    for (let i = 0; i < RUNS; i++) {
      const kind = pick(TAPS), rise = pick(RISES), second = rand() < 0.5, frac = rand();
      const label = `${profile.name} #${i + 1}: tap ${kind}, keyboard ${rise}${second ? ", then a second tap" : ""}, note scrolled to ${Math.round(frac * 100)}%`;
      await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
      await keyboardTo(0);
      await page.waitForTimeout(700);
      await scrollTo(kind === "below the last line" ? 1 : frac);
      await page.waitForTimeout(300);
      const t = await target(kind, profile.keyboard);
      if (!t) { console.log(`SKIP  ${label} (no such line on screen)`); continue; }
      await page.touchscreen.tap(t.x, t.y);
      await page.waitForTimeout(300);
      if (rise === "instant") await keyboardTo(profile.keyboard);
      else for (const total of [150, 270, profile.keyboard]) { await keyboardTo(total); await page.waitForTimeout(pick(STEP_PAUSES_MS)); }
      await page.waitForTimeout(900);
      const g = await geometry();
      assertIn(g, t.below ? null : t.text, label);
      if (second) {
        // Lines are now seen through the shrunk window: tap one just above the bar (where the browser's own scroll used to fail).
        const inside = await page.evaluate(() => { const bar = document.querySelector(".md-mobile-toolbar")?.getBoundingClientRect(); return [...document.querySelectorAll(".md-editor-cm .cm-line")].map((l) => ({ t: l.textContent, b: l.getBoundingClientRect() })).filter(({ b }) => b.height > 0 && b.top > 130 && b.bottom <= (bar?.top ?? innerHeight) && b.bottom > (bar?.top ?? innerHeight) - 120); });
        if (inside.length) {
          const pickd = inside[Math.floor(rand() * inside.length)];
          await page.touchscreen.tap(pickd.b.left + 30, pickd.b.top + pickd.b.height / 2);
          await page.waitForTimeout(900);
          assertIn(await geometry(), pickd.t, `${label} — second tap on a line by the bar`);
        }
      }
    }
    if (errors.length) { failures++; console.log(`FAIL  ${profile.name}: script errors ${errors.join(" | ")}`); }
    await context.close();
  }
} finally {
  await browser.close();
  site.close();
}
console.log(failures ? `${failures} failure(s); seed ${SEED}` : "all combinations passed");
process.exit(failures ? 1 : 0);
