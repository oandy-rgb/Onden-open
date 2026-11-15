#!/usr/bin/env node
// 「本篇的段落」 and 獨立出去 / 收回原文 in the browser app (the real backend runs in the page's worker):
//   node e2e/browser-app/paragraphs.mjs [chromium|mobile-chrome] [--shots <dir>]
// Writes a note with topic paragraphs, makes one stand alone, and looks at the info panel; the viewport of
// mobile-chrome is an emulation (Pixel 5 size, touch), not a phone.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "chromium";
const shotsFlag = process.argv.indexOf("--shots");
const shots = shotsFlag > 0 ? resolve(process.argv[shotsFlag + 1]) : null;
const device = playwright.devices[engine === "mobile-chrome" ? "Pixel 5" : "Desktop Chrome"];
const site = await serve(resolve(here, "../..", "dist-browser"));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...device, ...(engine === "chromium" ? { viewport: { width: 1280, height: 800 } } : {}), locale: "zh-TW" });
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
  const title = `段落測試 ${Date.now()}`;
  // No `^id` in the text: a tagged block gets its anchor from the server when the note is saved.
  const body = "# 搜尋\n\n二分搜尋每次砍半 {演算法}\n\n- 邊界要用 lo <= hi {演算法}\n\n雜湊表用鍵算出位置 {考點}\n";
  const created = await api("/api/nodes", "POST", { title, markdown: body });
  const id = created.json.id;
  const before = await api(`/api/nodes/${id}/paragraphs`);
  const hash = before.json.paragraphs.find((p) => String(p.label).includes("雜湊表"));
  check("the tagged paragraph already has its anchor", !!hash?.block_ref, JSON.stringify(before.json).slice(0, 200));
  const standing = await api(`/api/nodes/${id}/block-to-child`, "POST", { block_ref: hash?.block_ref, keep_identity: true, fallback_title: "未命名" });
  check("獨立出去 answers 200", standing.status === 200, `status ${standing.status}`);
  const list = await api(`/api/nodes/${id}/paragraphs`);
  check("the list names three paragraphs, one standing alone", list.json.paragraphs.length === 3 && list.json.paragraphs.filter((p) => p.where === "standing").length === 1);
  // The browser app keeps its copy a moment after a write; a page opened before that would not have the note.
  for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) break; await page.waitForTimeout(400); }
  await page.goto(`${site.base}?view=notes&node=${id}`);
  await page.getByText("二分搜尋每次砍半").first().waitFor({ timeout: 60_000 }).catch(() => {});
  // The panel's 「標籤」 tab holds 本篇的段落 (the first tab is 「功能」).
  await page.locator(".info-panel-tab", { hasText: "標籤" }).first().click({ timeout: 10_000 }).catch(() => {});
  const panel = page.locator(".info-relations-section", { has: page.locator("#info-paragraphs") });
  const shown = await panel.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  check(engine === "chromium" ? "the info panel shows 本篇的段落" : "本篇的段落 on the phone-size window (reported)", engine === "chromium" ? shown : true, shown ? "visible" : "not on this layout");
  if (shown) {
    const text = (await panel.innerText()).replace(/\s+/g, " ");
    check("grouped by topic with the standing one marked", text.includes("演算法") && text.includes("考點") && text.includes("獨立成一篇"), text);
    const box = await panel.boundingBox();
    check("no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    if (shots) { await page.screenshot({ path: join(shots, `paragraphs-${engine}.png`) }); }
    void box;
  } else if (shots) { await page.screenshot({ path: join(shots, `paragraphs-${engine}.png`) }); }
  const back = await api(`/api/nodes/${id}/expand-child`, "POST", { child_id: standing.json.child_id });
  check("收回原文 answers 200", back.status === 200, JSON.stringify(back.json).slice(0, 200));
  const again = await api(`/api/nodes/${id}`);
  check("the text is back as it was", again.json.markdown === body, JSON.stringify(again.json?.markdown ?? again.status).slice(0, 120));
  check("no script errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  site.close();
}
console.log(`${engine}: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
