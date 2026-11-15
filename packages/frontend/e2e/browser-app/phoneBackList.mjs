#!/usr/bin/env node
// Phone Back (docs/architecture: hooks/useUrlLocation's table; browser app, real engine, phone-sized window):
//   node e2e/browser-app/phoneBackList.mjs [--dir dist-browser]
// 1. A long notes list (past the windowed-list threshold) scrolled deep → open a note → Back: the list is at the same
//    place at once, does not move afterwards, and a tap right then opens the row that was tapped, not a neighbour.
// 2. A note followed by a link, a bottom tab, Back to the notes list, then a note opened from the list: the ‹ goes to the
//    list, not to the note the old link was followed from.
// The window is the Pixel 5 emulation (size, touch), not a phone.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const dirFlag = process.argv.indexOf("--dir");
const site = await serve(resolve(here, "../..", dirFlag > 0 ? process.argv[dirFlag + 1] : "dist-browser"));
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...playwright.devices["Pixel 5"], locale: "zh-TW" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const api = (path, method = "GET", body) => page.evaluate(async ([p, m, b]) => {
  const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, ...(b ? { body: JSON.stringify(b) } : {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, method, body]);
const makeNote = async (title, markdown) => (await api("/api/nodes", "POST", { title, markdown })).json;
const settled = async () => {
  for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) return; await page.waitForTimeout(400); }
};
// The app may still be opening its landing note (today's) when the page loads: tap 筆記 until the list, not a note, is on screen.
const listShown = () => page.evaluate(() => !new URLSearchParams(location.search).get("node") && [...document.querySelectorAll("[data-sb-id]")].some((r) => r.getBoundingClientRect().height > 0));
const showList = async () => {
  for (let i = 0; i < 12 && !(await listShown()); i++) { await page.getByText("筆記", { exact: true }).last().click().catch(() => {}); await page.waitForTimeout(1200); }
};
const titleShown = () => page.evaluate(() => { const el = document.querySelector(".obsidian-title-input"); return el && el.getBoundingClientRect().height ? el.value : null; });
const urlNode = () => page.evaluate(() => new URLSearchParams(location.search).get("node"));

try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  // 340 rows plus the sample notes: past the 300-row threshold where the list renders through a window.
  await page.evaluate(async () => {
    for (let i = 0; i < 340; i++) {
      await fetch("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `列 ${String(i).padStart(4, "0")}`, markdown: `內文 ${i}` }) });
    }
  });
  const B = await makeNote("乙筆記", "乙內文");
  const A = await makeNote("甲筆記", "看 [[乙筆記]]");
  await settled();

  // ── 1. Back to the deep list ───────────────────────────────────────────────
  await page.goto(`${site.base}?view=notes`);
  await page.locator(".obsidian-title-input").first().waitFor({ state: "attached", timeout: 40_000 }); // the landing note
  await page.waitForTimeout(1000);
  await showList();
  const rowCount = await page.locator("[data-sb-id]").count();
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  check("the list is long and windowed (few rows in the DOM, a tall page)", rowCount < 100 && total > 10_000, `rows ${rowCount}, height ${total}`);
  await page.evaluate(() => window.scrollTo(0, 6000));
  await page.waitForFunction(() => [...document.querySelectorAll("[data-sb-id]")].some((r) => { const b = r.getBoundingClientRect(); return b.top > 250 && b.bottom < 600; }));
  await page.waitForTimeout(500);
  const target = await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-sb-id]")].find((r) => { const b = r.getBoundingClientRect(); return b.top > 250 && b.bottom < 600; });
    const b = row.getBoundingClientRect();
    return { id: row.getAttribute("data-sb-id"), title: row.textContent.trim().slice(0, 6), top: b.top, x: b.left + b.width / 2, y: b.top + b.height / 2, scrollY: window.scrollY };
  });
  await page.touchscreen.tap(target.x, target.y);
  await page.waitForTimeout(1200);
  check("tapping the row opens that note", (await titleShown())?.startsWith(target.title) ?? false, `${target.title} / ${await titleShown()}`);
  // Every frame in which the list is on screen records where it is: the first one must already be the place it was left.
  await page.evaluate(() => {
    window.__samples = [];
    const t0 = performance.now();
    const frame = () => {
      const shown = [...document.querySelectorAll("[data-sb-id]")].some((r) => r.getBoundingClientRect().height > 0);
      if (shown) window.__samples.push(Math.round(window.scrollY));
      if (performance.now() - t0 < 1500) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.goBack(); // the system Back key
  await page.waitForTimeout(1700);
  const samples = await page.evaluate(() => window.__samples);
  const wanted = Math.round(target.scrollY);
  check("Back shows the list at the place it was left, from its first frame on", samples.length > 0 && samples[0] === wanted, `wanted ${wanted}, saw ${[...new Set(samples)].join(",")}`);
  check("the list does not move after it arrived", samples.length > 0 && samples.every((y) => y === wanted), `${[...new Set(samples)].join(",")}`);
  const rowTop = await page.evaluate((id) => document.querySelector(`[data-sb-id="${id}"]`)?.getBoundingClientRect().top ?? null, target.id);
  check("the row that was opened is where it was", rowTop !== null && Math.abs(rowTop - target.top) <= 1, `${rowTop} / ${target.top}`);
  // Open it again and come back, tapping the moment the list is on screen: the row at that place opens.
  await page.touchscreen.tap(target.x, target.y);
  await page.waitForTimeout(1000);
  await page.goBack();
  await page.waitForFunction(() => [...document.querySelectorAll("[data-sb-id]")].some((r) => r.getBoundingClientRect().height > 0));
  await page.touchscreen.tap(target.x, target.y);
  await page.waitForTimeout(1000);
  check("a tap the moment the list is back opens the row at that place", (await urlNode()) === target.id, `${await urlNode()} / ${target.id}`);

  // ── 2. ‹ on a note opened from the list, after a tab's Back ────────────────
  await page.goto(`${site.base}?view=notes&node=${A.id}`);
  await page.locator(".cm-content", { hasText: "看" }).first().waitFor({ timeout: 40_000 });
  await page.waitForTimeout(1200);
  const link = await page.locator(".cm-content").first().getByText("乙筆記").first().boundingBox();
  await page.touchscreen.tap(link.x + link.width / 2, link.y + link.height / 2);
  await page.waitForTimeout(800);
  check("the link opens 乙", (await urlNode()) === B.id);
  await page.getByText("任務", { exact: true }).last().click();
  await page.waitForTimeout(800);
  await page.goBack();
  await page.waitForTimeout(1000);
  check("Back from the tab is the notes list", (await urlNode()) === null && await listShown());
  // The list comes back where it was left (deep in the window): any row on screen will do.
  const row = await page.evaluate(() => {
    const r = [...document.querySelectorAll("[data-sb-id]")].find((el) => { const b = el.getBoundingClientRect(); return b.top > 150 && b.bottom < 600; });
    const b = r.getBoundingClientRect();
    return { id: r.getAttribute("data-sb-id"), x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.touchscreen.tap(row.x, row.y);
  await page.waitForTimeout(800);
  check("the note opened from the list is shown", (await urlNode()) === row.id);
  const back = page.locator('button[aria-label="返回筆記列表"], button[aria-label="返回"]').first();
  check("the note's ‹ says it goes to the list", (await back.getAttribute("aria-label")) === "返回筆記列表", await back.getAttribute("aria-label"));
  await back.click();
  await page.waitForTimeout(800);
  check("‹ goes to the notes list, not to a note an old link came from", (await urlNode()) === null && await listShown(), `node ${await urlNode()}`);
} finally {
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  site.close();
}
process.exit(results.every(Boolean) ? 0 : 1);
