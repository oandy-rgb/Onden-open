#!/usr/bin/env node
// 兩欄版型 (Two columns) in a real browser: a column box is never cut through its bottom border, and its PPTX box is whole.
//   node e2e/browser-app/slideColumns.mjs      (needs `npm run build:browser`)
// The cut happens when a column is one pixel taller than the area it is given (the measuring allows 1px, the area clips):
// the page is made exactly that tall by padding the list, then the column's bottom edge is compared with the area's.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const JSZip = require("jszip");
const site = await serve(resolve(here, "../..", "dist-browser"));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const browser = await playwright.chromium.launch();
const page = await (await browser.newContext({ ...playwright.devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, locale: "zh-TW", acceptDownloads: true })).newPage();
try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  const title = `兩欄 ${Date.now()}`;
  const md = "## 兩欄比較\n\n### 左邊\n- 第 1 項：說明文字\n- 第 2 項：說明文字\n- 第 3 項：說明文字\n\n### 右邊\n- 第 1 項：說明文字\n- 第 2 項：說明文字\n- 第 3 項：說明文字\n";
  await page.evaluate(async ([t, m]) => { await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: t, markdown: m }) }); }, [title, md]);
  await page.goto(site.base);
  await page.getByText(title, { exact: true }).first().click();
  await page.getByRole("button", { name: "新增檢視" }).first().click();
  await page.waitForTimeout(500);
  await page.locator(".cv-add-view-option", { hasText: "簡報" }).first().click();
  await page.locator(".sp-big .sv-canvas .sv-col").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);

  const info = await page.evaluate(() => {
    const cv = document.querySelector(".sp-big .sv-canvas"); const cols = cv.querySelector(".sv-cols"); const col = cv.querySelector(".sv-col");
    const k = cv.getBoundingClientRect().width / 1920;
    const area = cols.clientHeight;
    col.style.alignSelf = "start"; const natural = col.offsetHeight; col.style.alignSelf = "";
    col.lastElementChild.style.paddingBottom = `${Math.max(0, area + 1 - natural)}px`; // one pixel more than the area
    void cols.offsetHeight;
    const c = col.getBoundingClientRect(), a = cols.getBoundingClientRect();
    const both = [...cv.querySelectorAll(".sv-col")].map((e) => e.getBoundingClientRect().height / k);
    return { over: (c.bottom - a.bottom) / k, equalHeights: Math.abs(both[0] - both[1]) < 0.5 };
  });
  check("a column one pixel taller than its area is not cut through its bottom border", info.over <= 0.05, `${info.over.toFixed(2)}px past the area`);
  check("the two columns are the same height", info.equalHeights);

  // PPTX: each column's box is in the file, whole, where the slide draws it.
  const boxes = await page.evaluate(() => {
    document.querySelectorAll(".sp-big .sv-col > :last-child").forEach((e) => { e.style.paddingBottom = ""; });
    const cv = document.querySelector(".sp-big .sv-canvas"); const c = cv.getBoundingClientRect(); const k = c.width / 1920;
    return [...cv.querySelectorAll(".sv-col")].map((e) => { const r = e.getBoundingClientRect(); return { x: (r.left - c.left) / k, y: (r.top - c.top) / k, w: r.width / k, h: r.height / k }; });
  });
  await page.getByRole("button", { name: "匯出 PPTX" }).first().click();
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.locator(".pe-card").getByRole("button", { name: /^匯出/ }).last().click()]);
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  const xml = await zip.file("ppt/slides/slide1.xml").async("string");
  const [, sw, sh] = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(await zip.file("ppt/presentation.xml").async("string"));
  const kx = Number(sw) / 1920, ky = Number(sh) / 1080;
  const shapes = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => /<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"/.exec(m[0])).filter(Boolean).map((o) => ({ x: o[1] / kx, y: o[2] / ky, w: o[3] / kx, h: o[4] / ky }));
  for (const [i, b] of boxes.entries()) {
    const hit = shapes.find((s) => Math.abs(s.x - b.x) < 2 && Math.abs(s.y - b.y) < 2 && Math.abs(s.w - b.w) < 2 && Math.abs(s.h - b.h) < 2);
    check(`PPTX: column ${i + 1}'s box is in the file, whole`, !!hit, hit ? "" : `wanted ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}`);
  }
} finally { await browser.close(); site.close(); }
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
