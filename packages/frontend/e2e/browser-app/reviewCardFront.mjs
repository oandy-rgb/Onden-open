#!/usr/bin/env node
// Paragraph review cards in the browser app (the real backend runs in the page's worker):
//   node e2e/browser-app/reviewCardFront.mjs [chromium|mobile-chrome] [--shots <dir>]
// A note of three two-line paragraph cards (first line asks, the rest answers): the review screen shows the question
// rendered (no backticks), the answer only after 「Show answer」, and the 「來自」 block lists the neighbours' questions only. mobile-chrome
// is an emulation (Pixel 5 size, touch), not a phone.
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
const context = await browser.newContext({ ...device, ...(engine === "chromium" ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 } }), locale: "zh-TW" });
const page = await context.newPage();
try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  const api = (path, method = "GET", body) => page.evaluate(async ([p, m, b]) => {
    const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, ...(b ? { body: JSON.stringify(b) } : {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, method, body]);
  const body = [
    "規則區依序有 `\"if\"` 和 `{ID}`。輸入 `if` 和 `ifx` 各匹配哪條？為什麼？\n`if` 匹配 `\"if\"`（長度相同，取先寫的）；`ifx` 匹配 `{ID}`（最長匹配，能吃 3 個字元）。 {複習}",
    "**最長匹配**是什麼？\n同時能匹配時取吃最多字元的規則 {複習}",
    "`x` 呢？\n只有 `{ID}` 能匹配 {複習}",
  ].join("\n\n") + "\n";
  const created = await api("/api/nodes", "POST", { title: `Lex教學 ${Date.now()}`, markdown: body });
  check("the note is created", created.status < 300, `status ${created.status}`);
  for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) break; await page.waitForTimeout(400); }
  const queue = await api("/api/review/queue");
  const cards = (queue.json?.cards ?? []).filter((c) => c.block);
  check("the queue holds three paragraph cards with a back each", cards.length === 3 && cards.every((c) => c.markdown), JSON.stringify(cards.map((c) => [c.title.slice(0, 12), c.markdown.slice(0, 8)])));
  await page.goto(`${site.base}?view=review`);
  await page.locator(".review-card-front").first().waitFor({ timeout: 60_000 });
  // The queue's order between cards made in one second is not fixed: read which card is on the screen.
  const front = page.locator(".review-card-front").first();
  const text = (await front.innerText()).replace(/\s+/g, " ");
  const shown = cards.find((c) => text.startsWith(c.title.replace(/[`*]/g, "").slice(0, 4)));
  const plain = (md) => md.replace(/[`*]/g, "");
  check("the front is rendered: no backticks, and a <code> where the text had one", !!shown && !text.includes("`") && (await front.locator("code").count() > 0) === shown.title.includes("`"), text.slice(0, 80));
  const answer = plain(shown?.markdown ?? "").slice(0, 8);
  check("the answer is not on the screen yet", !!answer && !(await page.locator(".review-card").innerText()).includes(answer) && (await page.locator(".review-context").count()) === 0);
  if (shots) await page.screenshot({ path: join(shots, `review-front-${engine}.png`) });
  await page.getByRole("button", { name: /Show answer|顯示答案/ }).click();
  await page.locator(".review-card-body").waitFor();
  check("after the reveal the back shows", (await page.locator(".review-card-body").innerText()).includes(answer));
  const near = await page.locator(".review-context").innerText();
  const others = cards.filter((c) => c !== shown).map((c) => plain(c.markdown).slice(0, 8));
  check("the context names the neighbours' questions and none of their answers", others.every((o) => !near.includes(o)) && /[？?]/.test(near), near.replace(/\s+/g, " ").slice(0, 80));
  check("no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  if (shots) await page.screenshot({ path: join(shots, `review-back-${engine}.png`) });
} finally { await browser.close(); await site.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
