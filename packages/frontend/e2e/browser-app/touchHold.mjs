#!/usr/bin/env node
// Hold-then-drag with real touch input (CDP Input.dispatchTouchEvent) in the browser app: sidebar note rows, tag rows, view tabs.
//   node e2e/browser-app/touchHold.mjs [--dir dist-browser]       (needs `npm run build:browser`)
// Chromium only makes a touch sequence cancelable if a non-passive touchstart listener exists when the finger lands
// (lib/touchHold holdSurface). Without it the list scrolls under the held row and the drag is cancelled, so this checks
// the outcome (no scroll, no pointercancel, the note moved) and the cause (touchstart / touchmove are cancelable).
// Headless desktop Chromium sends every injected touch as cancelable, so it does NOT show the tablet's failure by itself
// (checked: a page without the listener behaves the same). The cause is therefore also asserted directly, the way it was
// measured on the tablet: the hold containers carry a non-passive touchstart listener (DOMDebugger.getEventListeners).
// Not a tablet: S Pen, Samsung Internet and real scrolling inertia are not covered.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const flag = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const site = await serve(resolve(here, "../..", flag("--dir", "dist-browser")));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...playwright.devices["Desktop Chrome"], viewport: { width: 1280, height: 1300 }, hasTouch: true, locale: "zh-TW" });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const errors = [];
page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  // Enough notes that the list scrolls.
  await page.evaluate(async () => {
    for (let i = 0; i < 40; i++) await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `拖動測試 ${String(i).padStart(2, "0")}`, markdown: "x" }) });
  });
  for (let i = 0; i < 60; i++) {
    const state = await page.evaluate(async () => (await fetch("/api/browser-app/state")).json());
    if (!state.unsaved && state.lastSavedAt !== null) break;
    await page.waitForTimeout(400);
  }
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  const list = page.locator(".obsidian-page-list").first();
  await list.locator("[data-sb-id]").first().waitFor({ timeout: 30_000 });

  // Records of the touch sequence, kept on window (passive: they must not change what the browser does).
  await page.evaluate(() => {
    const log = { start: [], move: [], pointercancel: 0, scrolls: 0 };
    window.__touchLog = log;
    window.addEventListener("touchstart", (e) => log.start.push(e.cancelable), { capture: true, passive: true });
    window.addEventListener("touchmove", (e) => log.move.push(e.cancelable), { capture: true, passive: true });
    window.addEventListener("pointercancel", () => { log.pointercancel++; }, true);
    document.addEventListener("scroll", () => { log.scrolls++; }, true);
    const t0 = performance.now(); log.trace = [];
    for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "contextmenu", "scroll"])
      window.addEventListener(t, (e) => log.trace.push(`${Math.round(performance.now() - t0)} ${t}${e.cancelable === false ? " NC" : ""} ${String(e.target.className).slice(0, 24)}`), { capture: true, passive: true });
  });
  const resetLog = () => page.evaluate(() => { Object.assign(window.__touchLog, { start: [], move: [], pointercancel: 0, scrolls: 0 }); });
  const readLog = () => page.evaluate(() => window.__touchLog);
  const send = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  const order = () => list.evaluate((el) => [...el.querySelectorAll("[data-sb-id]")].map((row) => row.getAttribute("data-sb-id")));
  const scrollTop = () => list.evaluate((el) => el.scrollTop);

  // The list settles by itself after a load (it scrolls to the open note): put it mid-way, then wait until it has stood still.
  const settle = async (to) => {
    await list.evaluate((el, top) => { el.scrollTop = top; }, to);
    for (let still = 0, last = -1; still < 5;) { await page.waitForTimeout(250); const now = await scrollTop(); still = now === last ? still + 1 : 0; last = now; }
  };
  // A row that is really on screen inside the list (the rows are windowed and the list is taller than its window).
  const visibleRow = async (n) => {
    const handle = await list.evaluateHandle((el, k) => {
      const view = el.getBoundingClientRect();
      return [...el.querySelectorAll("[data-sb-id]")].filter((row) => { const r = row.getBoundingClientRect(); return r.top > view.top + 40 && r.bottom < view.bottom - 220; })[k];
    }, n);
    return handle.asElement();
  };

  // 0. The cause: each hold container has a non-passive touchstart listener before any finger lands.
  const hasBlockingTouchStart = async (selector) => {
    const { result } = await cdp.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
    if (!result.objectId) return false;
    const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
    return listeners.some((l) => l.type === "touchstart" && !l.passive);
  };
  check("note list: has a non-passive touchstart listener at rest", await hasBlockingTouchStart(".obsidian-page-list"));
  check("tag list: has a non-passive touchstart listener at rest", await hasBlockingTouchStart(".sb-tagtree"));
  // 1. Hold a note row 400ms, move 150px down, let go: no scroll, no cancel, the note is somewhere else.
  await settle(300);
  const box = await (await visibleRow(1)).boundingBox();
  const x = box.x + Math.min(box.width / 2, 120), y = box.y + box.height / 2;
  const ordersBefore = await order();
  const top0 = await scrollTop();
  await resetLog();
  await send("touchStart", x, y);
  await page.waitForTimeout(400);
  for (let i = 1; i <= 10; i++) { await send("touchMove", x, y + i * 15); await page.waitForTimeout(16); }
  await send("touchEnd", x, y + 150);
  await page.waitForTimeout(800);
  const held = await readLog();
  if (process.env.DEBUG_TOUCH) console.log(JSON.stringify({ x, y, box, held }).slice(0, 200) + "\n" + held.trace.slice(0, 40).join("\n"));
  check("hold: touchstart is cancelable", held.start.length > 0 && held.start.every(Boolean), JSON.stringify(held.start));
  check("hold: every touchmove is cancelable", held.move.length > 0 && held.move.every(Boolean), `${held.move.filter(Boolean).length}/${held.move.length}`);
  check("hold: the list did not scroll", (await scrollTop()) === top0 && held.scrolls === 0, `scrollTop ${top0} -> ${await scrollTop()}, ${held.scrolls} scroll events`);
  check("hold: no pointercancel", held.pointercancel === 0, String(held.pointercancel));
  const ordersAfter = await order();
  check("hold: the note was dropped at a new place", JSON.stringify(ordersAfter) !== JSON.stringify(ordersBefore));

  // 2. No hold: a quick swipe scrolls the list and drags nothing.
  await settle(300);
  const ordersBeforeSwipe = await order();
  const top1 = await scrollTop();
  const box2 = await (await visibleRow(1)).boundingBox();
  const sx = box2.x + Math.min(box2.width / 2, 120), sy = box2.y + box2.height / 2;
  await send("touchStart", sx, sy);
  for (let i = 1; i <= 8; i++) { await send("touchMove", sx, sy - i * 30); await page.waitForTimeout(10); }
  await send("touchEnd", sx, sy - 240);
  await page.waitForTimeout(600);
  check("swipe: the list scrolled", (await scrollTop()) > top1, `scrollTop ${top1} -> ${await scrollTop()}`);
  // The list may be windowed: compare the order of the rows that are drawn both times.
  const ordersAfterSwipe = await order();
  const common = (a, b) => a.filter((id) => b.includes(id));
  check("swipe: nothing was dragged", JSON.stringify(common(ordersBeforeSwipe, ordersAfterSwipe)) === JSON.stringify(common(ordersAfterSwipe, ordersBeforeSwipe)));
  // 3. Tag rows and view tabs: the same hold; here only that the touch stays cancelable (the cause), with no pointercancel.
  const holdProbe = async (name, target, dx, dy) => {
    const at = await target.boundingBox();
    const px = at.x + at.width / 2, py = at.y + at.height / 2;
    await resetLog();
    await send("touchStart", px, py);
    await page.waitForTimeout(400);
    for (let i = 1; i <= 5; i++) { await send("touchMove", px + i * dx, py + i * dy); await page.waitForTimeout(16); }
    await send("touchEnd", px + 5 * dx, py + 5 * dy);
    await page.waitForTimeout(500);
    const log = await readLog();
    check(`${name}: touchstart and every touchmove are cancelable`, log.start.every(Boolean) && log.move.length > 0 && log.move.every(Boolean), `start ${JSON.stringify(log.start)}, moves ${log.move.filter(Boolean).length}/${log.move.length}`);
    check(`${name}: no pointercancel`, log.pointercancel === 0, String(log.pointercancel));
    await page.waitForTimeout(500);
  };
  await holdProbe("tag row", page.locator(".sb-tagtree-item .sb-tagtree-name").first(), 0, 12);
  await page.locator(".obsidian-page-list [data-sb-id]").first().click();
  await page.locator(".view-tabs .view-tab").first().waitFor({ timeout: 20_000 });
  check("view tabs: have a non-passive touchstart listener at rest", await hasBlockingTouchStart(".view-tabs"));
  await holdProbe("view tab", page.locator(".view-tabs .view-tab").first(), 12, 0);
  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  await site.close?.();
}
process.exit(results.every(Boolean) ? 0 : 1);
