#!/usr/bin/env node
// 手機：開筆記、按返回回到列表，列表不自己捲動、不標亮任何一列（browser app, real list）：
//   node e2e/browser-app/listBackNoJump.mjs [chromium|mobile-chrome]
// 什麼都沒開時沒有選取：列表不得標亮「第一篇」並捲過去。資料讓第一篇排在樹的下方、一開始在畫面外，
// 否則第一篇就在畫面內時看不出問題。
// The mobile-chrome viewport is an emulation (Pixel 5 size, touch), not a phone.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "chromium";
if (engine !== "mobile-chrome") { console.log("SKIPPED  phone only: the desktop has no 「返回筆記列表」 step (use mobile-chrome)"); process.exit(2); }
const device = playwright.devices[engine === "mobile-chrome" ? "Pixel 5" : "Desktop Chrome"];
const site = await serve(resolve(here, "../..", "dist-browser"));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...device, ...(engine === "chromium" ? { viewport: { width: 1280, height: 800 } } : {}), locale: "zh-TW" });
// Record every scrollIntoView (target + options) before any app code runs.
await context.addInitScript(() => {
  window.__scrollCalls = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (arg) {
    window.__scrollCalls.push({ behavior: arg && typeof arg === "object" ? arg.behavior ?? "auto" : "auto", text: (this.textContent ?? "").slice(0, 30) });
    return original.call(this, arg);
  };
});
// 最近修改 order: the list's first note (the oldest) is then the last row, far below the first screen.
await context.addInitScript(() => { try { localStorage.setItem("onden.sidebar.sort", "modified"); } catch { /* storage unavailable */ } });
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
  const settle = async () => {
    for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) break; await page.waitForTimeout(400); }
  };

  // Seed notes and tags sort ahead of anything created here (bootstrap order); clear them so the FIRST note the
  // list could fall back to is one of ours.
  const boot = (await api("/api/bootstrap")).json.nodes;
  for (const n of boot.filter((n) => n.node_type === "content")) await api(`/api/nodes/${n.id}`, "DELETE");
  for (const n of boot.filter((n) => n.node_type === "class_tag" && n.title !== "workspace-config")) await api(`/api/nodes/${n.id}`, "PATCH", { hidden: true });
  // A long list: enough rows that the first note of the list sits far below the first screen.
  const stamp = Date.now();
  // Created first (so it is the list's first note) and never touched again: sorted by 「最近修改」 its row is the last one: its row is far below the first screen.
  await api("/api/nodes", "POST", { title: `轉折最後一篇 ${stamp}`, markdown: "末列" });
  for (let i = 0; i < 18; i++) await api("/api/nodes", "POST", { title: `列表測試 ${String(i).padStart(2, "0")} ${stamp}`, markdown: `內文 ${i}` });
  await settle();

  const activeRows = () => page.locator(".obsidian-page-button.active").count();
  // Where the row the list would highlight sits (page coordinates), to show the data puts it off screen.
  const activeAt = () => page.evaluate(() => { const el = document.querySelector(".obsidian-page-button.active"); return el ? `${(el.textContent ?? "").slice(0, 14)} @${Math.round(el.getBoundingClientRect().top + scrollY)}/${innerHeight}` : "none"; });

  const calls = () => page.evaluate(() => window.__scrollCalls.splice(0));
  const sample = async (ms) => {
    const ys = [];
    for (let t = 0; t < ms; t += 50) { ys.push(await page.evaluate(() => Math.round(window.scrollY))); await page.waitForTimeout(50); }
    return ys;
  };
  // The list is a page of its own on a phone; a cold start lands in a note, and 「返回筆記列表」 leaves it.
  const rows = page.locator(".obsidian-page-button").filter({ hasText: "列表測試" });
  const openList = async () => {
    await page.goto(`${site.base}?view=notes&lens=editor`);
    await page.locator(".md-editor-cm .cm-content").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(600);
    await calls();
    await page.getByRole("button", { name: "返回筆記列表" }).first().click();
    await rows.first().waitFor({ timeout: 60_000 });
  };
  await openList();
  const arrival = await sample(1500);
  const home = arrival[0];
  check("list at top: nothing is highlighted", await activeRows() === 0, `${await activeAt()}`);
  check("list at top: scroll position never moves on its own", arrival.every((y) => y === home), `scrollY ${[...new Set(arrival)].join("/")}`);
  check("list at top: no smooth scrollIntoView", !(await calls()).some((c) => c.behavior === "smooth"));

  // Open a note near the top of the list, then go back.
  const row = rows.nth(2);
  const leftAt = await page.evaluate(() => Math.round(window.scrollY));
  await row.click();
  await page.locator(".md-editor-cm .cm-content").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(600);
  check("opening a note: no smooth scrollIntoView", !(await calls()).some((c) => c.behavior === "smooth"));
  await page.goBack();
  await rows.first().waitFor({ timeout: 30_000 });
  const back = await sample(1500);
  check("back: list returns to where it was and then stays", back.every((y) => Math.abs(y - leftAt) <= 1), `scrollY ${[...new Set(back)].join("/")}, left at ${leftAt}`);
  check("back: nothing is highlighted", await activeRows() === 0, `${await activeAt()}`);
  check("back: no smooth scrollIntoView", !(await calls()).some((c) => c.behavior === "smooth"));

  // Tapping right after coming back opens the tapped row, not another note.
  await openList();
  const tapped = rows.nth(3);
  const tappedTitle = (await tapped.innerText()).trim().split("\n")[0];
  await tapped.click();
  await page.locator(".md-editor-cm .cm-content").first().waitFor({ timeout: 60_000 });
  const title = await page.locator(".obsidian-title-input").first().inputValue();
  check("tapping a row opens that row's note", title === tappedTitle, `row "${tappedTitle}" opened "${title}"`);
  check("no script errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  site.close();
}
console.log(`${engine}: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
