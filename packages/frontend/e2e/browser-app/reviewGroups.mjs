#!/usr/bin/env node
// Review groups in a real engine (browser app, desktop and the Pixel 5 emulation, not a phone):
//   node e2e/browser-app/reviewGroups.mjs [chromium|mobile-chrome] [--dir dist-browser] [--shots <folder>]
// Cards under two tags and a note, the status page's 「分組」 section (switch, rows), 「練這組」 opens the review limited to the
// group with the group in the address; a reload keeps it, Back returns to the status page, 「全部卡片」 leaves the group.
// --shots saves a screenshot of each step.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "chromium";
const flag = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const shots = flag("--shots");
const site = await serve(resolve(here, "../..", flag("--dir") ?? "dist-browser"));
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...(engine === "mobile-chrome" ? playwright.devices["Pixel 5"] : { viewport: { width: 1280, height: 800 } }), locale: "zh-TW", deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, `${engine}-${name}.png`) }); };

const api = (path, method = "GET", body) => page.evaluate(async ([p, m, b]) => {
  const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, ...(b ? { body: JSON.stringify(b) } : {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, method, body]);
// The page keeps its data in the browser: wait until it is saved before reloading.
const settled = async () => {
  for (let i = 0; i < 60; i++) { const st = await api("/api/browser-app/state"); if (!st.json.unsaved && st.json.lastSavedAt !== null) return; await page.waitForTimeout(400); }
};
const address = () => page.evaluate(() => new URLSearchParams(location.search).get("m"));
const body = () => page.evaluate(() => document.body.innerText);

try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  const tagA = (await api("/api/tags", "POST", { name: "演算法" })).json.id;
  const tagB = (await api("/api/tags", "POST", { name: "網路" })).json.id;
  const makeCard = async (title, tags, parent) => {
    const note = (await api("/api/nodes", "POST", { title, markdown: `${title} 的內容`, ...(parent ? { parent_id: parent } : {}) })).json;
    await api(`/api/review/cards/${note.id}`, "PUT");
    for (const tag of tags) await api(`/api/nodes/${note.id}/tags/${tag}`, "PUT");
    return note.id;
  };
  const lecture = (await api("/api/nodes", "POST", { title: "第一堂課", markdown: "" })).json.id;
  await makeCard("排序", [tagA], lecture);
  await makeCard("圖論", [tagA, tagB], lecture);
  await makeCard("TCP", [tagB]);
  await makeCard("隨手一張", []);
  await settled();
  await page.goto(`${site.base}?view=review&m=status`);
  await page.getByRole("region", { name: "分組" }).waitFor({ timeout: 40_000 });
  await page.getByText("演算法").first().waitFor({ timeout: 20_000 });
  const text = await body();
  check("the status page lists the groups with their numbers", ["演算法", "網路", "沒有標籤"].every((s) => text.includes(s)) && /2 張到期|2 張新卡/.test(text), text.match(/演算法[^\n]*/)?.[0]);
  check("no id or technical word is on the page", !/[0-9a-f]{8}-[0-9a-f]{4}/.test(text) && !/tag_id|untagged|undefined|null/.test(text));
  await shot("status-by-tag");
  await page.getByRole("radio", { name: "按筆記" }).click();
  await page.getByText("第一堂課").first().waitFor({ timeout: 20_000 });
  check("按筆記 lists the top-most notes that hold cards", (await body()).includes("第一堂課"));
  await shot("status-by-note");
  await page.getByRole("radio", { name: "按標籤" }).click();
  await page.getByText("演算法").first().waitFor({ timeout: 20_000 });

  const row = page.locator(".review-group", { hasText: "演算法" });
  await row.getByRole("button", { name: "練這組" }).click();
  await page.getByText(/演算法/).first().waitFor();
  await page.waitForTimeout(800);
  const placed = await address();
  check("練這組 puts the group in the address and says which group", /^tag\.[0-9a-f-]{36}$/.test(placed ?? "") && (await body()).includes("演算法") && (await body()).includes("全部卡片"), String(placed));
  await shot("practising-group");
  await page.reload();
  await page.getByRole("button", { name: "全部卡片" }).waitFor({ timeout: 40_000 });
  check("a reload keeps the group", (await address()) === placed);
  await page.goBack();
  await page.getByRole("region", { name: "分組" }).waitFor({ timeout: 20_000 });
  check("Back returns to the status page", (await address()) === "status");
  await page.goForward();
  await page.getByRole("button", { name: "全部卡片" }).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "全部卡片" }).click();
  await page.waitForTimeout(600);
  check("全部卡片 leaves the group", (await address()) === null && !(await body()).includes("全部卡片"));
  const noTag = (async () => {})();
  await page.goto(`${site.base}?view=review&m=status`);
  await page.getByRole("region", { name: "分組" }).waitFor({ timeout: 40_000 });
  await page.locator(".review-group", { hasText: "沒有標籤" }).getByRole("button", { name: "練這組" }).click();
  await page.getByText("正在練沒有標籤的卡片").waitFor({ timeout: 20_000 });
  check("沒有標籤 opens the cards under no tag", (await address()) === "untagged");
  await noTag;
  check("no page error", errors.length === 0, errors.join(" | "));
} catch (error) {
  check("the script ran to its end", false, String(error).slice(0, 300));
}
await browser.close();
site.close();
process.exit(results.every(Boolean) ? 0 : 1);
