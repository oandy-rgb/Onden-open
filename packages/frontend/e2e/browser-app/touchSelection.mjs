#!/usr/bin/env node
// 平板觸控選取: after a selection made by finger, the note editor must show ONE selection (the OS's: highlight and
// handles agree), and selecting must not move any text (browser app, real editor, tablet-sized window, keyboard bar up):
//   node e2e/browser-app/touchSelection.mjs [--dir dist-browser]      (needs `npm run build:browser`)
//   SEED=123 RUNS=40 node e2e/browser-app/touchSelection.mjs           (the random part: lines and ranges)
// Cases: (1) a touch screen whose primary pointer says "coarse"; (2) a touch screen that says "fine" (pen, keyboard
// cover, mouse attached); in both, the editor draws no selection of its own for a finger, and a mouse click afterwards
// does draw one that covers what the browser selected (within 2px). (3) random lines x random ranges: no line's top,
// height or wrap points change because it was selected.
// Not a tablet: headless Chromium with injected touch and a faked keyboard (visualViewport); the OS handles, the OS
// menu, Samsung Internet and the real on-screen keyboard are not covered.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const flag = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const SEED = Number(process.env.SEED ?? 20261115);
const RUNS = Number(process.env.RUNS ?? 24);
const KEYBOARD = 320;
const site = await serve(resolve(here, "../..", flag("--dir", "dist-browser")));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

/** Small seeded generator (mulberry32): a failure is replayed with the same SEED. */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, list) => list[Math.floor(r() * list.length)];
const FILLER = ["用變數", "一二三四五六七八九十", "yytext 表示目前比對到的字串", "scanner", "每次都會把結果放進去", "abc def ghi jkl", "之後在動作程式中取用"];
const PIECES = [
  () => "**粗體字**", () => "`code`", () => "`yytext`", () => "[連結](https://example.com/a/b)", () => "*斜體*", () => "~~刪除~~", () => "**：`yytext`", () => "[[另一篇]]",
];
function randomLine(r) {
  const lead = pick(r, ["- ", "- ", "1. ", "## ", "- [ ] ", "", "> "]);
  let text = "";
  const n = 3 + Math.floor(r() * 9);
  for (let i = 0; i < n; i++) text += (r() < 0.45 ? pick(r, PIECES)() : pick(r, FILLER)) + (r() < 0.5 ? " " : "");
  return lead + text;
}
// The line in the owner's report: a list line with bold and code that wraps in the editor column.
const REPORT_LINE = "- 用變數**：`yytext` 表示目前比對到的字串，Lex 產生的掃描器每次都會把比對結果放進去，之後在動作程式中取用，所以這一行夠長會換行到第二行去";

const browser = await playwright.chromium.launch();

/** A tablet-sized window with a finger; `fine` makes the primary pointer answer "fine" (a pen or keyboard cover). */
async function openNote(markdown, { fine }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: true, hasTouch: true, locale: "zh-TW" });
  await context.addInitScript((fine) => {
    const target = new EventTarget();
    const vv = Object.assign(target, { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    window.__setKeyboard = (px) => { vv.height = window.innerHeight - px; vv.dispatchEvent(new Event("resize")); };
    if (fine) {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const list = real(query);
        if (query !== "(pointer: coarse)") return list;
        return new Proxy(list, { get: (t, key) => (key === "matches" ? false : typeof t[key] === "function" ? t[key].bind(t) : t[key]) });
      };
    }
  }, fine);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  const api = (path, method, body) => page.evaluate(async ([p, m, b]) => {
    const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    return r.json();
  }, [path, method, body]);
  const note = await api("/api/nodes", "POST", { title: `觸控選取 ${Date.now()}`, markdown });
  for (let i = 0; i < 60; i++) {
    const state = await page.evaluate(async () => (await fetch("/api/browser-app/state")).json());
    if (!state.unsaved && state.lastSavedAt !== null) break;
    await page.waitForTimeout(300);
  }
  await page.goto(`${site.base}?view=notes&node=${note.id}`);
  await page.locator(".md-editor-cm .cm-content").first().waitFor({ timeout: 60_000 });
  return { context, page, errors };
}

/** Everything about where the text is, read in the page. `breaks` are the character positions (not counting widgets)
 *  where a line goes on to a new row; a row starts further left than the character before it. */
const MEASURE = () => {
  const skip = (node) => node.parentElement?.closest(".cm-widgetBuffer, [contenteditable=false], .cm-block-tags-raw, .cm-block-tags") ?? null;
  const lines = [...document.querySelectorAll(".md-editor-cm .cm-line")].map((line) => {
    const box = line.getBoundingClientRect();
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const breaks = [];
    let index = 0; let lastLeft = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (skip(node)) continue;
      for (let i = 0; i < node.length; i++, index++) {
        range.setStart(node, i); range.setEnd(node, i + 1);
        const rect = range.getClientRects()[0];
        if (!rect || rect.width === 0) continue;
        if (lastLeft !== null && rect.left < lastLeft - 1) breaks.push(index);
        lastLeft = rect.left;
      }
    }
    return { text: line.textContent ?? "", top: Math.round(box.top * 10) / 10, height: Math.round(box.height * 10) / 10, width: Math.round(box.width), breaks };
  });
  return { lines, scrollY: Math.round(window.scrollY) };
};
/** Selects characters [from, to) of the `n`th non-empty line the way a finger's long-press does: by the browser's own selection. */
const SELECT = ({ n, from, to }) => {
  const el = [...document.querySelectorAll(".md-editor-cm .cm-line")].filter((l) => (l.textContent ?? "").trim())[n];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const at = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(".cm-widgetBuffer, [contenteditable=false], .cm-block-tags-raw, .cm-block-tags")) continue;
    for (let i = 0; i < node.length; i++) at.push([node, i]);
  }
  const [a, ai] = at[Math.min(from, at.length - 1)];
  const [b, bi] = at[Math.min(to, at.length - 1)];
  el.closest(".cm-content").focus();
  getSelection().setBaseAndExtent(a, ai, b, bi);
  return at.length;
};
/** Where the browser's selection is, and where the editor's own drawn selection is (empty when it draws none). */
const SELECTION_BOXES = () => {
  const sel = getSelection();
  const dom = sel.rangeCount ? [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 0).map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })) : [];
  const drawn = [...document.querySelectorAll(".md-editor-cm .cm-selectionBackground")].map((e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
  return { dom, drawn, layers: document.querySelectorAll(".md-editor-cm .cm-selectionLayer").length, hidesNative: !!document.querySelector(".md-editor-cm .cm-hideNativeSelection"), selectionBar: !!document.querySelector(".md-mobile-toolbar--selection") };
};
const sameMeasure = (before, after) => {
  const diffs = [];
  if (before.lines.length !== after.lines.length) return [`line count ${before.lines.length} -> ${after.lines.length}`];
  before.lines.forEach((b, i) => {
    const a = after.lines[i];
    if (Math.abs(a.top - b.top) > 0.6 || Math.abs(a.height - b.height) > 0.6 || JSON.stringify(a.breaks) !== JSON.stringify(b.breaks)) {
      diffs.push(`line ${i} "${b.text.slice(0, 18)}": top ${b.top}->${a.top}, height ${b.height}->${a.height}, width ${b.width}->${a.width}, wraps ${JSON.stringify(b.breaks)}->${JSON.stringify(a.breaks)}`);
    }
  });
  return diffs;
};
/** The drawn selection covers what the browser selected: each browser box sits inside a drawn row, and the outer edges match. */
function drawnMatchesDom({ dom, drawn }) {
  if (!dom.length || !drawn.length) return false;
  const inside = dom.every((d) => drawn.some((r) => (d.top + d.bottom) / 2 >= r.top - 2 && (d.top + d.bottom) / 2 <= r.bottom + 2 && d.left >= r.left - 2 && d.right <= r.right + 2));
  const firstRow = drawn.reduce((m, r) => (r.top < m.top ? r : m));
  const domFirst = dom.filter((d) => (d.top + d.bottom) / 2 >= firstRow.top - 2 && (d.top + d.bottom) / 2 <= firstRow.bottom + 2);
  const edge = domFirst.length > 0 && Math.abs(Math.min(...domFirst.map((d) => d.left)) - firstRow.left) <= 2;
  return inside && edge;
}

try {
  // 1 + 2: the report's line, with the keyboard bar up.
  for (const fine of [false, true]) {
    const label = fine ? "touch screen, primary pointer fine" : "touch screen, primary pointer coarse";
    const { context, page, errors } = await openNote(`${REPORT_LINE}\n\n- 第二個清單項目 **粗體** 與 \`程式碼\`\n\n尾`, { fine });
    try {
      const firstLine = page.locator(".md-editor-cm .cm-line").first();
      const box = await firstLine.boundingBox();
      await page.touchscreen.tap(box.x + 12, box.y + 6);
      await page.evaluate((px) => window.__setKeyboard(px), KEYBOARD);
      await page.waitForTimeout(600);
      await page.evaluate(() => getSelection().collapseToStart());
      const before = await page.evaluate(MEASURE);
      check(`${label}: the report's line wraps in the editor column`, before.lines[0].breaks.length >= 1, JSON.stringify(before.lines[0].breaks));
      // From inside the bold text, across the `：`, into the code.
      await page.evaluate(SELECT, { n: 0, from: 6, to: 22 });
      await page.waitForTimeout(500);
      const after = await page.evaluate(MEASURE);
      const boxes = await page.evaluate(SELECTION_BOXES);
      // The bar's selection variant follows the primary pointer; the OS handles do not depend on it.
      if (!fine) check(`${label}: the selection bar is up`, boxes.selectionBar);
      const moved = sameMeasure(before, after);
      check(`${label}: selecting moves no line (top, height, wraps)`, moved.length === 0 && before.scrollY === after.scrollY, moved.join(" | ") || `scroll ${before.scrollY}->${after.scrollY}`);
      check(`${label}: a finger's selection has no editor-drawn layer`, boxes.layers === 0 && !boxes.hidesNative && boxes.drawn.length === 0, JSON.stringify({ layers: boxes.layers, hidesNative: boxes.hidesNative, drawn: boxes.drawn.length }));
      // The finger taps elsewhere, then a mouse is used: now the editor may draw, and it must agree with the browser.
      await page.touchscreen.tap(box.x + 12, box.y + 6);
      await page.mouse.click(box.x + 40, box.y + 6);
      await page.evaluate(SELECT, { n: 0, from: 6, to: 22 });
      await page.waitForTimeout(500);
      const drawnBoxes = await page.evaluate(SELECTION_BOXES);
      // (A screen that says "coarse" never had the editor's own selection: nothing to compare there.)
      if (fine) check(`${label}: after a mouse click the drawn selection covers the browser's selection (2px)`, drawnMatchesDom(drawnBoxes), JSON.stringify({ dom: drawnBoxes.dom.length, drawn: drawnBoxes.drawn.length }));
      check(`${label}: no script errors`, errors.length === 0, errors.join(" | "));
    } finally { await context.close(); }
  }

  // 3a: the fixed case found by the random run: selecting `ext` in one line marks `ext` in the other code spans, which
  // used to cut each span in pieces and widen it, so a line elsewhere wrapped at another place.
  {
    const { context, page } = await openNote("> **：`yytext` 用變數 scanner`yytext`abc def ghi jkl 用變數 [連結](https://example.com/a/b) ~~刪除~~ abc def ghi jkl abc def ghi jkl \n\n- [ ] `yytext` 每次都會把結果放進去", { fine: true });
    try {
      const box = await page.locator(".md-editor-cm .cm-line").first().boundingBox();
      await page.touchscreen.tap(box.x + 12, box.y + 6);
      await page.evaluate(() => getSelection().collapseToStart());
      const before = await page.evaluate(MEASURE);
      await page.evaluate(SELECT, { n: 1, from: 7, to: 10 });
      await page.waitForTimeout(300);
      const marks = await page.locator(".md-editor-cm .cm-selectionMatch").count();
      const moved = sameMeasure(before, await page.evaluate(MEASURE));
      check("selecting a word that also sits inside code elsewhere moves no line", marks >= 1 && moved.length === 0, moved.join(" | ") || `${marks} marks`);
    } finally { await context.close(); }
  }

  // 3: random lines x random ranges, finger selection, wrap points never change. The editor only draws the lines
  // near the window, so the lines come in notes of BATCH lines.
  const r = rng(SEED);
  const BATCH = 8;
  const failures = [];
  const scriptErrors = [];
  for (let done = 0; done < RUNS; done += BATCH) {
    const lines = Array.from({ length: Math.min(BATCH, RUNS - done) }, () => randomLine(r));
    const { context, page, errors } = await openNote(lines.join("\n\n") + "\n\n尾", { fine: true });
    try {
      const box = await page.locator(".md-editor-cm .cm-line").first().boundingBox();
      await page.touchscreen.tap(box.x + 12, box.y + 6);
      await page.evaluate((px) => window.__setKeyboard(px), KEYBOARD);
      await page.waitForTimeout(600);
      await page.evaluate(() => getSelection().collapseToStart());
      const before = await page.evaluate(MEASURE);
      for (let n = 0; n < lines.length; n++) {
        const length = lines[n].length;
        const a = Math.floor(r() * length);
        const b = Math.floor(r() * length);
        const from = Math.min(a, b); const to = Math.max(a, b) + 1;
        await page.evaluate(SELECT, { n, from, to });
        await page.waitForTimeout(150);
        const moved = sameMeasure(before, await page.evaluate(MEASURE));
        const boxes = await page.evaluate(SELECTION_BOXES);
        if (moved.length) failures.push(`${JSON.stringify(lines[n])} range ${from}-${to}: ${moved[0]}`);
        if (boxes.layers) failures.push(`${JSON.stringify(lines[n])} range ${from}-${to}: the editor draws a selection for a finger`);
        await page.evaluate(() => getSelection().collapseToStart());
        await page.waitForTimeout(100);
      }
      scriptErrors.push(...errors);
    } finally { await context.close(); }
  }
  check(`random lines x ranges (seed ${SEED}, ${RUNS} lines): selecting never moves a line`, failures.length === 0, failures.slice(0, 3).join(" || "));
  check("random run: no script errors", scriptErrors.length === 0, scriptErrors.join(" | "));
} finally {
  await browser.close();
  site.close();
}
console.log(`touchSelection: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
