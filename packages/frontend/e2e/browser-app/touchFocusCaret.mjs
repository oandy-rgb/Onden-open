#!/usr/bin/env node
// 手機上寫作：焦點與游標歸編輯器 (browser app, real editor, Pixel 5 emulation with touch):
//   node e2e/browser-app/touchFocusCaret.mjs
// 1. A note with 3 short lines: tap 120px below the last line -> exactly ONE selection change, caret at the end of the last line.
// 2. Open the / menu: a tap on its padding (outside any row) leaves the editor focused; a swipe scrolls it (is not prevented).
// NOT a phone: no real IME or keyboard. The owner checks the real device over adb.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const device = playwright.devices["Pixel 5"];
const site = await serve(resolve(here, "../..", "dist-browser"));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...device, locale: "zh-TW" });
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
  const note = await api("/api/nodes", "POST", { title: `三行 ${Date.now()}`, markdown: "第一行\n\n第二行\n\n第三行" });
  for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) break; await page.waitForTimeout(400); }
  await page.goto(`${site.base}?view=notes&node=${note.json.id}`);
  const content = page.locator(".md-editor-cm .cm-content").first();
  await content.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);

  // Count selection changes the editor sees (the DOM's selectionchange while the editor owns focus, and its own state).
  await page.evaluate(() => {
    window.__sel = [];
    document.addEventListener("selectionchange", () => {
      const s = getSelection();
      const line = [...document.querySelectorAll(".md-editor-cm .cm-line")].findIndex((l) => l.contains(s?.focusNode ?? null));
      window.__sel.push({ line, outside: line < 0 && !!s?.focusNode && !!s.focusNode.parentElement?.closest?.(".cm-content") || s?.focusNode?.classList?.contains?.("cm-content") });
    });
  });

  // 1. Tap the room under the last line: one change, caret on the last line, never outside a line.
  const lastLine = page.locator(".md-editor-cm .cm-line").last();
  const box = await lastLine.boundingBox();
  await page.touchscreen.tap(box.x + 30, box.y + box.height / 2); // focus first: the end room exists only while writing
  await page.waitForTimeout(700);
  const lastBox = await lastLine.boundingBox();
  await page.evaluate(() => { window.__sel = []; });
  await page.touchscreen.tap(lastBox.x + 30, lastBox.y + lastBox.height + 120);
  await page.waitForTimeout(600);
  const sel = await page.evaluate(() => ({ changes: window.__sel, caret: (() => {
    const s = getSelection();
    const lines = [...document.querySelectorAll(".md-editor-cm .cm-line")];
    const i = lines.findIndex((l) => l.contains(s?.focusNode ?? null));
    return { line: i, last: lines.length - 1, atEnd: i >= 0 && s.focusOffset === (s.focusNode.textContent ?? "").length, focused: document.activeElement?.classList.contains("cm-content") };
  })() }));
  check("tap under the last line: caret on the last line, at its end", sel.caret.line === sel.caret.last && sel.caret.atEnd, JSON.stringify(sel.caret));
  check("tap under the last line: exactly one selection change", sel.changes.length === 1, `${sel.changes.length} changes ${JSON.stringify(sel.changes)}`);
  check("tap under the last line: the native caret never sat outside a line", sel.changes.every((c) => !c.outside));
  check("tap under the last line: the editor is focused", sel.caret.focused === true);

  // 2. The / menu: padding tap keeps focus, a swipe scrolls it.
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  const menu = page.locator(".slash-menu-popup").first();
  await menu.waitFor({ timeout: 10_000 });
  const mbox = await menu.boundingBox();
  // The surface's own edge, inside its rounded corner: not on any row.
  const edge = { x: mbox.x + mbox.width - 3, y: mbox.y + 3 };
  const onRow = await page.evaluate((p) => !!document.elementFromPoint(p.x, p.y)?.closest(".slash-menu-item"), edge);
  check("the tap point is on the menu surface, not on a row", !onRow);
  await page.evaluate(() => { window.__focus = []; for (const t of ["focusin", "focusout"]) document.addEventListener(t, (e) => window.__focus.push(`${t}:${e.target.className || e.target.tagName}`.slice(0, 60))); });
  await page.touchscreen.tap(edge.x, edge.y);
  await page.waitForTimeout(500);
  const afterTap = await page.evaluate(() => ({ editorFocused: document.activeElement?.classList.contains("cm-content"), events: window.__focus }));
  check("tap on the / menu's padding: the editor keeps focus", afterTap.editorFocused === true, JSON.stringify(afterTap.events));
  check("tap on the / menu's padding: no focus moved at all", afterTap.events.length === 0, JSON.stringify(afterTap.events));

  // Whichever element of the menu scrolls (the surface or the list inside it).
  const scroller = await menu.evaluateHandle((el) => [el, ...el.querySelectorAll("*")].find((n) => n.scrollHeight > n.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(n).overflowY)) ?? null);
  const scrollEl = scroller.asElement();
  if (scrollEl) {
    const before = await scrollEl.evaluate((el) => el.scrollTop);
    const client = await context.newCDPSession(page);
    const sb = await scrollEl.boundingBox();
    const cx = sb.x + sb.width / 2, cy = sb.y + sb.height * 0.75;
    // A finger swipe: touchStart, small moves, touchEnd (no mousedown is made by a scroll).
    const touch = (type, y) => client.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: cx, y }] });
    await page.evaluate(() => { window.__mouse = []; document.addEventListener("mousedown", () => window.__mouse.push("mousedown"), true); });
    await touch("touchStart", cy);
    for (let i = 1; i <= 12; i++) { await touch("touchMove", cy - i * 10); await page.waitForTimeout(16); }
    await touch("touchEnd", 0);
    await page.waitForTimeout(500);
    const after = await scrollEl.evaluate((el) => el.scrollTop);
    check("swiping the / menu scrolls it", after > before, `scrollTop ${before} -> ${after}`);
    check("a swipe makes no mousedown (nothing to prevent)", (await page.evaluate(() => window.__mouse)).length === 0);
  } else {
    check("swiping the / menu scrolls it (menu fits: nothing to scroll, skipped)", true);
  }
  check("no script errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  site.close();
}
console.log(`mobile-chrome: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
