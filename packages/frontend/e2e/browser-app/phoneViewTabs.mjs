// npm run build:browser (repo root), then: node e2e/browser-app/phoneViewTabs.mjs [--shots <dir>]
// A phone's note and tag pages draw their view tabs (内容, 表格, 月曆…, ＋) as one row inside the page, above the
// title (docs/agents/decisions-ui.md, 筆記與標籤頁的視角分頁), in real Chromium with real touch events (Pixel 5, 390×844):
//   row      the row is above the title on 內容 and on a table tab, at the same place; one tap switches; with only 內容 it is there with ＋
//   scroll   scrolling down takes the row off screen with the title (it is not fixed)
//   bar      the top bar has no 「內容 ⌄」 button and no tab sheet
//   swipe    with many tabs the row scrolls sideways; a swipe opens no menu, the row does not move the page; a hold opens the menu
//   tag      a tag page has the row above its title too
//   board    a full-screen board keeps the title sheet, which switches back to 內容
// Exit code 1 when a check fails.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, startSite, openApp, waitSaved, VIEWPORTS } from "../layout-audit/env.mjs";
import { IDS } from "../layout-audit/seed.mjs";

const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(what); };
const PLAIN = "00000000-0000-4000-8000-0000000c0001";
const MANY = "00000000-0000-4000-8000-0000000c0002";
const LONG_BODY = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段：用來讓這頁夠長，捲得動。`).join("\n\n");

const browser = await launch();
const site = await startSite();
const vp = { ...VIEWPORTS.find((v) => v.id === "pixel5") };
const { page, context } = await openApp(browser, site, vp);
await page.emulateMedia({ reducedMotion: "no-preference" });

const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.status >= 300 && r.status !== 409) throw new Error(`${method} ${path} → ${r.status}`);
}, { method, path, body });
await call("POST", "/api/nodes", { id: PLAIN, title: "只有內容的筆記", markdown: LONG_BODY });
await call("POST", "/api/nodes", { id: MANY, title: "分頁很多的筆記", markdown: LONG_BODY });
for (const [i, layout] of Array(6).fill("table").entries()) {
  await call("POST", `/api/nodes/${MANY}/views`, { name: `第${i + 1}個檢視分頁`, layout, visible_fields: ["title"] });
}
await waitSaved(page);

const open = async (query, ready) => {
  await page.goto(`${site.base}?${query}`);
  await page.waitForSelector(ready, { timeout: 60_000 });
  await page.waitForTimeout(1200);
};
const shot = (name) => shots ? page.screenshot({ path: join(shots, `${name}.png`) }) : Promise.resolve();
const rect = (selector) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, height: r.height } : null; }, selector);
const cdp = await context.newCDPSession(page);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) });

// ── only 內容
await open(`view=notes&node=${PLAIN}&lens=editor`, ".obsidian-title-input");
{
  const row = await rect(".phone-view-tabs");
  const title = await rect(".obsidian-title-input");
  check(row && title && row.bottom <= title.top + 1, "row: the tab row is above the title", JSON.stringify({ row, title }));
  check(row && row.height <= 48, "row: the row is about 44px tall", `${row?.height}px`);
  check((await page.locator(".phone-view-tabs").getByRole("tab").count()) === 1, "row: only 內容 is a tab");
  check(await page.locator(".phone-view-tabs").getByRole("button", { name: "新增檢視" }).isVisible(), "row: ＋ is there with only 內容");
  check((await page.locator(".overview-mobile-tabs .board-note-title").count()) === 0 && (await page.locator(".board-note-title").count()) === 0, "bar: the top bar has no 「內容 ⌄」 and there is no tab sheet button");
  await shot("phone-content-only");
  const before = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(300);
  const after = await rect(".phone-view-tabs");
  check(before === 0 && after && after.bottom < 0, "scroll: after scrolling down the tab row is off screen", JSON.stringify(after));
  await page.evaluate(() => window.scrollTo(0, 0));
}

// ── many tabs
await open(`view=notes&node=${MANY}&lens=editor`, ".phone-view-tabs");
await page.locator(".phone-view-tabs").getByRole("tab", { name: /第6個檢視分頁/ }).waitFor({ timeout: 30_000 });
{
  const y0 = (await rect(".phone-view-tabs")).top;
  await shot("phone-many-tabs");
  const list = await page.evaluate(() => { const e = document.querySelector(".phone-view-tabs .view-tabs-list"); return { scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, scrollLeft: e.scrollLeft }; });
  check(list.scrollWidth > list.clientWidth, "swipe: many tabs make the row scroll sideways", JSON.stringify(list));
  // one tap switches
  await page.locator(".phone-view-tabs").getByRole("tab", { name: /第1個檢視分頁/ }).tap();
  await page.waitForTimeout(800);
  check(new URL(page.url()).searchParams.get("tab") !== null, "row: one tap on a view tab opens it", page.url());
  const y1 = (await rect(".phone-view-tabs")).top;
  check(Math.abs(y1 - y0) < 1, "row: the row stays in the same place on the table tab", `${y0} → ${y1}`);
  const heading = await rect(".view-pane-title");
  check(heading && (await rect(".phone-view-tabs")).bottom <= heading.top + 1, "row: on a table tab the row is above the page title");
  await shot("phone-table-tab");
  await page.locator(".phone-view-tabs").getByRole("tab", { name: "內容" }).tap();
  await page.waitForSelector(".obsidian-title-input");
  // swipe: finger moves sideways along the row
  const box = await page.locator(".phone-view-tabs .view-tabs-list").boundingBox();
  const y = box.y + box.height / 2;
  const scrollY0 = await page.evaluate(() => window.scrollY);
  await touch("touchStart", [{ x: box.x + box.width - 20, y }]);
  for (let i = 1; i <= 12; i++) { await touch("touchMove", [{ x: box.x + box.width - 20 - i * 14, y }]); await page.waitForTimeout(16); }
  await touch("touchEnd", []);
  await page.waitForTimeout(500);
  const swiped = await page.evaluate(() => document.querySelector(".phone-view-tabs .view-tabs-list").scrollLeft);
  check(swiped > 0, "swipe: a sideways swipe scrolls the row", `scrollLeft ${swiped}`);
  check((await page.locator('[role="menu"]').count()) === 0, "swipe: a swipe opens no menu");
  check((await page.evaluate(() => window.scrollY)) === scrollY0, "swipe: the page itself did not move");
  // hold: a still finger for longer than the lift opens the menu when it lifts, and the row does not scroll
  await page.evaluate(() => { document.querySelector(".phone-view-tabs .view-tabs-list").scrollLeft = 0; });
  await page.waitForTimeout(300);
  const tabBox = await page.locator(".phone-view-tabs").getByRole("tab", { name: /第1個檢視分頁/ }).boundingBox();
  const holdLeft = await page.evaluate(() => document.querySelector(".phone-view-tabs .view-tabs-list").scrollLeft);
  const hx = tabBox.x + tabBox.width / 2;
  const hy = tabBox.y + tabBox.height / 2;
  if (hx > 0 && hx < 390) {
    await touch("touchStart", [{ x: hx, y: hy }]);
    await page.waitForTimeout(700);
    await touch("touchEnd", []);
    await page.waitForSelector('[role="menu"]', { timeout: 5000 }).catch(() => {});
    check((await page.locator('[role="menu"]').count()) === 1, "swipe: holding a tab opens its menu");
    check((await page.getByRole("menuitem", { name: "重新命名" }).count()) === 1 && (await page.getByRole("menuitem", { name: "刪除檢視" }).count()) === 1, "swipe: the menu has rename and delete");
    check((await page.evaluate(() => document.querySelector(".phone-view-tabs .view-tabs-list").scrollLeft)) === holdLeft, "swipe: holding does not scroll the row");
    await shot("phone-tab-menu");
    await page.keyboard.press("Escape");
  } else {
    check(false, "swipe: the first tab was visible to hold", `x ${hx}`);
  }
}

// ── tag page
await open(`view=notes&node=${IDS.long}&lens=editor`, ".obsidian-title-input");
{
  await page.getByRole("button", { name: "筆記列表" }).tap().catch(() => {});
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "標籤", exact: true }).first().tap().catch(() => {});
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /打開 #專案/ }).or(page.getByRole("link", { name: /打開 #專案/ })).first().tap().catch(() => {});
  await page.waitForSelector(".schema-lens-title", { timeout: 20_000 }).catch(() => {});
  const row = await rect(".phone-view-tabs");
  const title = await rect(".schema-lens-title");
  check(row && title && row.bottom <= title.top + 1, "tag: a tag page has the tab row above its title", JSON.stringify({ row, title }));
  await shot("phone-tag-page");
}

// ── full-screen board
await open(`view=notes&node=${MANY}&lens=canvas`, ".react-flow__pane");
{
  check((await page.locator(".phone-view-tabs").count()) === 0, "board: a full-screen board has no tab row");
  await shot("phone-board-fullscreen");
  await page.locator(".board-note-title").tap();
  await page.waitForSelector(".board-note-sheet");
  await shot("phone-board-title-sheet");
  await page.locator(".board-note-sheet").getByRole("tab", { name: "內容" }).tap();
  await page.waitForSelector(".phone-view-tabs", { timeout: 20_000 });
  check(!(await page.$(".react-flow__pane")), "board: the title sheet switches back to 內容");
}

await context.close();
await browser.close();
site.close?.();
if (failures.length) { console.log(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`); process.exit(1); }
console.log("\nall passed");
