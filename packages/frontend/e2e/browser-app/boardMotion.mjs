// npm run build:browser (repo root), then: node e2e/browser-app/boardMotion.mjs [--shots <dir>]
// The whiteboard's touch behaviour on a phone viewport (Pixel 5: touch, 393×727), measured in real Chromium with
// real touch events (CDP Input.dispatchTouchEvent):
//   follow   a dragged card stays under the finger (finger − card top-left, every step) at zoom 0.5, 1 and 2
//   lift     a dragging card is raised (shadow + scale) and settles back after the drop
//   tap      touching or double-tapping a card or its edge never adds a card; a mouse double-click on empty space still does
//   page     dragging the board scrolls nothing: the page stays put and the bottom bar keeps its place
//   glide    letting go of a fast drag keeps the board moving, a new touch stops it
//   minimap  a phone board shows none
// Exit code 1 when a check fails. The app is the browser build (its backend runs in the page's worker).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, startSite, openApp, waitSaved, VIEWPORTS } from "../layout-audit/env.mjs";
import { IDS } from "../layout-audit/seed.mjs";

const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(what); };

const vp = VIEWPORTS.find((v) => v.id === "pixel5");
const browser = await launch();
const site = await startSite();
const { page, context } = await openApp(browser, site, vp);
// The audit harness asks for reduced motion; the motion checks need it off (and one check turns it back on).
await page.emulateMedia({ reducedMotion: "no-preference" });
const cdp = await context.newCDPSession(page);
const sleep = (ms) => page.waitForTimeout(ms);
const shot = (name) => shots ? page.screenshot({ path: join(shots, `${name}.png`) }) : Promise.resolve();

// ── touch ────────────────────────────────────────────────────────────────────
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
/** Press at `a`, move to `b` in `steps` frames, calling `each(point, step)` after each; release unless `hold`. */
async function drag(a, b, { steps = 12, frame = 16, each, hold = false } = {}) {
  await touch("touchStart", [a]);
  for (let i = 1; i <= steps; i++) {
    const p = { x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps };
    await touch("touchMove", [p]);
    await sleep(frame);
    if (each) await each(p, i);
  }
  if (!hold) await touch("touchEnd", []);
}
async function tap(p) { await touch("touchStart", [p]); await sleep(40); await touch("touchEnd", []); }

// ── the board ────────────────────────────────────────────────────────────────
const cards = () => page.$$eval(".react-flow__node-card", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.id, x: r.x, y: r.y, w: r.width, h: r.height }; }));
const card = async (id) => (await cards()).find((c) => c.id === id);
const viewport = () => page.$eval(".react-flow__viewport", (e) => { const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(e.style.transform); return { x: +m[1], y: +m[2], zoom: +m[3] }; });
const pageState = () => page.evaluate(() => ({
  scrollTop: document.scrollingElement.scrollTop, vvTop: visualViewport.offsetTop,
  navTop: document.querySelector(".mobile-bottom-nav")?.getBoundingClientRect().top ?? null,
  navHeight: document.querySelector(".mobile-bottom-nav")?.getBoundingClientRect().height ?? null,
}));
const press = (label) => page.evaluate((l) => document.querySelector(`button[aria-label="${l}"]`)?.click(), label);
const url = `${site.base}?view=notes&node=00000000-0000-4000-8000-0000000b0a2d&lens=canvas`;

async function openBoard() {
  await page.goto(url);
  await page.waitForSelector(".react-flow__pane", { timeout: 60_000 });
  await sleep(1500);
}
const BOARD = "00000000-0000-4000-8000-0000000b0a2d";
const CARD_IDS = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-0000000b0a3${n}`);
/** A board note with four cards laid out apart, written through the app's own routes (its backend runs in the page's worker). */
async function seedBoard() {
  await page.evaluate(async ({ BOARD, CARD_IDS }) => {
    const call = async (method, path, body) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.status >= 300 && r.status !== 409) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
    };
    await call("POST", "/api/nodes", { id: BOARD, title: "拖曳測試板", markdown: "" });
    for (const [i, id] of CARD_IDS.entries()) await call("POST", "/api/nodes", { id, title: `卡片 ${i + 1}`, markdown: `卡片 ${i + 1} 的內容` });
    await call("PATCH", `/api/boards/${BOARD}`, { cards: { upsert: CARD_IDS.map((nodeId, i) => ({ nodeId, x: 420 + (i % 2) * 340, y: Math.floor(i / 2) * 260, width: 260 })) } });
  }, { BOARD, CARD_IDS });
  await waitSaved(page);
}
/** Put the camera at `zoom`, centred on a plain card that nothing covers at the point we grab — through the saved
 *  viewport, so the zoom is exact. (The board's own note card sits over its neighbours, so the first candidates
 *  can be buried.) Returns that card's id. */
async function openAtZoom(zoom) {
  const n = await page.$$eval(".react-flow__node-card", (els) => els.map((e) => ({ id: e.dataset.id, w: e.offsetWidth, h: e.offsetHeight, at: /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(e.style.transform).slice(1, 3).map(Number) })));
  const candidates = n.filter((c) => c.w < 400).sort((a, b) => a.w * a.h - b.w * b.h);
  for (const target of candidates) {
    const fx = target.at[0] + target.w / 2, fy = target.at[1] + target.h / 2;
    await page.evaluate(({ zoom, fx, fy }) => {
      const key = Object.keys(sessionStorage).find((k) => k.startsWith("onden.canvasViewport."));
      sessionStorage.setItem(key, JSON.stringify({ x: 196 - fx * zoom, y: 330 - fy * zoom, zoom }));
    }, { zoom, fx, fy });
    await waitSaved(page).catch(() => {}); // a reload while the browser's storage is still being written loses the write
    await page.goto(url);
    await page.waitForSelector(".react-flow__node-card", { state: "attached" }).catch(async () => { await page.screenshot({ path: "/tmp/claude-0/shots0/fail.png" }); throw new Error("no cards after reload"); });
    await sleep(1500);
    let owner;
    for (let wait = 0; wait < 8000 && owner !== target.id; wait += 250) {
      const p = await bodyPoint(target.id).catch(() => null);
      owner = p && await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".react-flow__node")?.dataset.id, p);
      if (owner !== target.id) await sleep(250);
    }
    if (owner === target.id) return target.id;
    if (process.env.DEBUG_BOARD) console.log("buried", zoom, target.id.slice(-2), owner?.slice(-2), JSON.stringify(await card(target.id)));
  }
  throw new Error("no card on the test board can be grabbed without another card on top of it");
}
/** A point on the board where nothing sits: the bare pane, clear of the bars floating over it. */
async function emptyPoint() {
  return page.evaluate(() => {
    for (let y = 300; y < 640; y += 20) for (let x = 20; x < 380; x += 20) {
      const hit = document.elementFromPoint(x, y);
      if (hit?.classList.contains("react-flow__pane")) return { x, y };
    }
    return null;
  });
}
async function bodyPoint(id) {
  // A point on the card, off its handles and edges.
  const c = await card(id);
  return { x: c.x + c.w / 2, y: c.y + Math.min(c.h / 2, 60), c };
}

await seedBoard();
await openBoard();
await press("顯示全部"); await sleep(900);
check((await cards()).length >= 4, "the test board has cards", String((await cards()).length));
await shot("0-board");

// ── tap, zoomed far out: the first tap selects the card and it grows from its small form; a quick second tap must not add one
{
  const small = await openAtZoom(0.35);
  const before = (await cards()).length;
  const c = await card(small);
  const at = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
  await tap(at); await sleep(90); await tap(at); await sleep(900);
  check((await cards()).length === before, "tap: a quick double tap on a small card (zoomed far out) adds no card", `${before} → ${(await cards()).length}, card ${c.w.toFixed(0)}×${c.h.toFixed(0)}px`);
  const edge = { x: c.x + c.w + 4, y: c.y + c.h / 2 };
  await tap(edge); await sleep(90); await tap(edge); await sleep(900);
  check((await cards()).length === before, "tap: a quick double tap just beside a small card adds no card", `${before} → ${(await cards()).length}`);
}

// ── follow ───────────────────────────────────────────────────────────────────
for (const zoom of [0.5, 1, 2]) {
  const id = await openAtZoom(zoom);
  const v = await viewport();
  const start = await bodyPoint(id);
  const offset = { x: start.x - start.c.x, y: start.y - start.c.y };
  let worst = 0;
  let noMove = true;
  // The browser holds back touch moves while the finger is inside its slop (about 15px): the page, and so the
  // card, first hears of the finger at the first move it is given. Follow the finger as the page knows it.
  await page.evaluate(() => { window.__finger = null; document.addEventListener("touchmove", (e) => { const t = e.touches[0]; window.__finger = { x: t.clientX, y: t.clientY }; }, true); });
  const track = async () => {
    const finger = await page.evaluate(() => window.__finger);
    if (!finger) return;
    const c = await card(id);
    worst = Math.max(worst, Math.hypot(finger.x - c.x - offset.x, finger.y - c.y - offset.y));
    noMove = false;
  };
  await drag(start, { x: start.x + 60, y: start.y + 90 }, { steps: 15, frame: 60, each: track, hold: true });
  await shot(`1-dragging-zoom${zoom}`);
  const during = await page.$eval(".react-flow__node.dragging .card-node", (e) => { const s = getComputedStyle(e); return { shadow: s.boxShadow, transform: s.transform, cursor: s.cursor }; }).catch(() => null);
  await touch("touchEnd", []);
  await sleep(400);
  const after = await viewport();
  check(!noMove && worst <= 1, `follow: card stays under the finger at zoom ${zoom}`, `worst error ${worst.toFixed(2)}px, camera moved ${Math.abs(after.x - v.x) + Math.abs(after.y - v.y) > 0.5 ? "yes" : "no"}`);
  check(Math.abs(after.x - v.x) + Math.abs(after.y - v.y) < 0.5, `follow: dragging a card does not pan the board (zoom ${zoom})`);
  if (zoom === 1) {
    check(!!during && during.shadow !== "none", "lift: a dragging card has a deeper shadow", during?.shadow ?? "no .dragging card found");
    const shotAfter = await page.$eval(`.react-flow__node[data-id="${id}"] .card-node`, (e) => getComputedStyle(e).transform);
    check(shotAfter === "none" || /^matrix\(1, 0, 0, 1, /.test(shotAfter), "lift: the card is back to its size after the drop", shotAfter);
    await shot("2-dropped");
  }
}

// ── tap: opening or selecting a card never adds one ─────────────────────────
const tapId = await openAtZoom(1);
const count = async () => (await cards()).length;
const base = await count();
const c0 = await card(tapId);
await tap({ x: c0.x + 30, y: c0.y + 12 }); await sleep(500);
check((await count()) === base, "tap: one tap on a card adds no card");
await tap({ x: c0.x + 30, y: c0.y + 12 }); await sleep(120); await tap({ x: c0.x + 30, y: c0.y + 12 }); await sleep(700);
check((await count()) === base, "tap: a double tap on a card adds no card");
const c1 = await card(tapId);
for (const [dx, dy] of [[-6, c1.h / 2], [c1.w + 6, c1.h / 2], [c1.w / 2, -6], [c1.w / 2, c1.h + 6]]) {
  await tap({ x: c1.x + dx, y: c1.y + dy }); await sleep(120); await tap({ x: c1.x + dx, y: c1.y + dy }); await sleep(600);
}
check((await count()) === base, "tap: double taps just outside the card's edges add no card");
await tap({ x: c1.x + c1.w / 2, y: c1.y }); await sleep(120); await tap({ x: c1.x + c1.w / 2, y: c1.y }); await sleep(600);
check((await count()) === base, "tap: double tap on a selected card's edge handle adds no card");
const blank = await emptyPoint();
check(!!blank, "tap: found bare board to tap");
await tap(blank); await sleep(120); await tap(blank); await sleep(700);
check((await count()) === base, "tap: a double tap on empty board adds no card (touch)");
await page.mouse.dblclick(blank.x, blank.y); await sleep(1200);
check((await count()) === base + 1, "tap: a mouse double-click on empty board still adds a card");
await page.keyboard.press("Escape");

// ── page: dragging the board moves nothing else ─────────────────────────────
await openAtZoom(1);
const before = await pageState();
const trail = [];
for (const [a, b] of [[{ x: 60, y: 560 }, { x: 330, y: 300 }], [{ x: 330, y: 300 }, { x: 60, y: 560 }], [{ x: 200, y: 300 }, { x: 200, y: 690 }], [{ x: 200, y: 600 }, { x: 200, y: 200 }]]) {
  await drag(a, b, { steps: 8, frame: 10, each: async () => trail.push(await pageState()) });
  trail.push(await pageState());
}
const moved = trail.filter((s) => s.scrollTop !== before.scrollTop || s.vvTop !== before.vvTop || s.navTop !== before.navTop || s.navHeight !== before.navHeight);
check(moved.length === 0, "page: dragging the board scrolls nothing; the bottom bar stays put", moved.length ? JSON.stringify(moved[0]) : `${trail.length} samples`);
await shot("3-after-drag");

// ── glide ────────────────────────────────────────────────────────────────────
await openAtZoom(1);
const g0 = await viewport();
const grip = await emptyPoint(); // the cards were dragged about above: pan from bare board
const flick = () => drag(grip, { x: grip.x + 230, y: grip.y }, { steps: 6, frame: 12 });
await flick();
// Wait for the board to start moving, then follow it: after the finger has gone it must still be moving, slower each time.
let at = await viewport();
for (let waited = 0; waited < 1500 && Math.abs(at.x - g0.x) < 20; waited += 50) { await sleep(50); at = await viewport(); }
const run = [at.x];
for (let k = 0; k < 4; k++) { await sleep(120); run.push((await viewport()).x); }
const steps = run.slice(1).map((x, k) => x - run[k]);
check(steps[0] > 1 && steps.every((d, k) => k === 0 || d <= steps[k - 1] + 0.5) && run[4] > run[0], "glide: the board keeps moving after a fast release, slowing down", run.map((x) => x.toFixed(0)).join(" → "));
await sleep(2500);
const g4 = await viewport(); await sleep(300); const g5 = await viewport();
check(Math.abs(g5.x - g4.x) < 0.5, "glide: it comes to rest");
await flick();
await sleep(150);
await touch("touchStart", [{ x: 200, y: 400 }]);
const s1 = await viewport(); await sleep(200); const s2 = await viewport();
await touch("touchEnd", []);
check(Math.abs(s2.x - s1.x) < 1, "glide: a new touch stops it", `${s1.x.toFixed(1)} → ${s2.x.toFixed(1)}`);

// ── reduced motion: no glide, no swell
await page.emulateMedia({ reducedMotion: "reduce" });
{
  await openAtZoom(1);
  const r0 = await viewport();
  const grip = await emptyPoint();
  await drag(grip, { x: grip.x + 230, y: grip.y }, { steps: 6, frame: 12 });
  const r1 = await viewport(); await sleep(400); const r2 = await viewport();
  check(Math.abs(r2.x - r1.x) < 0.5 && r1.x > r0.x + 50, "reduced motion: the board follows the finger and stops when it lifts", `${r0.x.toFixed(0)} → ${r1.x.toFixed(0)} → ${r2.x.toFixed(0)}`);
  const id = await openAtZoom(1);
  const start = await bodyPoint(id);
  await drag(start, { x: start.x + 40, y: start.y + 40 }, { steps: 8, frame: 40, hold: true });
  const swell = await page.$eval(`.react-flow__node[data-id="${id}"] .card-node`, (e) => ({ transform: getComputedStyle(e).transform, shadow: getComputedStyle(e).boxShadow })).catch(() => null);
  await touch("touchEnd", []);
  check(!!swell && !/^matrix\(1\.0/.test(swell.transform) && /^(none|matrix\(1, 0, 0, 1,)/.test(swell.transform), "reduced motion: a held card does not swell", swell?.transform);
}
await page.emulateMedia({ reducedMotion: "no-preference" });

// ── minimap: a phone has none (the 「顯示」 sheet leaves its switch out), so nothing can sit under the tool bar
await openAtZoom(1);
check(!(await page.$(".kw-canvas-minimap")), "minimap: a phone board shows none");
await shot("4-no-minimap");

await browser.close();
site.close();
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
