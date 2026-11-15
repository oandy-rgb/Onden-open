#!/usr/bin/env node
// 400px screenshots (light and dark) of the review screen and status page in the browser app:
//   npm run build:browser   (repo root, once)
//   node docs/research/review-screen-2026-11-13/shoot.mjs <outDir>
// The real backend runs in the page's worker; the cards are made through its API. A 400x800 window with touch is an
// emulation of a phone-sized screen, not a phone.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { serve } from "../../../packages/frontend/e2e/browser-app/serve.mjs";

const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const out = resolve(process.argv[2] ?? ".");
const site = await serve(resolve(import.meta.dirname, "../../../packages/frontend/dist-browser"));
const browser = await playwright.chromium.launch();
const errors = [];

for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({ viewport: { width: 400, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: "zh-TW", colorScheme: scheme });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  const api = (path, method = "GET", body) => page.evaluate(async ([p, m, b]) => {
    const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, ...(b ? { body: JSON.stringify(b) } : {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, method, body]);

  const modules = await api("/api/workspace/modules", "PATCH", { module: "review", imported: true, tag_name: "review" });
  if (modules.status !== 200) throw new Error(`could not turn Review on: ${modules.status}`);
  const parent = (await api("/api/nodes", "POST", { title: "計算機組織", markdown: "" })).json;
  const arch = (await api("/api/nodes", "POST", { title: "處理器架構筆記", parent_id: parent.id,
    markdown: "CPU 由運算單元、控制單元與暫存器組成。\n\n- 暫存器是什麼？ {review}\n  - CPU 內部最快、容量最小的儲存單元，用來暫放運算中的資料。\n\n快取（cache）則夾在暫存器和主記憶體之間，用空間換取速度。\n" })).json;
  const hazards = (await api("/api/nodes", "POST", { title: "管線的危障", parent_id: parent.id, markdown: "管線有三種危障：結構、資料、控制。\n\n- 資料危障可以靠什麼減輕？ {review}\n  - 轉送（forwarding）。\n" })).json;
  const whole = (await api("/api/nodes", "POST", { title: "什麼是虛擬記憶體？", parent_id: parent.id, markdown: "讓每個程式以為自己獨佔一大塊連續記憶體，由作業系統與硬體一起把虛擬位址對應到實體位址。" })).json;
  await api(`/api/nodes/${whole.id}/tags/${modules.json.module_tag_id}`, "PUT", {});
  for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) break; await page.waitForTimeout(400); }

  const queue = (await api("/api/review/queue")).json.cards;
  const forgotten = queue.find((card) => card.block && card.title.includes("資料危障"));
  const stopped = queue.find((card) => card.block && card.title.includes("暫存器是什麼"));
  const path = (card) => card.block ? `/api/review/blocks/${card.block.id}` : `/api/review/${card.node_id}`;
  if (forgotten) { for (let i = 0; i < 4; i++) await api(`${path(forgotten)}/grade`, "POST", { rating: 1 }); }
  const learned = queue.find((card) => !card.block);
  if (learned) await api(`${path(learned)}/grade`, "POST", { rating: 3 });
  await api("/api/me/prefs/reviewsPerDay", "PUT", { value: 20 });

  const shot = async (name) => page.screenshot({ path: join(out, `${name}-${scheme}.png`) });
  await page.goto(`${site.base}?view=review`);
  await page.getByRole("button", { name: /Show answer|顯示答案/ }).first().waitFor({ timeout: 60_000 });
  await shot("1-question");
  await page.getByRole("button", { name: /Show answer|顯示答案/ }).first().click();
  await page.waitForTimeout(500);
  // The app's own "recovered your last edits" toast shows after the fixture writes; close it like a person would.
  await page.getByRole("button", { name: /關閉|Close|Dismiss/ }).first().click({ timeout: 1500 }).catch(() => {});
  await shot("2-answer");
  await page.getByRole("button", { name: /^(Good|良好|記得)/ }).first().scrollIntoViewIfNeeded().catch(() => {});
  await shot("2b-answer-grades");
  await page.getByRole("button", { name: "複習狀況" }).first().click();
  await page.getByText("今天要複習").first().waitFor({ timeout: 20_000 });
  await shot("3-status");
  if (stopped) {
    await api(`${path(stopped)}/suspend`, "POST", {});
    // A suspend emits no live event, so the open page learns of it when it is opened again (or on its minute poll).
    await page.getByRole("button", { name: "回到複習" }).click();
    await page.getByRole("button", { name: "複習狀況" }).first().click();
    await page.getByText("已停用").first().waitFor({ timeout: 20_000 });
    // Scroll all the way down, then check the last button is clear of the bottom navigation.
    await page.getByRole("button", { name: "重新開始複習" }).first().scrollIntoViewIfNeeded();
    await page.evaluate(() => { for (const el of document.querySelectorAll("*")) if (el.scrollHeight > el.clientHeight + 20) el.scrollTop = el.scrollHeight; window.scrollTo(0, document.documentElement.scrollHeight); });
    await page.waitForTimeout(300);
    const gap = await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].filter((b) => b.textContent.includes("重新開始複習")).pop();
      const nav = document.querySelector("nav, [class*=bottom-nav], [class*=tabbar]");
      const navTop = [...document.querySelectorAll("nav")].map((n) => n.getBoundingClientRect()).filter((r) => r.top > window.innerHeight / 2).map((r) => r.top)[0] ?? window.innerHeight;
      return Math.round(navTop - button.getBoundingClientRect().bottom);
    });
    console.log(`${scheme}: last Stopped button is ${gap}px above the bottom navigation`);
    await shot("4-status-stopped");
  }
  {
    // The browser version cannot set the clock back, so no card is really overdue here. This one picture lays out
    // overdue numbers the page was given (the answer of the status route is changed in the page); the layout is real.
    await page.evaluate(() => {
      const real = window.fetch.bind(window);
      window.fetch = async (url, init) => {
        const response = await real(url, init);
        if (!String(url).includes("/api/review/status")) return response;
        const body = await response.json();
        return new Response(JSON.stringify({ ...body, overdue: 4, today: 5, rolled_over: 3, forecast: body.forecast.map((day, index) => ({ ...day, count: [2, 0, 6, 1, 0, 3, 0][index] })) }), { status: 200, headers: { "content-type": "application/json" } });
      };
    });
    await page.getByRole("button", { name: "回到複習" }).click();
    await page.getByRole("button", { name: "複習狀況" }).first().click();
    await page.getByText("今天要複習").first().waitFor({ timeout: 20_000 });
    await page.evaluate(() => { for (const el of document.querySelectorAll("*")) el.scrollTop = 0; });
    await page.waitForTimeout(300);
    await shot("3b-status-overdue");
  }
  if (stopped) {
    // The note's own review: open the note, its 功能 tab, the Review row; the stopped paragraph is offered back.
    await page.goto(`${site.base}?node=${arch.id}`);
    await page.locator(".cm-content").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: /關閉|Close|Dismiss/ }).first().click({ timeout: 1500 }).catch(() => {});
    await page.mouse.click(338, 20); // the info panel button
    await page.getByText("這則筆記裡的卡片").first().waitFor({ timeout: 20_000 });
    await shot("5-note-functions");
    await page.getByText("這則筆記裡的卡片").first().click();
    await page.getByRole("button", { name: "複習", exact: true }).first().click();
    await page.getByText(/這則筆記裡有 \d+ 張卡片已停用/).first().waitFor({ timeout: 20_000 });
    await shot("6-note-resume");
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log(`${scheme}: horizontal overflow ${overflow}px`);
  await context.close();
}
await browser.close();
site.close();
console.log(errors.length ? `script errors: ${errors.join(" | ")}` : "no script errors");
