// npm run build:browser (repo root), then: node e2e/browser-app/boardPhoneFull.mjs [--shots <dir>]
// A phone's whiteboard is full screen for good and the page cannot move (docs/agents/decisions-canvas.md), in real
// Chromium with real touch events, Pixel 5 (touch), dark and light, at 390×844 and 320×640; desktop stays as it was:
//   full     the board opens full screen: no ⤢, no bottom bar, no top bar, the tool bar sits on the bottom edge
//   fixed    one finger, two fingers, an edge pull, a drag on the tool bar or on a card, and a keyboard-sized viewport
//            change never move document.scrollingElement.scrollTop or visualViewport.offsetTop
//   leave    ‹ goes back (the note list here: nothing was visited before); the title ⌄ sheet switches to 「內容」 and back
//   desktop  1280×800 keeps the ⤢ button, the tabs and no phone controls
// Exit code 1 when a check fails.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, startSite, openApp, waitSaved, VIEWPORTS } from "../layout-audit/env.mjs";

const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(what); };
const BOARD = "00000000-0000-4000-8000-0000000b0a2d";
const CARD_IDS = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-0000000b0a3${n}`);

const browser = await launch();
const site = await startSite();

async function seed(page) {
  await page.evaluate(async ({ BOARD, CARD_IDS }) => {
    const call = async (method, path, body) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.status >= 300 && r.status !== 409) throw new Error(`${method} ${path} → ${r.status}`);
    };
    await call("POST", "/api/nodes", { id: BOARD, title: "手機白板測試：標題很長很長很長很長很長", markdown: "" });
    for (const [i, id] of CARD_IDS.entries()) await call("POST", "/api/nodes", { id, title: `卡片 ${i + 1}`, markdown: `內容 ${i + 1}` });
    await call("PATCH", `/api/boards/${BOARD}`, { cards: { upsert: CARD_IDS.map((nodeId, i) => ({ nodeId, x: 40 + (i % 2) * 160, y: 140 + Math.floor(i / 2) * 140, width: 140 })) } });
  }, { BOARD, CARD_IDS });
  await waitSaved(page);
}

async function session(vp, size) {
  const { page, context } = await openApp(browser, site, vp);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  if (size) await page.setViewportSize(size);
  await seed(page);
  const open = async () => {
    await page.goto(`${site.base}?view=notes&node=${BOARD}&lens=canvas`);
    await page.waitForSelector(".react-flow__pane", { timeout: 60_000 });
    await page.waitForTimeout(1500);
  };
  await open();
  return { page, context, open };
}

const state = (page) => page.evaluate(() => ({
  scrollTop: document.scrollingElement.scrollTop, vvTop: visualViewport.offsetTop, scrollHeight: document.documentElement.scrollHeight, innerHeight,
  fullscreenButton: !!document.querySelector('button[aria-label="全螢幕"], button[aria-label="離開全螢幕"]'),
  nav: !!document.querySelector(".mobile-bottom-nav") && getComputedStyle(document.querySelector(".mobile-bottom-nav")).display !== "none",
  topbar: ["app-topbar", "center-lens-bar", "overview-mobile-tabs"].some((c) => { const e = document.querySelector(`.${c}`); return e && getComputedStyle(e).display !== "none"; }),
  toolbarBottomGap: (() => { const r = document.querySelector(".board-toolbar")?.getBoundingClientRect(); return r ? innerHeight - r.bottom : null; })(),
  locked: document.body.classList.contains("onden-board-locked"),
}));

for (const scheme of ["dark", "light"]) {
  for (const size of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
    const label = `${scheme} ${size.width}×${size.height}`;
    const vp = { ...VIEWPORTS.find((v) => v.id === "pixel5"), dark: scheme === "dark" };
    const { page, context, open } = await session(vp, size);
    const cdp = await context.newCDPSession(page);
    const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
    const drag = async (a, b, steps = 10) => { await touch("touchStart", [a]); for (let i = 1; i <= steps; i++) { await touch("touchMove", [{ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }]); await page.waitForTimeout(12); } await touch("touchEnd", []); };
    const shot = (name) => shots ? page.screenshot({ path: join(shots, `${scheme}-${size.width}x${size.height}-${name}.png`) }) : Promise.resolve();

    const s0 = await state(page);
    check(s0.locked && !s0.fullscreenButton && !s0.nav && !s0.topbar, `${label} full: full screen at once, no ⤢, no bottom bar, no top bars`, JSON.stringify(s0));
    check(s0.scrollHeight <= s0.innerHeight, `${label} full: the page is exactly the screen`, `${s0.scrollHeight} vs ${s0.innerHeight}`);
    check(s0.toolbarBottomGap !== null && s0.toolbarBottomGap <= 12, `${label} full: the tool bar sits on the bottom edge`, `${s0.toolbarBottomGap}px`);
    await shot("board");

    const trail = [];
    const sample = async () => trail.push(await state(page));
    const W = size.width, H = size.height;
    const toolbar = await page.$eval(".board-toolbar", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const cardAt = await page.$eval(".react-flow__node-card", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 20 }; });
    const gestures = [
      [{ x: W * 0.8, y: H * 0.5 }, { x: W * 0.2, y: H * 0.2 }], // one finger across the board
      [{ x: W / 2, y: H * 0.35 }, { x: W / 2, y: H * 0.9 }],    // down: the pull-to-refresh direction
      [{ x: W / 2, y: H * 0.7 }, { x: W / 2, y: H * 0.1 }],     // up
      [{ x: W / 2, y: 1 }, { x: W / 2, y: H * 0.6 }],           // pulled in from the top edge
      [{ x: W / 2, y: H - 1 }, { x: W / 2, y: H * 0.3 }],       // pulled in from the bottom edge
      [{ x: 2, y: H * 0.5 }, { x: W * 0.8, y: H * 0.5 }],       // from the left edge (system back gesture)
      [toolbar, { x: toolbar.x, y: toolbar.y - 300 }],          // dragged on the tool bar
      [toolbar, { x: toolbar.x, y: toolbar.y + 40 }],
      [cardAt, { x: cardAt.x + 20, y: cardAt.y + 200 }],        // dragged on a card
    ];
    for (const [a, b] of gestures) { await drag(a, b); await sample(); }
    // two fingers: pinch out and in, and two fingers dragging together
    await touch("touchStart", [{ x: W / 2 - 30, y: H / 2 }, { x: W / 2 + 30, y: H / 2 }]);
    for (let i = 1; i <= 10; i++) { await touch("touchMove", [{ x: W / 2 - 30 - i * 8, y: H / 2 - i * 4 }, { x: W / 2 + 30 + i * 8, y: H / 2 + i * 4 }]); await page.waitForTimeout(12); }
    await touch("touchEnd", []); await sample();
    await touch("touchStart", [{ x: W / 2 - 30, y: H / 2 }, { x: W / 2 + 30, y: H / 2 }]);
    for (let i = 1; i <= 10; i++) { await touch("touchMove", [{ x: W / 2 - 30, y: H / 2 + i * 15 }, { x: W / 2 + 30, y: H / 2 + i * 15 }]); await page.waitForTimeout(12); }
    await touch("touchEnd", []); await sample();
    // the keyboard coming up and going away is a shorter viewport and back
    await page.setViewportSize({ width: W, height: Math.round(H * 0.55) }); await page.waitForTimeout(150); await sample();
    await page.setViewportSize({ width: W, height: H }); await page.waitForTimeout(150); await sample();
    const moved = trail.filter((s) => s.scrollTop !== 0 || s.vvTop !== 0);
    check(moved.length === 0, `${label} fixed: no gesture moves the page`, moved.length ? JSON.stringify(moved[0]) : `${trail.length} samples`);

    // the title sheet → 「內容」 → back to the board through the tab row
    await open();
    await page.locator(".board-note-title").tap();
    await page.waitForSelector(".board-note-sheet");
    await shot("title-sheet");
    await page.locator(".board-note-sheet").getByRole("tab", { name: "內容" }).tap();
    await page.waitForTimeout(800);
    const content = await state(page);
    check(!content.locked && content.nav && !(await page.$(".react-flow__pane")), `${label} leave: 「內容」 from the title sheet shows the note with its bars back`, JSON.stringify(content));
    await shot("content");
    // the note's tab row sits in the page above its title: one tap on 「白板」 brings the board back
    await page.locator(".phone-view-tabs").getByRole("tab", { name: "白板" }).tap();
    await page.waitForSelector(".react-flow__pane");
    await page.waitForTimeout(800);
    check((await state(page)).locked, `${label} leave: 「白板」 brings the full screen board back`);

    // ‹ leaves the board
    await page.locator('.board-history button[aria-label="返回筆記列表"], .board-history button[aria-label="返回"]').first().tap();
    await page.waitForTimeout(800);
    const list = await page.evaluate(() => ({ tab: document.querySelector(".overview-workspace")?.getAttribute("data-mobile-tab"), locked: document.body.classList.contains("onden-board-locked") }));
    check(list.tab === "list" && !list.locked, `${label} leave: ‹ goes back to the note list`, JSON.stringify(list));
    await context.close();
  }
}

// ── desktop stays as it was
{
  const { page, context } = await session(VIEWPORTS.find((v) => v.id === "1280"));
  const s = await state(page);
  check(!s.locked && s.fullscreenButton, "desktop 1280×800: the ⤢ button is there and the board is not locked", JSON.stringify(s));
  // the phone top bar's tab-name button stays in the DOM but hidden; what matters is that none shows
  check(await page.evaluate(() => ![...document.querySelectorAll(".board-note-title")].some((el) => el.offsetParent !== null)), "desktop 1280×800: no phone title button");
  if (shots) await page.screenshot({ path: join(shots, "desktop-1280x800-board.png") });
  await context.close();
}

await browser.close();
site.close();
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
