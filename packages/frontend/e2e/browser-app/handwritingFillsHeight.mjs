// npm run build:browser (repo root), then: node e2e/browser-app/handwritingFillsHeight.mjs [--shots <dir>]
// A note's 「手寫」 tab takes the height the note area has left (view-pane-fill, ViewTabs.css), in real Chromium at the
// sizes a tablet and a desktop really have, with the right panel and the left sidebar open and closed, on a phone, and in
// the side-by-side pane. Per case: the page book ends where the area ends (no empty band under the pen toolbar, the
// toolbar inside the screen and the tab strip still showing), and the page itself never grows taller than the screen.
// It failed when the pane's height was `calc(100dvh - 238px)`: at 1280×800 the toolbar ended 134px above the bottom.
// Exit code 1 when a check fails.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, startSite, openApp, waitSaved } from "../layout-audit/env.mjs";

const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(what); };
const NOTE = "00000000-0000-4000-8000-0000000d0f01";
/** How far above the bottom of the area the toolbar may end: the section's own bottom padding plus rounding. */
const SLACK = 16;

const CASES = [
  { id: "phone-390x844", width: 390, height: 844, mobile: true },
  { id: "tablet-portrait-800x1280", width: 800, height: 1280 },
  { id: "tablet-landscape-1280x800-panel-open", width: 1280, height: 800, panel: true, sidebar: true },
  { id: "tablet-landscape-1280x800-panel-closed", width: 1280, height: 800, panel: false, sidebar: true },
  { id: "tablet-landscape-1280x800-sidebar-closed", width: 1280, height: 800, panel: true, sidebar: false },
  { id: "tablet-landscape-1280x800-both-closed", width: 1280, height: 800, panel: false, sidebar: false },
  { id: "tablet-landscape-1204x714-sidebar-open", width: 1204, height: 714, panel: false, sidebar: true },
  { id: "tablet-landscape-1204x714-sidebar-closed", width: 1204, height: 714, panel: false, sidebar: false },
  { id: "desktop-1440x900", width: 1440, height: 900, panel: true, sidebar: true },
  { id: "desktop-1920x1080", width: 1920, height: 1080, panel: true, sidebar: true },
  { id: "side-by-side-1920x1080", width: 1920, height: 1080, panel: false, sidebar: true, split: true },
];

const browser = await launch();
const measure = (page) => page.evaluate(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
  const shown = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
  const pane = document.querySelector(".handwriting-pane");
  const nav = document.querySelector(".mobile-bottom-nav");
  const splitBody = pane?.closest(".split-pane-body");
  const tabs = [...document.querySelectorAll(".center-lens-bar, .phone-view-tabs, .split-pane-head")].find(shown);
  return {
    vh: innerHeight, docHeight: document.scrollingElement.scrollHeight,
    // The area's bottom: the screen, or the bottom navigation / the side pane's body when those are what ends it.
    areaBottom: splitBody ? splitBody.getBoundingClientRect().bottom - parseFloat(getComputedStyle(splitBody).paddingBottom) : shown(nav) ? nav.getBoundingClientRect().top : innerHeight,
    column: box(splitBody ?? document.querySelector(".notes-center-wrap")), sides: ((el, col) => el && col ? { left: el.getBoundingClientRect().left - col.getBoundingClientRect().left, right: col.getBoundingClientRect().right - el.getBoundingClientRect().right } : null)(document.querySelector(".ink-note-toolbar"), splitBody ?? document.querySelector(".notes-center-wrap")),
    pane: box(pane), toolbar: box(document.querySelector(".ink-note-toolbar")), tabs: box(tabs), title: box(document.querySelector(".obsidian-title-input, .view-pane-title, .split-pane-name")),
  };
});

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
for (const c of CASES.filter((x) => !only || x.id.includes(only))) {
  console.log(`\n== ${c.id}`);
  const site = await startSite(); // one site per case: the side pane and panel choices are kept per origin
  const { page, context } = await openApp(browser, site, c.mobile ? { id: c.id, device: "Pixel 5", mobile: true } : { id: c.id, width: c.width, height: c.height });
  if (c.mobile) await page.setViewportSize({ width: c.width, height: c.height }); // Pixel 5's touch, at the size the owner's phone has
  const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status >= 300 && r.status !== 409) throw new Error(`${method} ${path} → ${r.status}`);
    return r.status === 204 ? null : r.json();
  }, { method, path, body });
  await call("POST", "/api/nodes", { id: NOTE, title: "手寫高度測試", markdown: "一些文字" });
  const added = await call("POST", `/api/nodes/${NOTE}/views`, { layout: "handwriting", name: "手寫" });
  const viewId = added?.view?.id ?? added?.id ?? (await call("GET", `/api/nodes/${NOTE}/views`)).views.find((v) => v.layout === "handwriting")?.id;
  await waitSaved(page);
  const url = `${site.base}?view=notes&node=${NOTE}&lens=editor` + (c.split ? `&right=${encodeURIComponent(`note:${NOTE}:${viewId}`)}` : "");
  await page.goto(url);
  await page.waitForSelector(c.split ? ".split-pane" : ".obsidian-title-input", { timeout: 60_000 });
  if (!c.split) await page.getByRole("tab", { name: "手寫" }).first().click();
  await page.waitForSelector(".page-ink-surface", { timeout: 60_000 });
  for (const [label, want] of [["筆記列表", c.sidebar], ["資訊", c.panel]]) {
    if (want === undefined) continue;
    const button = page.getByRole("button", { name: label, exact: true }).first();
    if (await button.count() && (await button.getAttribute("aria-pressed") === "true") !== want) await button.click();
  }
  await page.waitForTimeout(1200);
  const m = await measure(page);
  if (shots) await page.screenshot({ path: join(shots, `${c.id}.png`) });
  const detail = JSON.stringify({ vh: m.vh, areaBottom: Math.round(m.areaBottom), paneBottom: Math.round(m.pane?.bottom ?? -1), toolbarBottom: Math.round(m.toolbar?.bottom ?? -1) });
  check(!!m.pane && !!m.toolbar, "the pen toolbar is on the 手寫 tab");
  if (m.pane && m.toolbar) {
    check(m.areaBottom - m.pane.bottom <= SLACK, "the page book reaches the bottom of its area (no empty band under it)", detail);
    check(m.areaBottom - m.toolbar.bottom <= SLACK && m.toolbar.bottom <= m.areaBottom + 1, "the toolbar sits at the bottom of the area, inside the screen", detail);
    check(m.toolbar.top >= (m.tabs?.bottom ?? 0) && m.pane.height >= 300, "the toolbar is under the tab strip and the book has room", `pane height ${Math.round(m.pane.height)}`);
  }
  // The page and the pen toolbar are centred in the note column: the same room at both sides (a scrollbar may take ~15 px of one).
  if (m.sides) check(Math.abs(m.sides.left - m.sides.right) <= 2, "the pen toolbar is centred in the note column", `left ${Math.round(m.sides.left)} / right ${Math.round(m.sides.right)}`);
  check(!!m.tabs && m.tabs.top >= 0 && m.tabs.bottom <= m.vh, "the tab strip is still on the screen");
  check(m.docHeight <= m.vh + 1, "the page itself does not scroll (no second scrollbar)", `document ${m.docHeight} / screen ${m.vh}`);
  await context.close();
  site.close();
}

await browser.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
