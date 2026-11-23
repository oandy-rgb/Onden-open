#!/usr/bin/env node
// 點最後一行下面的空白: a finger tap anywhere under the last line of a note (the padding, the empty rest of the editor, the strip
// down to the bar) puts the caret at the end of the note, focuses the editor, and what is typed next lands at the end:
//   node e2e/browser-app/tapBelowLastLine.mjs [--profile pixel5|tablet|iphone13|desktop]
// Rule: lib/editorTouch (caretPosForTap, tapBelowEditor). Regression of #1931, which took the room under the last line away on
// Android (resizes-content) and nobody checked the tap that room used to catch (owner report 2026-11-23, Brave PWA).
// Finger and pen taps are placed everywhere below the last line; a mouse (the desktop profile) is unchanged: only inside the editor box.
// Android profiles shrink the window for the keyboard (resizes-content); iPhone shrinks only the visual viewport. Emulation, not a device.
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
  { name: "pixel5", device: playwright.devices["Pixel 5"], resizes: true, keyboard: 330, touch: true },
  { name: "tablet-1204x714", device: TAB_S9, resizes: true, keyboard: 350, touch: true },
  { name: "iphone13", device: playwright.devices["iPhone 13"], resizes: false, keyboard: 300, touch: true },
  { name: "desktop", device: playwright.devices["Desktop Chrome"], resizes: false, keyboard: 0, touch: false },
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
    const FULL = profile.device.viewport.height;
    const tapAt = (x, y) => (profile.touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
    const keyboardTo = async (px) => profile.resizes ? page.setViewportSize({ width: profile.device.viewport.width, height: FULL - px }) : page.evaluate((p) => window.__setKeyboard(p), px);
    // Where the caret is, from the editor itself: the text before it, on its line.
    const caret = () => page.evaluate(() => {
      const sel = getSelection();
      const content = document.querySelector(".md-editor-cm .cm-content");
      const lines = [...document.querySelectorAll(".md-editor-cm .cm-line")];
      const node = sel && sel.rangeCount ? sel.focusNode : null;
      const line = node ? lines.find((l) => l.contains(node)) : null;
      return { focused: !!content && content.contains(document.activeElement), lineText: line?.textContent ?? "", lastText: lines.at(-1)?.textContent ?? "" };
    });

    for (const scenario of [{ name: "long note", lines: 40 }, { name: "short note", lines: 4 }]) {
      // The three places "below the last line" can be: just under the text, in the middle of the blank, and at the foot of what is visible
      // (the strip between the editor's padding and the bar / window edge).
      for (const cold of [false, true]) for (const where of ["just under the last line", "far under the last line", "foot of the editor", "bottom of the visible area"]) {
        await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
        if (profile.resizes) await page.setViewportSize({ width: profile.device.viewport.width, height: FULL }); else await page.evaluate(() => window.__setKeyboard(0));
        await page.waitForTimeout(500);
        const note = await api("/api/nodes", "POST", { title: `點最後一行下面 ${scenario.name} ${Date.now()}`, markdown: Array.from({ length: scenario.lines }, (_, i) => `第 ${i + 1} 行文字內容`).join("\n\n") });
        for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) break; await page.waitForTimeout(400); }
        await page.goto(`${site.base}?view=notes&node=${note.json.id}`);
        await page.locator(".md-editor-cm .cm-content").first().waitFor({ timeout: 60_000 });
        await page.waitForTimeout(800);
        // Writing with the keyboard up: tap the first line first, so the editor is focused and the window has shrunk.
        if (!cold) {
        const mid = await page.locator(".md-editor-cm .cm-line").nth(0).boundingBox();
        await tapAt(mid.x + 30, mid.y + mid.height / 2);
        await page.waitForTimeout(300);
        if (profile.touch) await keyboardTo(profile.keyboard);
        await page.waitForTimeout(1200);
        }
        // Scroll to the end of the note, then find the point to tap.
        await page.evaluate(() => { const m = document.querySelector(".obsidian-main"); const el = m && m.scrollHeight > m.clientHeight ? m : document.scrollingElement; el.scrollTop = el.scrollHeight; });
        await page.waitForTimeout(500);
        const point = await page.evaluate((w) => {
          const last = [...document.querySelectorAll(".md-editor-cm .cm-line")].at(-1).getBoundingClientRect();
          const bar = document.querySelector(".md-mobile-toolbar");
          const nav = document.querySelector(".mobile-bottom-nav");
          const covers = [bar, nav].filter((el) => el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== "none").map((el) => el.getBoundingClientRect().top);
          const visibleBottom = Math.min(window.innerHeight, (window.visualViewport?.height ?? window.innerHeight), ...covers);
          const editorBottom = document.querySelector(".md-editor-cm .cm-editor").getBoundingClientRect().bottom;
          const dom = document.querySelector(".md-editor-cm .cm-editor");
          const x = Math.round(last.left + 40);
          // Blank = what a tap there reaches is the editor box, its padding or end room, or a container around it (not a text line, a block of its own, a button, a toast).
          const isBlank = (yy) => { const el = document.elementFromPoint(x, yy); return !!el && (el === dom || el.contains(dom) || (dom.contains(el) && !el.closest(".cm-line"))); };
          const want = w === "just under the last line" ? last.bottom + 14 : w === "far under the last line" ? last.bottom + 60 : w === "foot of the editor" ? Math.min(editorBottom, visibleBottom) - 6 : visibleBottom - 12;
          // From the wanted point, the nearest blank point (down for "far", up from the bottom for the lowest one).
          const candidates = [];
          for (let yy = Math.floor(last.bottom) + 8; yy < visibleBottom - 10; yy += 2) if (isBlank(yy)) candidates.push(yy);
          const y = candidates.length ? candidates.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a)) : NaN;
          return { x, y, insideEditor: !Number.isNaN(y) && dom.contains(document.elementFromPoint(x, y)), lastBottom: Math.round(last.bottom), visibleBottom: Math.round(visibleBottom) };
        }, where);
        if (Number.isNaN(point.y)) { check(`${profile.name} / ${scenario.name} / ${cold ? "cold" : "keyboard up"} / ${where}: there is a blank point to tap`, false, `last line ends ${point.lastBottom}, visible to ${point.visibleBottom}`); continue; }
        await tapAt(point.x, point.y);
        await page.waitForTimeout(500);
        const c = await caret();
        const label = `${profile.name} / ${scenario.name} / ${cold ? "from a cold start" : "keyboard up"} / ${where} (tap y ${point.y}, last line ends ${point.lastBottom}, visible to ${point.visibleBottom})`;
        // A mouse (desktop) is unchanged by #1983: it places the caret only where the browser always did, inside the editor box. In the blank
        // outside it nothing happens (pinned: today's behaviour; the owner's decision on mice is a separate change). Finger and pen: always.
        if (!profile.touch && !point.insideEditor) {
          check(`${label}: a mouse click outside the editor box leaves the caret where it was (unchanged)`, !c.lineText.startsWith(`第 ${scenario.lines} 行`), c.lineText);
          continue;
        }
        check(`${label}: the editor has focus`, c.focused);
        check(`${label}: the caret is on the last line`, c.lineText.startsWith(`第 ${scenario.lines} 行`), c.lineText);
        await page.keyboard.type("接著打");
        await page.waitForTimeout(300);
        const after = await caret();
        check(`${label}: what is typed next lands at the end`, after.lastText.endsWith("接著打"), after.lastText);
      }
    }
    check(`${profile.name}: no script errors`, errors.length === 0, errors.join(" | "));
    await context.close();
  }
} finally {
  await browser.close();
  site.close();
}
console.log(failures === 0 ? "all passed" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
