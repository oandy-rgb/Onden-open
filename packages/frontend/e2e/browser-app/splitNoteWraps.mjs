// npm run build:browser (repo root), then: node e2e/browser-app/splitNoteWraps.mjs [--shots <dir>]
// 並排: 筆記在窗格裡不被切掉、不需要橫向捲動（左右兩側、拖到最小、左右對調）。Exit code 1 when a check fails.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, startSite, openApp, waitSaved } from "../layout-audit/env.mjs";
import { runSeed } from "./seed.mjs";

const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(what); };

const A = "00000000-0000-4000-8000-0000000e0001";
const B = "00000000-0000-4000-8000-0000000e0002";
const LONG = "當時美國長途電話網的交換機之間，線路閑置時，兩端會持續送出 2600 赫茲的音調來表示線路空著，這個設計後來被人利用。".repeat(6);
const BODY = `${LONG}\n\nhttps://example.com/${"a".repeat(160)}\n\n\`\`\`\n${"x".repeat(200)}\n\`\`\`\n\n| 欄一 | 欄二 | 欄三 |\n| --- | --- | --- |\n| ${"y".repeat(80)} | b | c |\n`;

/** Every line box of note text must end inside its side (`sideSelector`), and nothing in the side scrolls sideways.
 *  `textSelector` limits the text looked at to the note (the info panel beside the left note has its own rules).
 *  Code blocks, tables and links scroll inside their own block, so those are skipped. */
export async function measureSide(page, sideSelector, textSelector) {
  return page.evaluate(({ sideSelector, textSelector }) => {
    const side = document.querySelector(sideSelector);
    const scope = document.querySelector(textSelector);
    if (!side || !scope) return { missing: true };
    const box = side.getBoundingClientRect();
    const clipped = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement;
      if (el.closest("pre, table, .cm-gutters, a[href^='http'], .cm-url")) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0 && r.right > box.right + 1) clipped.push(Math.round(r.right - box.right));
    }
    const sideways = [];
    for (const el of [side, scope, ...scope.querySelectorAll(".cm-scroller, .split-pane-body")]) {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible") sideways.push(String(el.className).slice(0, 40));
    }
    return { clipped, sideways, width: Math.round(box.width) };
  }, { sideSelector, textSelector });
}

const SIDES = [["左", ".split-left", ".split-left .obsidian-main.note-document"], ["右", ".split-pane", ".split-pane .split-pane-text"]];
/** mulberry32: the same sequence for the same seed, so a failure can be replayed (SPLIT_SEED). */
const seeded = (seed) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const MEASURES = { 窄: "30em", 標準: "41.18em", 寬: "52em", 全寬: "100vw" };
const TEXT_SCALES = [0.8, 1, 1.15, 1.5];

const run = async (browser, site, vp, right = `note:${B}:content`) => {
  const { context, page } = await openApp(browser, site, vp, { seed: false });
  const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status}`);
  }, { method, path, body });
  await call("POST", "/api/nodes", { id: A, title: "左邊的筆記", markdown: BODY });
  await call("POST", "/api/nodes", { id: B, title: "右邊的筆記", markdown: BODY });
  await waitSaved(page);
  await page.goto(`${site.base}?view=notes&node=${A}&lens=editor&right=${right}`);
  await page.waitForSelector(".split-pane", { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const label = `${vp.width}x${vp.height}${right.startsWith("page") ? " 閱讀" : ""}`;
  const SIDES_HERE = right.startsWith("page") ? SIDES.slice(0, 1) : SIDES; // the reader is a page of its own, not note text
  const sides = async (what) => {
    for (const [side, sideSel, textSel] of SIDES_HERE) {
      const m = await measureSide(page, sideSel, textSel);
      check(!m.missing && m.clipped.length === 0 && m.sideways.length === 0, `${label} ${what}：${side}側文字不被切、不橫向捲動`, JSON.stringify(m));
    }
    if (shots) await page.screenshot({ path: join(shots, `${label}-${what}.png`) });
  };
  const setRatio = (ratio) => page.evaluate((r) => document.querySelector(".split-root").style.setProperty("--split-ratio", String(r)), ratio);
  const drag = async (fraction) => {
    const box = await page.locator(".split-divider").boundingBox();
    const root = await page.locator(".split-root").boundingBox();
    await page.mouse.move(box.x + 3, box.y + 100); await page.mouse.down();
    await page.mouse.move(root.x + root.width * fraction, box.y + 100, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(300);
  };

  await sides("預設");
  await drag(0.1); await sides("拖到最小（資訊欄開著）");
  await page.keyboard.press("Control+."); await page.waitForTimeout(300);
  await sides("拖到最小（資訊欄收起）");
  await drag(0.9); await sides("拖到最大");
  await drag(0.1);
  if (right.startsWith("page")) { await context.close(); return; } // swapping a page to the left is not this test
  await page.getByRole("button", { name: "左右對調" }).click();
  await page.waitForTimeout(1000);
  await sides("左右對調後的最小");

  // Random widths × 「寬度」 × 「內文大小」: the same pane counts as before, the sequence comes from a fresh seed each run.
  const rnd = seeded(runSeed("splitNoteWraps", "SPLIT_SEED"));
  for (let i = 0; i < 12; i++) {
    const ratio = 0.25 + rnd() * 0.5;
    const measure = Object.keys(MEASURES)[Math.floor(rnd() * 4)];
    const scale = TEXT_SCALES[Math.floor(rnd() * TEXT_SCALES.length)];
    await page.evaluate(({ m, s }) => { const r = document.documentElement.style; r.setProperty("--onden-note-measure", m); r.setProperty("--onden-note-text-scale", String(s)); }, { m: MEASURES[measure], s: scale });
    await setRatio(ratio);
    await page.waitForTimeout(200);
    await sides(`隨機 ${i}（左占 ${ratio.toFixed(2)}、${measure}、${Math.round(scale * 100)}%）`);
  }
  await context.close();
};

const browser = await launch();
const site = await startSite();
for (const vp of [{ width: 1000, height: 625, hasTouch: true }, { width: 1280, height: 800, hasTouch: true }]) {
  await run(browser, site, vp);
  await run(browser, site, vp, "page:rss");
}
site.close(); await browser.close();
if (failures.length) { console.log(`\n${failures.length} FAIL`); process.exit(1); }
