#!/usr/bin/env node
// Review groups in a real engine (browser app, desktop and the Pixel 5 emulation, not a phone):
//   node e2e/browser-app/reviewGroups.mjs [chromium|mobile-chrome] [--dir dist-browser] [--shots <folder>]
// Cards under two tags and a note (a card counts under a tag its note, or a note above it, carries), the status page's 「分組」
// section (switch, rows), 「練這組」 opens the review limited to the group with the group in the address and in the 「範圍」
// picker; a reload keeps it, Back returns to the status page; the picker lists notes and tags with counts, changes the queue
// in place, and 全部 leaves the scope. The last choice is remembered when the page opens with no address.
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
  await api(`/api/nodes/${lecture}/tags/${tagA}`, "PUT"); // the lecture carries the tag, its cards do not
  await makeCard("排序", [], lecture);
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
  check("練這組 puts the group in the address and says which group", /^tag\.[0-9a-f-]{36}$/.test(placed ?? "") && (await body()).includes("範圍") && (await body()).includes("演算法"), String(placed));
  check("the scope holds the cards under the tagged lecture, though they carry no tag themselves", (await body()).includes("排序") || /2 張/.test(await body()));
  await shot("practising-group");
  await page.reload();
  await page.getByRole("button", { name: /範圍/ }).waitFor({ timeout: 40_000 });
  check("a reload keeps the group", (await address()) === placed);
  await page.goBack();
  await page.getByRole("region", { name: "分組" }).waitFor({ timeout: 20_000 });
  check("Back returns to the status page", (await address()) === "status");
  await page.goForward();
  await page.getByRole("button", { name: /範圍/ }).waitFor({ timeout: 20_000 });

  // The picker: notes and tags with their counts, no id or technical word, a pick changes the queue in place.
  await page.getByRole("button", { name: /範圍/ }).click();
  const sheet = page.getByRole("dialog", { name: "範圍" });
  await sheet.getByText("第一堂課").waitFor({ timeout: 20_000 });
  const picker = await sheet.innerText();
  check("the picker lists notes, tags and 沒有標籤 with counts", ["第一堂課", "#演算法", "#網路", "沒有標籤", "全部"].every((x) => picker.includes(x)) && /\d+ 張/.test(picker), picker.replace(/\n/g, " | ").slice(0, 200));
  check("the picker shows no id or technical word", !/[0-9a-f]{8}-[0-9a-f]{4}/.test(picker) && !/tag_id|untagged|undefined|null|root\./.test(picker));
  // The ✕ in the sheet's header is ui/SheetHeader's (38px with a mouse, 44px on a finger): not a row.
  const small = await sheet.locator("button:not([aria-label='關閉'])").evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().height < 43.5).length);
  check("every picker row is at least 44px tall", small === 0, `${small} smaller`);
  await shot("picker");
  await sheet.getByRole("button", { name: /#網路/ }).click();
  await page.waitForTimeout(600);
  check("a pick changes the scope in place (address and picker button)", /^tag\./.test((await address()) ?? "") && (await address()) !== placed && (await page.getByRole("button", { name: /範圍.*#網路/ }).count()) === 1);
  await shot("picked");
  await page.goto(`${site.base}?view=review`);
  await page.getByRole("button", { name: /範圍/ }).waitFor({ timeout: 40_000 });
  await page.waitForTimeout(800);
  check("a page opened with no address returns to the last choice", /^tag\./.test((await address()) ?? "") && (await page.getByRole("button", { name: /範圍.*#網路/ }).count()) === 1, String(await address()));
  await page.getByRole("button", { name: /範圍/ }).click();
  await page.getByRole("dialog", { name: "範圍" }).getByRole("button", { name: /^全部/ }).click();
  await page.waitForTimeout(600);
  check("全部 leaves the scope", (await address()) === "all" && (await page.getByRole("button", { name: /範圍.*全部/ }).count()) === 1);
  const noTag = (async () => {})();
  await page.goto(`${site.base}?view=review&m=status`);
  await page.getByRole("region", { name: "分組" }).waitFor({ timeout: 40_000 });
  await page.locator(".review-group", { hasText: "沒有標籤" }).getByRole("button", { name: "練這組" }).click();
  await page.getByRole("button", { name: /範圍.*沒有標籤/ }).waitFor({ timeout: 20_000 });
  check("沒有標籤 opens the cards under no tag", (await address()) === "untagged");
  await noTag;
  check("no page error", errors.length === 0, errors.join(" | "));
} catch (error) {
  check("the script ran to its end", false, String(error).slice(0, 300));
}
await browser.close();
site.close();
process.exit(results.every(Boolean) ? 0 : 1);
