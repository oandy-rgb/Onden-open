#!/usr/bin/env node
// 簡報裡的表格 → PPTX, in a real browser: the file's cells must sit where the slide draws them and none may run
// past the slide. Exports a note with a table page, opens the .pptx (a zip) and compares every text box with the cell
// the slide measured.  node e2e/browser-app/slideTablesPptx.mjs   (needs `npm run build:browser`)
import { createRequire } from "node:module";
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
const table = (head, rows) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const CASES = {
  report: `## 各類原因的占比\n\n${table(["原因", "Lexis", "Westlaw", "Practical Law"], [["檢索太天真", "47%", "20%", "34%"], ["引用不適用的法源", "38%", "23%", "34%"], ["推理錯誤", "28%", "61%", "49%"], ["附和使用者", "6%", "0%", "3%"]])}\n`,
  tall: `## 十五列的高表\n\n${table(["名稱", "數量", "狀態"], Array.from({ length: 15 }, (_, i) => [`第 ${i + 1} 項`, String(i * 3 + 1), i % 2 ? "完成" : "進行中"]))}\n`,
};

const browser = await playwright.chromium.launch();
const page = await (await browser.newContext({ ...playwright.devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, locale: "zh-TW", acceptDownloads: true })).newPage();
try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  for (const [name, md] of Object.entries(CASES)) {
    const title = `匯出表格 ${name} ${Date.now()}`;
    await page.evaluate(async ([t, m]) => { await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: t, markdown: m }) }); }, [title, md]);
    await page.goto(site.base);
    await page.getByText(title, { exact: true }).first().click();
    await page.getByRole("button", { name: "新增檢視" }).first().click();
    await page.locator("[role=menu],[role=dialog],[role=listbox]").getByText("簡報", { exact: true }).first().click();
    await page.locator(".sp-big .sv-canvas th").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1000);
    // Where the slide draws each cell, in slide pixels.
    const cells = await page.evaluate(() => {
      const canvas = document.querySelector(".sp-big .sv-canvas"); const c = canvas.getBoundingClientRect(); const k = c.width / 1920;
      return [...canvas.querySelectorAll("th, td")].map((cell) => { const r = cell.getBoundingClientRect(); return { text: cell.textContent, x: (r.left - c.left) / k, y: (r.top - c.top) / k, w: r.width / k, h: r.height / k }; });
    });
    await page.getByRole("button", { name: "匯出 PPTX" }).first().click();
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.locator(".pe-card").getByRole("button", { name: /^匯出/ }).last().click()]);
    const zip = await JSZip.loadAsync(await (await import("node:fs/promises")).readFile(await download.path()));
    const xml = await zip.file("ppt/slides/slide1.xml").async("string");
    const pres = await zip.file("ppt/presentation.xml").async("string");
    check(`${name}: the slide has its cells to compare`, cells.length > 0, String(cells.length));
    const [, sw, sh] = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(pres);
    const kx = Number(sw) / 1920, ky = Number(sh) / 1080;
    // Every shape with its place and words.
    const shapes = [...xml.matchAll(/<p:(?:sp|graphicFrame)>[\s\S]*?<\/p:(?:sp|graphicFrame)>/g)].map((m) => m[0]).map((s) => {
      const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"/.exec(s);
      return { x: Number(off?.[1]), y: Number(off?.[2]), w: Number(off?.[3]), h: Number(off?.[4]), text: [...s.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join("") };
    }).filter((s) => Number.isFinite(s.x));
    const outside = shapes.filter((s) => s.x < -1000 || s.y < -1000 || s.x + s.w > Number(sw) + 12700 || s.y + s.h > Number(sh) + 12700);
    check(`${name}: nothing in the file runs past the slide`, outside.length === 0, outside.map((s) => s.text).join(","));
    const lost = []; const off = [];
    for (const cell of cells) {
      const same = shapes.filter((s) => s.text === cell.text.replace(/&/g, "&amp;"));
      const hit = same.sort((a, b) => Math.hypot(a.x / kx - cell.x, a.y / ky - cell.y) - Math.hypot(b.x / kx - cell.x, b.y / ky - cell.y))[0];
      if (!hit) { lost.push(cell.text); continue; }
      // The text box may sit inside the cell (padding): its box must lie within the cell's, to a pixel or two.
      const inCell = hit.x / kx >= cell.x - 3 && hit.y / ky >= cell.y - 3 && (hit.x + hit.w) / kx <= cell.x + cell.w + 3 && (hit.y + hit.h) / ky <= cell.y + cell.h + 3;
      if (!inCell) off.push(`${cell.text}: file ${Math.round(hit.x / kx)},${Math.round(hit.y / ky)} ${Math.round(hit.w / kx)}x${Math.round(hit.h / ky)} vs slide ${Math.round(cell.x)},${Math.round(cell.y)} ${Math.round(cell.w)}x${Math.round(cell.h)}`);
    }
    check(`${name}: every cell's words are in the file`, lost.length === 0, lost.join(","));
    check(`${name}: every cell's words sit where the slide draws them`, off.length === 0, off.slice(0, 3).join(" | "));
    if (process.env.DUMP) console.log(shapes.map((s) => `${Math.round(s.x / kx)},${Math.round(s.y / ky)} ${Math.round(s.w / kx)}x${Math.round(s.h / ky)} "${s.text}"`).join("\n"));
    console.log(`      ${name}: ${cells.length} cells, ${shapes.length} shapes in the file`);
    await page.keyboard.press("Escape");
  }
} finally { await browser.close(); site.close(); }
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
