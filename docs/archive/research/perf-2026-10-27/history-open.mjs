// History screen only (2026-10-30): cold boot, wait for usable + 8 s, then open 更多 → 歷史 and time until the list shows.
// Same boot, login and long-task bookkeeping as measure2.mjs. Desktop only. Local persona stack only; never prod.
// usage: BASE=http://localhost:5099 node history-open.mjs <tier> <runs>
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const BASE = process.env.BASE || "http://localhost:5099";
const TIER = process.argv[2] || "5k", RUNS = Number(process.argv[3] || 5);
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


async function oneRun(browser, i) {
  const R = { tier: TIER, run: i };
  const ctx = await browser.newContext({ baseURL: BASE, locale: "zh-TW", serviceWorkers: "allow", viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(INIT);
  const s = await ctx.request.post("/api/auth/sign-in/email", { data: AUTH, headers: { origin: BASE, "content-type": "application/json" } });
  if (!s.ok()) throw new Error("signin " + s.status());
  const page = await ctx.newPage();
  await page.goto("/?view=notes");
  await page.waitForFunction(() => window.__perf?.usable !== undefined, null, { timeout: 300_000, polling: 100 });
  await page.waitForTimeout(8000);
  try {
    let feedMs = null, feedBytes = null;
    page.on("response", async (r) => { if (r.url().includes("/api/history/feed")) { feedBytes = (await r.body().catch(() => Buffer.alloc(0))).length; } });
    const t0 = await now(page);
    await page.locator("button.topbar-more-btn").click();
    await page.getByRole("menuitem", { name: "歷史" }).or(page.locator("button", { hasText: /^歷史$/ })).first().click();
    await page.waitForFunction(() => /次修改/.test(document.body.innerText), null, { timeout: 120000, polling: 20 });
    const t1 = await now(page);
    await page.waitForTimeout(1500);
    R.history = { openToListMs: Math.round(t1 - t0), feedBytes, noteRows: await page.locator(".wh-notes [data-row]").count(), lt: ltSince((await P(page)).lt, t0) };
  } catch (e) { R.history = { error: String(e).slice(0, 160) }; }
  await ctx.close();
  return R;
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const all = [];
for (let i = 0; i < RUNS; i++) { const r = await oneRun(browser, i); all.push(r); console.log(`[${TIER} #${i}] hist=${r.history?.openToListMs ?? r.history?.error} rows=${r.history?.noteRows} bytes=${r.history?.feedBytes} lt=${JSON.stringify(r.history?.lt)}`); }
await browser.close();
console.log(JSON.stringify({ tier: TIER, runs: RUNS, openToListMedianMs: med(all.map((r) => r.history?.openToListMs)), feedBytes: all[0]?.history?.feedBytes, noteRows: all[0]?.history?.noteRows, longTaskSumMedianMs: med(all.map((r) => r.history?.lt?.sum)) }));
writeFileSync(`history-open-${TIER}-${Date.now()}.json`, JSON.stringify(all, null, 1));
