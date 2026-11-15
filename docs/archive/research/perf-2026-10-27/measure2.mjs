// 2026-10-27 new scenarios (local persona stack only; never prod).
// usage: BASE=http://localhost:5099 node measure2.mjs <tier> <desktop|phone> <runs>
// Per run: fresh context, signed in, cold boot, wait for usable + 8 s, then:
//   expandAll (sidebar 展開), typing5k (keydown→next frame + Event Timing INP-like), whiteboard (tab switch, pane drag fps, card drag fps),
//   pdf (open, first page canvas, scroll fps), history (open the 歷史 screen in-app).
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const BASE = process.env.BASE || "http://localhost:5099";
const TIER = process.argv[2] || "5k", DEVICE = process.argv[3] || "desktop", RUNS = Number(process.argv[4] || 5);
const PHONE = DEVICE === "phone";
const NET = PHONE ? { offline: false, latency: 150, downloadThroughput: 9e6 / 8, uploadThroughput: 3e6 / 8 } : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
const AUTH = { email: "perf-owner@example.com", password: "perf-pass-12345" };
const INIT = `(() => {
  const P = window.__perf = { keys: [], ev: [], lt: [], frames: [] };
  try { localStorage.setItem("onden.welcomeDismissed", "1"); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (P.trackEv) P.ev.push({ n: e.name, d: e.duration }); }).observe({ type: "event", durationThreshold: 16, buffered: false }); } catch {}
  document.addEventListener("keydown", (ev) => { if (!P.trackKeys) return; const t0 = ev.timeStamp; requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => P.keys.push(performance.now() - t0); ch.port2.postMessage(0); }); }, true);
  // frame sampler: rAF deltas while P.fps is on
  let last = 0; const tick = (t) => { if (P.fps) { if (last) P.frames.push(t - last); last = t; } else last = 0; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  const check = () => { const rows = document.querySelectorAll(".obsidian-page-row"); const gate = document.querySelector(".membership-gate"); const grid = document.querySelector(".workspace-grid");
    const dataUp = rows.length > 0 || (!!document.querySelector(".mobile-bottom-nav") && /建立了/.test(document.body.innerText));
    if (P.usable === undefined && dataUp && !gate && grid && !grid.hasAttribute("inert")) P.usable = performance.now(); };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["inert", "class"] });
})();`;
const med = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10 : null; };
const fpsStats = (f) => ({ frames: f.length, avgFps: f.length ? Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length)) : null, p95FrameMs: q(f, 0.95), maxFrameMs: q(f, 1), over50: f.filter((x) => x > 50).length });
const ltSince = (lt, from) => { const xs = lt.filter(([s]) => s >= from).map(([, d]) => d); return { n: xs.length, sum: xs.reduce((a, b) => a + b, 0), max: xs.length ? Math.max(...xs) : 0 }; };
const P = (page) => page.evaluate(() => ({ lt: [...window.__perf.lt], frames: [...window.__perf.frames], keys: [...window.__perf.keys], ev: [...window.__perf.ev] }));
const now = (page) => page.evaluate(() => performance.now());

async function openViaSearch(page, title, text) {
  const back = page.locator(".omt-back").filter({ visible: true });
  if (await back.count()) { await back.first().click(); await page.locator(".sidebar-search-toggle, .obsidian-search-input").filter({ visible: true }).first().waitFor({ timeout: 30000 }); }
  if (!(await page.locator(".obsidian-search-input").isVisible())) await page.locator(".sidebar-search-toggle").filter({ visible: true }).first().click();
  await page.locator(".obsidian-search-input").fill(text ?? title);
  const row = page.locator(".obsidian-search-row .obsidian-page-button").filter({ has: page.locator(".sb-item-title", { hasText: new RegExp(`^${title}$`) }) }).first();
  await row.waitFor({ timeout: 60_000 }); await page.waitForTimeout(800);
  if (PHONE) await row.tap(); else await row.click();
}
async function dragFps(page, from, to, ms = 2000) {
  await page.evaluate(() => { window.__perf.frames = []; });
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.evaluate(() => { window.__perf.fps = true; });
  const steps = Math.round(ms / 16); const t0 = Date.now();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps); await page.waitForTimeout(Math.max(0, i * 16 - (Date.now() - t0))); }
  await page.evaluate(() => { window.__perf.fps = false; }); await page.mouse.up();
  return fpsStats((await P(page)).frames);
}

async function oneRun(browser, i) {
  const R = { tier: TIER, device: DEVICE, run: i };
  const ctx = await browser.newContext({ baseURL: BASE, locale: "zh-TW", serviceWorkers: "allow",
    ...(PHONE ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } }) });
  await ctx.addInitScript(INIT);
  const s = await ctx.request.post("/api/auth/sign-in/email", { data: AUTH, headers: { origin: BASE, "content-type": "application/json" } });
  if (!s.ok()) throw new Error("signin " + s.status());
  const page = await ctx.newPage(); page.on("pageerror", (e) => (R.pageerrors ??= []).push(String(e).slice(0, 120)));
  const cdp = await ctx.newCDPSession(page);
  if (PHONE) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", NET);
  await page.goto("/?view=notes");
  await page.waitForFunction(() => window.__perf?.usable !== undefined, null, { timeout: 300_000, polling: 100 });
  await page.waitForTimeout(8000);

  // 1. sidebar 展開 (expand all) — desktop sidebar only; on phone it is in the browse level.
  try {
    if (PHONE) throw new Error("phone: the sidebar 展開 button is not in the phone layout (not measured)");
    const btn = page.locator(".sb-bar-btn", { hasText: /^展開$/ }).filter({ visible: true }).first();
    const rowsBefore = await page.locator(".obsidian-page-row").count();
    const t0 = await now(page);
    await page.evaluate(() => { window.__perf.mut = performance.now(); new MutationObserver(() => { window.__perf.mut = performance.now(); }).observe(document.body, { subtree: true, childList: true }); });
    await btn.click();
    let lastMut = 0; for (let k = 0; k < 200; k++) { await page.waitForTimeout(100); const m = await page.evaluate(() => window.__perf.mut); if (k > 3 && performance.now() && (await now(page)) - m > 400) { lastMut = m; break; } }
    const p = await P(page);
    R.expandAll = { msToSettled: Math.round(lastMut - t0), rowsBefore, rowsAfter: await page.locator(".obsidian-page-row").count(), lt: ltSince(p.lt, t0) };
    await page.locator(".sb-bar-btn", { hasText: /^收合$/ }).filter({ visible: true }).first().click({ timeout: 2000 }).catch(() => {});
  } catch (e) { R.expandAll = { error: String(e).slice(0, 160) }; }

  // 1b. switching to a short note through the sidebar search (click → its text is in the editor); phone gap of measure.mjs
  try {
    R.switchShort = [];
    for (const [title, text, want] of [["效能短筆記", "夸克螺旋", "夸克螺旋"], ["效能長筆記", "效能長筆記", "第 1 節"]]) {
      const back = page.locator(".omt-back").filter({ visible: true });
      if (await back.count()) { await back.first().click(); await page.locator(".sidebar-search-toggle, .obsidian-search-input").filter({ visible: true }).first().waitFor({ timeout: 30000 }); }
      if (!(await page.locator(".obsidian-search-input").isVisible())) await page.locator(".sidebar-search-toggle").filter({ visible: true }).first().click();
      await page.locator(".obsidian-search-input").fill(text);
      const row = page.locator(".obsidian-search-row .obsidian-page-button").filter({ has: page.locator(".sb-item-title", { hasText: new RegExp(`^${title}$`) }) }).first();
      await row.waitFor({ timeout: 60_000 }); await page.waitForTimeout(800);
      const t0 = await now(page);
      if (PHONE) await row.tap(); else await row.click();
      await page.waitForFunction((w) => { const cm = [...document.querySelectorAll(".cm-content")].find((e) => e.getClientRects().length > 0); return cm && cm.textContent.includes(w); }, want, { timeout: 60000, polling: 20 });
      R.switchShort.push({ title, ms: Math.round((await now(page)) - t0) });
      await page.waitForTimeout(1200);
    }
  } catch (e) { R.switchShort = { error: String(e).slice(0, 160) }; }

  // 2. typing in the 5k-char note
  try {
    await openViaSearch(page, "效能五千字筆記", "效能五千字筆記");
    await page.waitForFunction(() => [...document.querySelectorAll(".cm-content")].some((e) => e.getClientRects().length && e.textContent.includes("效能五千字筆記")), null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const cm = page.locator(".cm-content").filter({ visible: true }).first();
    await cm.click({ position: { x: 80, y: 60 } }); await page.keyboard.press("Control+End");
    await page.evaluate(() => { const P = window.__perf; P.keys = []; P.ev = []; P.trackKeys = true; P.trackEv = true; });
    const t0 = await now(page);
    await page.keyboard.type("the quick brown fox jumps over the lazy dog 0123456789", { delay: 80 });
    await page.waitForTimeout(500);
    const p = await P(page); await page.evaluate(() => { window.__perf.trackKeys = false; window.__perf.trackEv = false; });
    const kd = p.ev.filter((e) => e.n === "keydown" || e.n === "keypress" || e.n === "input" || e.n === "beforeinput").map((e) => e.d);
    R.typing5k = { n: p.keys.length, keyToFrameMedianMs: Math.round(med(p.keys)), p95Ms: Math.round(q(p.keys, 0.95)), maxMs: Math.round(q(p.keys, 1)), eventTimingOver16: kd.length, eventTimingMaxMs: kd.length ? Math.round(Math.max(...kd)) : 0, lt: ltSince(p.lt, t0) };
  } catch (e) { R.typing5k = { error: String(e).slice(0, 160) }; }

  // 3. whiteboard: open the note, switch to the 白板 tab, drag the pane, drag a card
  try {
    await openViaSearch(page, "效能白板", "效能白板");
    const tab = page.locator("button, [role=tab]", { hasText: /^白板$/ }).filter({ visible: true }).first();
    await tab.waitFor({ timeout: 30000 }); await page.waitForTimeout(1000);
    const t0 = await now(page);
    await tab.click();
    await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length >= 20, null, { timeout: 60000, polling: 20 });
    const tNodes = await now(page);
    await page.waitForTimeout(2500);
    R.whiteboard = { tabToCardsMs: Math.round(tNodes - t0), nodesInDom: await page.locator(".react-flow__node").count(), lt: ltSince((await P(page)).lt, t0) };
    const vp = page.viewportSize();
    R.whiteboard.paneDrag = await dragFps(page, { x: Math.round(vp.width * 0.7), y: Math.round(vp.height * 0.75) }, { x: Math.round(vp.width * 0.35), y: Math.round(vp.height * 0.45) });
    const node = page.locator(".react-flow__node").filter({ visible: true }).first();
    const bb = await node.boundingBox();
    if (bb) { R.whiteboard.cardDrag = await dragFps(page, { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }, { x: bb.x + bb.width / 2 + 220, y: bb.y + bb.height / 2 + 160 }); }
  } catch (e) { R.whiteboard = { ...(R.whiteboard ?? {}), error: String(e).slice(0, 160) }; await page.screenshot({ path: `fail-wb-${TIER}-${DEVICE}-${i}.png` }).catch(() => {}); }

  // 4. 20-page PDF: open, first page canvas, scroll fps
  try {
    await openViaSearch(page, "效能PDF", "效能PDF");
    const t0 = await now(page);
    await page.waitForSelector(".pdf-host .page canvas, .pdfViewer .page canvas", { timeout: 60000 });
    const t1 = await now(page);
    await page.waitForTimeout(1500);
    R.pdf = { openToFirstPageMs: Math.round(t1 - t0) };
    await page.evaluate(() => { window.__perf.frames = []; window.__perf.fps = true; return new Promise((res) => { const sc = document.querySelector(".pdf-host-scroller"); const t0 = performance.now(); const step = () => { sc.scrollTop += 40; if (performance.now() - t0 < 3000) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); }); });
    await page.evaluate(() => { window.__perf.fps = false; });
    const pp = await P(page);
    R.pdf.scroll = { ...fpsStats(pp.frames), canvasesAfter: await page.locator(".pdfViewer .page canvas").count(), scrolledPx: await page.evaluate(() => document.querySelector(".pdf-host-scroller").scrollTop) };
  } catch (e) { R.pdf = { ...(R.pdf ?? {}), error: String(e).slice(0, 160) }; await page.screenshot({ path: `fail-pdf-${TIER}-${DEVICE}-${i}.png` }).catch(() => {}); }

  // 5. history screen opened in-app (更多 → 歷史)
  try {
    const t0 = await now(page);
    if (PHONE) throw new Error("phone: history entry not scripted");
    await page.locator("button.topbar-more-btn").click();
    await page.getByRole("menuitem", { name: "歷史" }).or(page.locator("button", { hasText: /^歷史$/ })).first().click();
    await page.waitForFunction(() => /次修改/.test(document.body.innerText), null, { timeout: 60000, polling: 20 });
    const t1 = await now(page);
    await page.waitForTimeout(1500);
    R.history = { openToListMs: Math.round(t1 - t0), lt: ltSince((await P(page)).lt, t0) };
  } catch (e) { R.history = { error: String(e).slice(0, 160) }; }
  await ctx.close();
  return R;
}
const browser = await chromium.launch();
const out = [];
for (let i = 1; i <= RUNS; i++) {
  const t0 = Date.now();
  try { out.push(await oneRun(browser, i)); } catch (e) { out.push({ run: i, error: String(e).slice(0, 300) }); console.log("run failed", e); }
  const r = out[out.length - 1];
  console.log(`[${TIER} ${DEVICE} #${i}] ${Math.round((Date.now() - t0) / 1000)}s expand=${r.expandAll?.msToSettled ?? r.expandAll?.error} type=${r.typing5k?.keyToFrameMedianMs ?? r.typing5k?.error} wb=${r.whiteboard?.tabToCardsMs}/${r.whiteboard?.paneDrag?.avgFps}/${r.whiteboard?.cardDrag?.avgFps}fps${r.whiteboard?.error ? " ERR " + r.whiteboard.error : ""} pdf=${r.pdf?.openToFirstPageMs}/${r.pdf?.scroll?.avgFps}fps${r.pdf?.error ? " ERR " + r.pdf.error : ""} sw=${JSON.stringify(r.switchShort)} hist=${r.history?.openToListMs ?? r.history?.error}`);
  writeFileSync(`results2-${TIER}-${DEVICE}.json`, JSON.stringify(out, null, 1));
}
await browser.close();
