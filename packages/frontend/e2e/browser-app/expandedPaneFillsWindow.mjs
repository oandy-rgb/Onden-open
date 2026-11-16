// npm run build:browser (repo root), then: node e2e/browser-app/expandedPaneFillsWindow.mjs [chromium|mobile-chrome] [--shots <dir>] [--measure]
// 「放大」 on a PDF note and on a handwriting note, in real Chromium: the pane must cover the whole window (its rect
// equals the viewport), nothing of the app (top bar, tab strip, info panel, sidebar) may still be hit at its old
// place, Esc and the button both give the earlier layout back, and a reload keeps it enlarged. Cases: info panel
// open, sidebar open, both closed, and side by side (enlarging from the left and from the right pane).
// jsdom cannot see this: the old tests only checked that the class name was on the element, while a wrapper that traps
// `position: fixed` (a containing block) left the pane the size of the note column.
// Exit code 1 when a check fails. --measure prints the rects and never fails (to look at a case).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, startSite, openApp, waitSaved } from "../layout-audit/env.mjs";

const engine = process.argv.find((a) => a === "chromium" || a === "mobile-chrome") ?? "chromium";
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const measureOnly = process.argv.includes("--measure");
if (shots) mkdirSync(shots, { recursive: true });
const failures = [];
const check = (ok, what, detail = "") => {
  console.log(`${ok || measureOnly ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok && !measureOnly) failures.push(what);
};
const PDF_NOTE = "00000000-0000-4000-8000-0000000e0001";
const OTHER_NOTE = "00000000-0000-4000-8000-0000000e0003";
const INK_NOTE = "00000000-0000-4000-8000-0000000e0002";
const TINY_PDF = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<<>>>>endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000052 00000 n
0000000101 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
178
%%EOF`).toString("base64");

const mobile = engine === "mobile-chrome";
const DESKTOP = [
  { id: "panel-open", panel: true, sidebar: true },
  { id: "panel-closed-sidebar-open", panel: false, sidebar: true },
  { id: "both-closed", panel: false, sidebar: false },
];
const CASES = [];
for (const kind of ["pdf", "ink"]) {
  if (mobile) CASES.push({ kind, id: `${kind}-phone` });
  else {
    for (const d of DESKTOP) CASES.push({ kind, ...d, id: `${kind}-${d.id}` });
    CASES.push({ kind, id: `${kind}-side-by-side-left`, panel: false, sidebar: true, split: "left" });
    // A PDF note's right-hand pane shows its text rendered (SplitPane has no PDF viewer), so only a handwriting page
    // can be enlarged from the right.
    if (kind === "ink") CASES.push({ kind, id: `${kind}-side-by-side-right`, panel: false, sidebar: true, split: "right" });
  }
}

const browser = await launch();
/** The pane's rect, and what is at the old place of each piece of the app (inside the pane = covered). */
const state = (page, probes) => page.evaluate((probes) => {
  const pane = document.querySelector(".pane--expanded");
  const r = pane?.getBoundingClientRect();
  const inPane = ([x, y]) => { const el = document.elementFromPoint(x, y); return !!el && !!pane && pane.contains(el); };
  return {
    vw: document.documentElement.clientWidth, vh: innerHeight,
    rect: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null,
    covered: probes.map(([name, x, y]) => [name, inPane([x, y])]),
    count: document.querySelectorAll(".pane--expanded").length,
    // The class guard: whatever wears the full-window layer class must be the window's size while it is shown.
    layers: [...document.querySelectorAll(".ui-layer--fill")].map((el) => { const b = el.getBoundingClientRect(); return { name: el.className.toString().split(" ")[0], width: b.width, height: b.height, left: b.left, top: b.top }; }),
  };
}, probes);
/** Centres of the app pieces that are on screen before enlarging. */
const pieces = (page) => page.evaluate(() => {
  const out = [];
  for (const [name, sel] of [["top bar", ".app-topbar, header.topbar, [data-app-topbar]"], ["tab strip", ".center-lens-bar, .phone-view-tabs, .split-pane-head"], ["info panel", ".right-panel, .info-panel, [aria-label='資訊面板']"], ["bottom bar", ".mobile-bottom-nav"]]) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width > 8 && r.height > 8 && getComputedStyle(el).visibility !== "hidden") { out.push([name, r.left + r.width / 2, r.top + Math.min(r.height / 2, 20)]); break; }
    }
  }
  return out;
});

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
for (const c of CASES.filter((x) => !only || x.id.includes(only))) {
  console.log(`\n== ${engine} ${c.id}`);
  const site = await startSite();
  const { page, context } = await openApp(browser, site, mobile ? { id: c.id, device: "Pixel 5", mobile: true } : { id: c.id, width: 1920, height: 1080 }, { seed: false });
  const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status >= 300 && r.status !== 409) throw new Error(`${method} ${path} → ${r.status}`);
    return r.status === 204 ? null : r.json();
  }, { method, path, body });
  const NOTE = c.kind === "pdf" ? PDF_NOTE : INK_NOTE;
  await call("POST", "/api/nodes", { id: NOTE, title: "放大測試", markdown: "" });
  let viewId = null;
  if (c.kind === "pdf") await call("PUT", `/api/nodes/${NOTE}/attributes/pdf_url`, { value: `data:application/pdf;base64,${TINY_PDF}`, value_type: "text" });
  else {
    const added = await call("POST", `/api/nodes/${NOTE}/views`, { layout: "handwriting", name: "手寫" });
    viewId = added?.view?.id ?? added?.id ?? (await call("GET", `/api/nodes/${NOTE}/views`)).views.find((v) => v.layout === "handwriting")?.id;
  }
  await call("POST", "/api/nodes", { id: OTHER_NOTE, title: "另一則筆記", markdown: "旁邊的文字" });
  await waitSaved(page);
  const side = c.kind === "pdf" ? `note:${NOTE}` : `note:${NOTE}:${viewId}`;
  // side by side: the pane to enlarge sits on the chosen side, a plain note on the other (the same note on both
  // sides shows its text twice and the app may fold it back to one pane)
  const main = c.split === "right" ? OTHER_NOTE : NOTE;
  const right = c.split === "left" ? `note:${OTHER_NOTE}` : side;
  const url = `${site.base}?view=notes&node=${main}&lens=editor` + (c.split ? `&right=${encodeURIComponent(right)}` : "");
  await page.goto(url);
  await page.waitForSelector(c.split ? ".split-pane" : ".obsidian-title-input, .pdf-node, .ink-note", { timeout: 60_000 });
  if (c.kind === "ink" && c.split !== "right") await page.getByRole("tab", { name: "手寫" }).first().click();
  await page.waitForSelector("[data-pdf-expand]", { timeout: 60_000 });
  if (!mobile) for (const [label, want] of [["筆記列表", c.sidebar], ["資訊", c.panel]]) {
    const button = page.getByRole("button", { name: label, exact: true }).first();
    if (await button.count() && (await button.getAttribute("aria-pressed") === "true") !== want) await button.click();
  }
  await page.waitForTimeout(800);
  const probes = await pieces(page);
  const buttons = page.locator("[data-pdf-expand]");
  const target = buttons.first();
  if (shots) await page.screenshot({ path: join(shots, `${c.id}-before.png`) });
  await target.click();
  await page.waitForTimeout(500);
  const open = await state(page, probes);
  if (shots) await page.screenshot({ path: join(shots, `${c.id}-enlarged.png`) });
  const near = (a, b) => Math.abs(a - b) <= 1;
  const detail = JSON.stringify({ viewport: [open.vw, open.vh], pane: open.rect && [open.rect.left, open.rect.top, open.rect.width, open.rect.height].map(Math.round) });
  check(open.count === 1 && !!open.rect, "exactly one pane is enlarged");
  if (open.rect) check(near(open.rect.left, 0) && near(open.rect.top, 0) && near(open.rect.width, open.vw) && near(open.rect.height, open.vh), "the pane covers the whole window", detail);
  for (const l of open.layers) check(near(l.left, 0) && near(l.top, 0) && near(l.width, open.vw) && near(l.height, open.vh), `every full-window layer (${l.name}) is the size of the window`, JSON.stringify(l));
  for (const [name, inside] of open.covered) check(inside, `the ${name} is covered (not hit at its old place)`);
  // Esc gives the earlier layout back
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const afterEsc = await state(page, probes);
  check(afterEsc.count === 0, "Esc shrinks it again");
  for (const [name, inside] of afterEsc.covered) check(!inside, `the ${name} is back after Esc`);
  // the button too, and a reload keeps it enlarged
  await target.click();
  await page.waitForTimeout(300);
  await page.locator("[data-pdf-expand]").first().waitFor();
  await page.reload();
  await page.waitForSelector(".pane--expanded", { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(500);
  const reloaded = await state(page, probes);
  check(reloaded.count >= 1, "after a reload the pane is still enlarged");
  if (reloaded.rect) check(near(reloaded.rect.width, reloaded.vw) && near(reloaded.rect.height, reloaded.vh), "…and still covers the whole window", JSON.stringify(reloaded.rect));
  await page.locator(".pane--expanded [data-pdf-expand]").first().click().catch(() => {});
  await page.waitForTimeout(300);
  const afterButton = await state(page, probes);
  check(afterButton.count === 0, "the button shrinks it again");
  await context.close();
  site.close();
}

await browser.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
