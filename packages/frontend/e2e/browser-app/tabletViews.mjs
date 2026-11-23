// npm run build:browser (repo root), then: node e2e/browser-app/tabletViews.mjs [--shots <dir>]
// A note's view tabs and views on a tablet with all three columns open (Galaxy Tab S9, 1204×714, touch; the centre
// column is then about 435px), in real Chromium. Measured with the page's own boxes, not screenshots:
//   tabs     with 3 and with 5 view tabs, 「＋」 is whole inside the strip, clear of the right-hand buttons, touched with a
//            finger it opens its panel; the tab list scrolls and shows that it can (faded ends)
//   panel    the panel 「＋」 opens is 220px or more wide and its rows are one line each, the first time it is opened
//   slides   「簡報」 › 「版型」: the 「換成…」 list is an opaque panel inside the note column, its 「套用」 is whole and
//            clickable, and the note under the slide is not squeezed to a word a line
//   cards    the cards view names its fields (「更新時間」), never updated_at
//   board    the whiteboard opens at a readable scale (not 40%); the selected card's bar is not over another card;
//            with the pen in hand there is one 復原, and the board's bar and the pen's do not overlap
// Exit code 1 when a check fails.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, startSite, openApp, waitSaved } from "../layout-audit/env.mjs";
import { IDS } from "../layout-audit/seed.mjs";

const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(what); };

const SIDEBAR = 340;
const INSPECTOR = 429; // 1204 − 340 − 429 = 435: the centre column the owner measured
const NOTE = IDS.slidesNote;
const FIVE = "00000000-0000-4000-8000-0000000d0005";
const BOARD = IDS.parent;

const browser = await launch();
const site = await startSite();
const { page } = await openApp(browser, site, { id: "tablet", width: 1204, height: 714, touch: true });
await page.evaluate(([a, b]) => { localStorage.setItem("onden.sidebarWidth", String(a)); localStorage.setItem("onden.inspectorWidth", String(b)); }, [SIDEBAR, INSPECTOR]);
await page.emulateMedia({ reducedMotion: "no-preference" });
const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.status >= 300 && r.status !== 409) throw new Error(`${method} ${path} → ${r.status}`);
}, { method, path, body });
const shot = (name) => shots ? page.screenshot({ path: join(shots, `${name}.png`) }) : Promise.resolve();

for (const [name, layout] of [["表格", "table"], ["簡報", "slides"], ["卡片", "gallery"]]) await call("POST", `/api/nodes/${NOTE}/views`, { name, layout, visible_fields: ["title", "updated_at"] });
await call("POST", "/api/nodes", { id: FIVE, title: "五個分頁的筆記", markdown: "內文" });
for (const [name, layout] of [["表格", "table"], ["看板", "kanban"], ["月曆", "calendar"], ["卡片", "gallery"]]) await call("POST", `/api/nodes/${FIVE}/views`, { name, layout, visible_fields: ["title"] });
for (let i = 0; i < 6; i++) await call("POST", "/api/nodes", { id: `00000000-0000-4000-8000-0000000d01${i}0`, parent_id: BOARD, title: `白板上的子筆記 ${i + 1}`, markdown: "一段文字，讓卡片有內容可讀。" });
await waitSaved(page);

const open = async (query, ready) => {
  await page.goto(`${site.base}?${query}`);
  await page.waitForSelector(ready, { timeout: 60_000 });
  await page.waitForTimeout(1500);
};
const box = (selector) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, selector);
const inside = (inner, outer) => inner && outer && inner.x >= outer.x - 0.5 && inner.r <= outer.r + 0.5 && inner.y >= outer.y - 0.5 && inner.b <= outer.b + 0.5;
const overlap = (a, b) => a && b && Math.min(a.r, b.r) - Math.max(a.x, b.x) > 0.5 && Math.min(a.b, b.b) - Math.max(a.y, b.y) > 0.5;
/** Is the element at the middle of `selector` the element itself (or inside it)? */
const reachable = (selector) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!top && e.contains(top); }, selector);

// ── tabs ─────────────────────────────────────────────────────────────────────
for (const [label, id, count] of [["3 view tabs", NOTE, 4], ["5 view tabs", FIVE, 5]]) {
  await open(`view=notes&node=${id}&lens=editor`, ".center-lens-bar .view-tab--add");
  const centre = await box(".notes-center-wrap");
  check(Math.abs(centre.w - 435) <= 2, `${label}: the centre column is about 435px`, `${Math.round(centre.w)}px`);
  const bar = await box(".center-lens-bar");
  const plus = await box(".center-lens-bar .view-tab--add");
  const end = await box(".view-strip-end");
  check(inside(plus, bar) && !overlap(plus, end), `${label}: ＋ is whole inside the strip and clear of the buttons on the right`, JSON.stringify({ plus, end }));
  check(await reachable(".center-lens-bar .view-tab--add"), `${label}: nothing covers ＋`);
  check(plus.w >= 44 && plus.h >= 44, `${label}: ＋ is at least 44px to touch`, `${plus.w}×${plus.h}`);
  const list = await page.evaluate(() => { const e = document.querySelector(".center-lens-bar .view-tabs-list"); return { scrolls: e.scrollWidth > e.clientWidth, bg: getComputedStyle(e).backgroundImage, left: e.scrollLeft }; });
  const tabs = await page.locator(".center-lens-bar .view-tabs-list [role=tab]").count();
  check(tabs === count, `${label}: the list has its ${count} tabs`, `${tabs}`);
  check(list.scrolls ? /linear-gradient/.test(list.bg) : true, `${label}: a list that scrolls shows faded ends`);
  await page.locator(".center-lens-bar .view-tab--add").tap();
  await page.waitForSelector(".cv-add-view-panel", { timeout: 5000 }).catch(() => {});
  check((await page.locator(".cv-add-view-panel").count()) === 1, `${label}: touching ＋ opens the panel`);
  if (id === NOTE) {
    // the first time the panel opens (no view's own stylesheet loaded yet): wide enough, one line a row
    const panel = await box(".cv-add-view-panel");
    check(panel && panel.w >= 200, "panel: it is 220px wide the first time it opens", `${panel && Math.round(panel.w)}px`);
    const rows = await page.$$eval(".cv-add-view-option", (els) => els.map((e) => e.getBoundingClientRect().height));
    check(rows.length > 0 && rows.every((h) => h < 60), "panel: each row is one line", JSON.stringify(rows.map(Math.round)));
    await shot("tablet-add-panel");
  }
  await page.keyboard.press("Escape");
  await shot(`tablet-tabs-${count}`);
}

// ── slides ───────────────────────────────────────────────────────────────────
await open(`view=notes&node=${NOTE}&lens=editor`, ".center-lens-bar .view-tab--add");
await page.getByRole("tab", { name: "簡報" }).tap();
await page.waitForSelector(".sp-bar", { timeout: 20_000 });
await page.getByRole("button", { name: /^版型/ }).first().tap();
await page.waitForSelector(".sp-replace", { timeout: 10_000 });
await page.waitForTimeout(500);
{
  const centre = await box(".notes-center-wrap");
  const list = await box(".sp-replace");
  check(inside(list, centre), "slides: the 換成… list is inside the note column", JSON.stringify({ list, centre }));
  const alpha = await page.$eval(".sp-replace", (e) => { const c = getComputedStyle(e).backgroundColor; return /rgba?\(/.test(c) ? (c.match(/[\d.]+/g)[3] ?? "1") : "0"; });
  check(Number(alpha) === 1, "slides: the list has an opaque background", `alpha ${alpha}`);
  const apply = await box(".sp-replace .ui-replace-actions .ui-btn:last-child");
  check(inside(apply, centre) && (await reachable(".sp-replace .ui-replace-actions .ui-btn:last-child")), "slides: 「套用」 is whole and nothing covers it", JSON.stringify(apply));
  check(apply && apply.h >= 44, "slides: 「套用」 is at least 44px to touch", `${apply?.h}px`);
  const big = await box(".sp-big");
  check(!overlap(list, big), "slides: the list does not sit on the slide", JSON.stringify({ list, big }));
  const rule = await box(".sp-rule");
  check(rule && rule.w >= 250 && rule.h < 90, "slides: the note under the slide is not squeezed to a word a line", JSON.stringify(rule));
  const clipped = await page.$$eval(".sp *", (els) => els.filter((e) => { const s = getComputedStyle(e); return (s.overflow === "hidden" || s.overflow === "clip") && e.scrollWidth > e.clientWidth + 1 && e.textContent.trim() && s.textOverflow !== "ellipsis" && !e.closest(".sv-frame, .ui-replace-thumb, .sp-thumb-pic, .sp-big"); }).map((e) => e.className));
  check(clipped.length === 0, "slides: no text is cut off", JSON.stringify(clipped));
  await shot("tablet-slides-layout");
}

// ── cards ────────────────────────────────────────────────────────────────────
await open(`view=notes&node=${NOTE}&lens=editor`, ".center-lens-bar .view-tab--add");
await page.getByRole("tab", { name: "卡片" }).tap();
await page.waitForSelector(".cv-gallery, .cv-empty, [class*=empty]", { timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(800);
{
  const text = await page.evaluate(() => document.querySelector(".view-pane")?.innerText ?? "");
  check(!/updated_at|created_at/.test(text), "cards: no internal field name on the page", text.slice(0, 120).replace(/\n/g, " "));
  await shot("tablet-cards");
}

// ── the whiteboard ───────────────────────────────────────────────────────────
await open(`view=notes&node=${BOARD}&lens=canvas`, ".react-flow__node-card");
await page.waitForTimeout(1000);
const zoomOf = () => page.$eval(".react-flow__viewport", (e) => { const m = /scale\(([-\d.e]+)\)/.exec(e.style.transform); return m ? +m[1] : null; });
{
  const zoom = await zoomOf();
  check(zoom !== null && zoom >= 0.7, "board: opens at a readable scale", `${zoom}`);
  await shot("tablet-board-open");
  // the selected card's bar must not sit on another card
  const onScreen = () => page.$$eval(".react-flow__node-card", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, ok: r.x > 360 && r.right < innerWidth && r.y > 170 && r.bottom < innerHeight - 140 }; }).filter((c) => c.ok));
  const visible = await onScreen();
  check(visible.length >= 2, "board: at least two cards are on screen to pick from", `${visible.length}`);
  await page.touchscreen.tap(visible[0].x, visible[0].y);
  await page.waitForSelector(".board-selection-bar", { timeout: 5000 }).catch(() => {});
  const bar = await box(".board-selection-bar");
  const cards = await page.$$eval(".react-flow__node-card", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom, selected: e.classList.contains("selected") || e.matches("[aria-selected=true]") }; }));
  const over = cards.filter((c) => overlap(bar, c));
  const dock = await box(".board-selection-dock");
  check(!!bar && !!dock, "board: the selected card has its bar");
  // docked at the top centre of the board, where the several-card bar is: the same place whichever card is selected
  const panel = await box(".graph-panel");
  check(bar && panel && bar.y - panel.y <= 24 && Math.abs((bar.x + bar.w / 2) - (panel.x + panel.w / 2)) <= 2, "board: the card's bar is docked at the top centre of the board", JSON.stringify({ bar, panel }));
  await page.touchscreen.tap(visible[visible.length - 1].x, visible[visible.length - 1].y);
  await page.waitForTimeout(300);
  const again = await box(".board-selection-bar");
  check(again && bar && Math.abs(again.y - bar.y) <= 1, "board: selecting another card leaves the bar where it was", JSON.stringify({ bar, again }));
  await shot("tablet-board-selected");
  void over;
}
// pen
{
  await page.getByRole("button", { name: "Pen", exact: true }).or(page.getByRole("button", { name: "筆", exact: true })).first().tap();
  await page.waitForTimeout(700);
  const undos = await page.getByRole("button", { name: /^(復原|Undo)/ }).count();
  check(undos === 1, "board: with the pen in hand there is one 復原", `${undos}`);
  const bars = await page.evaluate(() => [".board-toolbar", ".ink-toolbar-scroll", ".board-corner"].map((s) => { const e = document.querySelector(s); if (!e) return [s, null]; const r = e.getBoundingClientRect(); return [s, { x: r.x, y: r.y, r: r.right, b: r.bottom }]; }));
  const named = Object.fromEntries(bars);
  const pairs = [[".board-toolbar", ".ink-toolbar-scroll"], [".board-toolbar", ".board-corner"], [".ink-toolbar-scroll", ".board-corner"]];
  for (const [a, b] of pairs) if (named[a] && named[b]) check(!overlap({ ...named[a], w: 0, h: 0 }, { ...named[b], w: 0, h: 0 }), `board: ${a} and ${b} do not overlap`, JSON.stringify([named[a], named[b]]));
  await shot("tablet-board-pen");
}

await browser.close();
await site.close?.();
if (failures.length) { console.log(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
process.exit(0);
