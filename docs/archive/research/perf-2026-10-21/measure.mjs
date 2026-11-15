// Logged-in perf harness for Onden (local throwaway stack only, never prod).
// usage: BASE=http://localhost:5095 node measure.mjs <tier> <desktop|phone> <runs>
// Writes results-<tier>-<device>.json (one object per run).
// Based on the 2026-10-19 mobile harness (measure.mjs in that session's scratchpad).
import { chromium, request as pwRequest } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:5095";
const TIER = process.argv[2] || "5k";
const DEVICE = process.argv[3] || "phone";
const RUNS = Number(process.argv[4] || 5);
const PHONE = DEVICE === "phone";
const CPU = PHONE ? 4 : 1;
// "Realistic 4G": 150 ms RTT, 9 Mbps down, 3 Mbps up (CDP wants bytes/s).
const NET = PHONE
  ? { offline: false, latency: 150, downloadThroughput: 9e6 / 8, uploadThroughput: 3e6 / 8 }
  : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
const AUTH = { email: "perf-owner@example.com", password: "perf-pass-12345" };
const H = { origin: BASE, "content-type": "application/json" };

const INIT = `(() => {
  const P = window.__perf = { rpc: [], marks: {}, keys: [], lt: [] };
  try { localStorage.setItem("onden.welcomeDismissed", "1"); } catch {}
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(url, opts) {
      super(url, opts);
      P.marks.workerCreated ??= performance.now();
      const sent = new Map();
      const post = this.postMessage.bind(this);
      this.postMessage = (msg, ...rest) => { if (msg && msg.op) sent.set(msg.id, { op: msg.op, t: performance.now() }); return post(msg, ...rest); };
      this.addEventListener("message", (ev) => {
        const s = ev.data && sent.get(ev.data.id);
        if (s) { sent.delete(ev.data.id); P.rpc.push({ op: s.op, start: Math.round(s.t), ms: Math.round(performance.now() - s.t) }); }
      });
    }
  };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true }); } catch {}
  const check = () => {
    const now = performance.now();
    if (P.marks.shell === undefined && document.readyState !== "loading" && !document.getElementById("app-initial-loading")) P.marks.shell = now;
    const rows = document.querySelectorAll(".obsidian-page-row");
    if (rows.length && P.marks.firstRow === undefined) P.marks.firstRow = now;
    const gate = document.querySelector(".membership-gate");
    if (gate && P.marks.gateUp === undefined) P.marks.gateUp = now;
    if (!gate && P.marks.gateUp !== undefined && P.marks.gateDown === undefined) P.marks.gateDown = now;
    const grid = document.querySelector(".workspace-grid");
    const usable = rows.length > 0 && !gate && grid && !grid.hasAttribute("inert");
    if (usable && P.marks.usable === undefined) { P.marks.usable = now; P.marks.rowsAtUsable = rows.length; }
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["inert", "class"] });
  document.addEventListener("keydown", (ev) => {
    if (!P.trackKeys) return;
    const t0 = ev.timeStamp;
    requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => P.keys.push(performance.now() - t0); ch.port2.postMessage(0); });
  }, true);
})();`;

async function instrument(page) {
  const cdp = await page.context().newCDPSession(page);
  if (CPU > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", NET);
  const reqs = new Map();
  cdp.on("Network.requestWillBeSent", (e) => reqs.set(e.requestId, { url: e.request.url, method: e.request.method, t0: e.timestamp, wall: Date.now(), raw: 0 }));
  cdp.on("Network.responseReceived", (e) => { const r = reqs.get(e.requestId); if (r) { r.status = e.response.status; r.cached = e.response.fromDiskCache || e.response.fromServiceWorker; r.tResp = e.timestamp; } });
  cdp.on("Network.dataReceived", (e) => { const r = reqs.get(e.requestId); if (r) r.raw += e.dataLength; });
  cdp.on("Network.loadingFinished", (e) => { const r = reqs.get(e.requestId); if (r) { r.enc = e.encodedDataLength; r.t1 = e.timestamp; r.wallEnd = Date.now(); } });
  return { cdp, reqs };
}
function netSummary(reqs) {
  const out = { requests: 0, kbTotal: 0, kbJs: 0, kbCss: 0, kbApi: 0, api: [] };
  for (const r of reqs.values()) {
    if (r.enc === undefined) continue;
    out.requests++; out.kbTotal += r.enc;
    const u = new URL(r.url); const p = u.pathname;
    if (/\.m?js$/.test(p)) out.kbJs += r.enc; else if (p.endsWith(".css")) out.kbCss += r.enc;
    if (p.startsWith("/api/")) {
      out.kbApi += r.enc;
      out.api.push({ m: r.method, p: p + (u.search.length < 60 ? u.search : u.search.slice(0, 60)), status: r.status, encKB: +(r.enc / 1024).toFixed(1), rawKB: +(r.raw / 1024).toFixed(1), ms: Math.round((r.t1 - r.t0) * 1000), ttfbMs: r.tResp ? Math.round((r.tResp - r.t0) * 1000) : null });
    }
  }
  for (const k of ["kbTotal", "kbJs", "kbCss", "kbApi"]) out[k] = Math.round(out[k] / 1024);
  return out;
}
const perf = (page) => page.evaluate(() => {
  const P = window.__perf;
  return { marks: { ...P.marks }, rpc: [...P.rpc], lt: [...P.lt] };
});
async function heapMb(cdp) { const h = await cdp.send("Runtime.getHeapUsage"); return Math.round(h.usedSize / 1048576); }
async function idbSize(page) {
  return page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open("onden-storage");
    r.onerror = () => res(-1);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("sqlite")) { db.close(); return res(-2); }
      const g = db.transaction("sqlite").objectStore("sqlite").getAll();
      g.onsuccess = () => { db.close(); res(g.result.reduce((s, v) => s + (v?.byteLength ?? v?.size ?? 0), 0)); };
      g.onerror = () => res(-3);
    };
  }));
}
const wait = (page, ms) => page.waitForTimeout(ms);
const ltIn = (lt, from, to) => { const xs = lt.filter(([s]) => s >= from && s <= to).map(([, d]) => d); return { n: xs.length, sum: xs.reduce((a, b) => a + b, 0), max: xs.length ? Math.max(...xs) : 0 }; };
const rpcMs = (rpc, op) => rpc.filter((r) => r.op === op).map((r) => r.ms);

async function boot(page, label) {
  const t0 = Date.now();
  await page.goto("/?view=notes");
  await page.waitForFunction(() => window.__perf?.marks.usable !== undefined, null, { timeout: 300_000, polling: 100 });
  const wall = Date.now() - t0;
  const p = await perf(page);
  return { label, wall, marks: Object.fromEntries(Object.entries(p.marks).map(([k, v]) => [k, Math.round(v)])), ltToUsable: ltIn(p.lt, 0, p.marks.usable), initLocalDb: rpcMs(p.rpc, "initLocalDb"), loadBootstrap: rpcMs(p.rpc, "loadBootstrap") };
}

async function openNote(page, title, want, searchText = title) {
  const back = page.locator(".omt-back").filter({ visible: true });
  if (await back.count()) { await back.first().click(); await page.waitForSelector(".overview-mobile-tabs[data-level=browse]"); }
  if (!(await page.locator(".obsidian-search-input").isVisible())) await page.locator(".sidebar-search-toggle").filter({ visible: true }).first().click();
  await page.locator(".obsidian-search-input").fill(searchText);
  const row = page.locator(".obsidian-search-row .obsidian-page-button").filter({ has: page.locator(".sb-item-title", { hasText: new RegExp(`^${title}$`) }) }).first();
  await row.waitFor({ timeout: 60_000 });
  await wait(page, 1000);
  const start = await page.evaluate(() => performance.now());
  if (PHONE) await row.tap(); else await row.click();
  await page.waitForFunction((w) => {
    const cm = [...document.querySelectorAll(".cm-content")].find((e) => e.getClientRects().length > 0);
    return cm && cm.textContent && cm.textContent.includes(w) && !document.querySelector(".lazy-loading-pane");
  }, want, { timeout: 90_000, polling: 30 });
  const end = await page.evaluate(() => performance.now());
  // Backlink cards (desktop side panel) if they show within 5 s.
  let backlinksMs = null;
  try {
    await page.waitForFunction(() => [...document.querySelectorAll(".backlink-card")].some((e) => e.getClientRects().length > 0), null, { timeout: 5000, polling: 50 });
    backlinksMs = Math.round((await page.evaluate(() => performance.now())) - start);
  } catch {}
  await wait(page, 1500);
  const p = await perf(page);
  if (!PHONE) await page.locator(".obsidian-search-input").fill("").catch(() => {});
  return { ms: Math.round(end - start), backlinksMs, lt: ltIn(p.lt, start, end + 1500) };
}

async function paletteSearch(page, query, expectText) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator(".cm-content").first().blur().catch(() => {});
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press("Control+k");
  const input = page.locator(".palette-input");
  await input.waitFor({ timeout: 5000 });
  await input.fill("");
  await page.evaluate(() => { window.__perf.keys = []; window.__perf.trackKeys = true; });
  await page.keyboard.type(query, { delay: 120 });
  const lastKey = Date.now();
  await page.waitForFunction((w) => [...document.querySelectorAll(".palette-item")].some((r) => r.textContent.includes(w)), expectText, { timeout: 60_000, polling: 20 });
  const ms = Date.now() - lastKey;
  const keys = await page.evaluate(() => { window.__perf.trackKeys = false; return window.__perf.keys; });
  const rows = await page.locator(".palette-item").count();
  await page.keyboard.press("Escape");
  const s = [...keys].sort((a, b) => a - b);
  return { query, lastKeyToResultMs: ms, rows, keyMedianMs: Math.round(s[s.length >> 1] ?? -1), keyMaxMs: Math.round(s[s.length - 1] ?? -1) };
}

async function oneRun(browser, i, ids) {
  const R = { tier: TIER, device: DEVICE, run: i };
  const ctx = await browser.newContext({
    baseURL: BASE, locale: "zh-TW", serviceWorkers: "allow",
    ...(PHONE ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } }),
  });
  await ctx.addInitScript(INIT);
  const s = await ctx.request.post("/api/auth/sign-in/email", { data: AUTH, headers: H });
  if (!s.ok()) throw new Error("signin " + s.status());

  // 1. Cold boot (signed in, empty storage, empty HTTP cache).
  let page = await ctx.newPage();
  let ins = await instrument(page);
  R.cold = await boot(page, "cold");
  R.cold.heapAtUsableMb = await heapMb(ins.cdp);
  const usableWall = Date.now();
  let last = -1, settledAt = Date.now();
  for (let k = 0; k < 40; k++) { await wait(page, 3000); const sz = await idbSize(page); if (sz > 0 && sz === last) break; last = sz; settledAt = Date.now(); }
  const pc = await perf(page);
  // Mirror stopped growing (checked every 3 s): wall ms after "usable".
  R.cold.mirrorSettledAfterUsableMs = settledAt - usableWall;
  R.cold.ltUntilSettled = ltIn(pc.lt, 0, 1e9);
  R.cold.rpcOver50 = pc.rpc.filter((r) => r.ms > 50).map((r) => `${r.op}:${r.ms}`);
  R.cold.net = netSummary(ins.reqs);
  R.cold.heapSettledMb = await heapMb(ins.cdp);
  R.mirrorBytes = await idbSize(page);
  await page.close();

  // 2. Warm boot (mirror + HTTP/SW cache present, fresh page and worker).
  page = await ctx.newPage();
  ins = await instrument(page);
  R.warm = await boot(page, "warm");
  await wait(page, 6000);
  R.warm.net = netSummary(ins.reqs);
  R.warm.heapMb = await heapMb(ins.cdp);
  const pw = await perf(page);
  R.warm.rpcOver50 = pw.rpc.filter((r) => r.ms > 50).map((r) => `${r.op}:${r.ms}`);

  // 3. Note switches (in-app, through the sidebar search).
  R.open = {};
  for (const [key, title, want, st] of [["short", "筆記 42", "第 42 篇合成筆記", "第 42 篇合成筆記"], ["long50k", "效能長筆記", "第 1 節"], ["hub300", "效能樞紐筆記", "很多筆記連到", "很多筆記連到"]]) {
    try { R.open[key] = await openNote(page, title, want, st); } catch (e) { R.open[key] = { error: String(e).slice(0, 200) }; await page.screenshot({ path: `fail-${TIER}-${DEVICE}-${i}-${key}.png` }).catch(() => {}); }
  }

  // 4. Typing in the 50k note + autosave round trip.
  try {
    await openNote(page, "效能長筆記", "第 1 節");
    const cm = page.locator(".cm-content").filter({ visible: true }).first();
    await cm.click({ position: { x: 80, y: 140 } });
    await page.keyboard.press("End");
    ins.reqs.clear();
    await page.evaluate(() => { window.__perf.keys = []; window.__perf.trackKeys = true; });
    const ltStart = await page.evaluate(() => performance.now());
    await page.keyboard.type("the quick brown fox jumps over the lazy dog", { delay: 100 });
    const lastKey = Date.now();
    let save = null;
    for (let k = 0; k < 100 && !save; k++) {
      await wait(page, 100);
      for (const r of ins.reqs.values()) if ((r.method === "PATCH" || r.method === "PUT" || r.method === "POST") && /\/api\/(nodes|sync)/.test(r.url) && r.wallEnd) save = r;
    }
    await wait(page, 1000);
    const keys = await page.evaluate(() => { window.__perf.trackKeys = false; return window.__perf.keys; });
    const pt = await perf(page);
    const ks = [...keys].sort((a, b) => a - b);
    R.typing = { n: ks.length, medianMs: Math.round(ks[ks.length >> 1]), p95Ms: Math.round(ks[Math.floor(ks.length * 0.95)]), maxMs: Math.round(ks[ks.length - 1]), lt: ltIn(pt.lt, ltStart, 1e12) };
    R.autosave = save ? { lastKeyToSentMs: save.wall - lastKey, roundTripMs: Math.round((save.t1 - save.t0) * 1000), lastKeyToSavedMs: save.wallEnd - lastKey, method: save.method, path: new URL(save.url).pathname, reqKB: null } : null;
  } catch (e) { R.typing = { error: String(e).slice(0, 200) }; }

  // 5. Command palette search (server /api/nodes/search).
  R.search = [];
  for (const [q, want] of [[ids.searchTitle, ids.searchTitle], ["演算法 期中", "筆記"]]) {
    try { R.search.push(await paletteSearch(page, q, want)); } catch (e) { R.search.push({ query: q, error: String(e).slice(0, 200) }); }
  }

  // 6. Sync: a second session edits one note; time until this page applies it.
  try {
    ins.reqs.clear();
    const before = (await perf(page)).rpc.length;
    const other = await pwRequest.newContext({ baseURL: BASE });
    await other.post("/api/auth/sign-in/email", { data: AUTH, headers: H });
    const full = await (await other.get(`/api/nodes/${ids.syncTarget}`)).json();
    const editAt = await page.evaluate(() => performance.now());
    const wEdit = Date.now();
    const r = await other.patch(`/api/nodes/${ids.syncTarget}`, { data: { markdown: full.markdown + `\n\n遠端編輯 ${Date.now()}`, base_markdown: full.markdown }, headers: H });
    const patchMs = Date.now() - wEdit;
    await other.dispose();
    let applied = null;
    for (let k = 0; k < 300 && !applied; k++) {
      await wait(page, 100);
      const rp = (await perf(page)).rpc.slice(before).find((x) => x.op === "applySync" || x.op === "persistRemoteNode");
      if (rp) applied = rp;
    }
    await wait(page, 1000);
    const net = netSummary(ins.reqs);
    R.sync = { patchStatus: r.status(), patchMs, appliedAfterEditMs: applied ? Math.round(applied.start + applied.ms - editAt) : null, applyRpcMs: applied?.ms ?? null, op: applied?.op, api: net.api.filter((a) => a.m === "GET") };
  } catch (e) { R.sync = { error: String(e).slice(0, 200) }; }
  await page.close();

  // 7. Offline warm start (service worker serves the shell; data from the mirror).
  try {
    await ctx.setOffline(true);
    page = await ctx.newPage();
    const c2 = await ctx.newCDPSession(page);
    if (CPU > 1) await c2.send("Emulation.setCPUThrottlingRate", { rate: CPU });
    R.offline = await boot(page, "offline");
    await page.close();
  } catch (e) { R.offline = { error: String(e).slice(0, 200) }; }
  await ctx.setOffline(false);
  await ctx.close();
  return R;
}

async function main() {
  const browser = await chromium.launch();
  // ids for this tier
  const api = await pwRequest.newContext({ baseURL: BASE });
  await api.post("/api/auth/sign-in/email", { data: AUTH, headers: H });
  const slim = await (await api.get("/api/bootstrap?bodies=none")).json();
  const notes = slim.nodes.filter((n) => n.node_type === "content");
  const nums = notes.map((n) => n.title.match(/^筆記 (\d+)$/)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  const pick = nums[Math.floor(nums.length * 0.77)];
  const ids = { searchTitle: `筆記 ${pick}`, syncTarget: notes.find((n) => n.title === "筆記 100").id };
  await api.dispose();
  const out = [];
  for (let i = 1; i <= RUNS; i++) {
    const t0 = Date.now();
    try { out.push(await oneRun(browser, i, ids)); } catch (e) { out.push({ run: i, error: String(e).slice(0, 300) }); console.log("run failed", e); }
    const r = out[out.length - 1];
    console.log(`[${TIER} ${DEVICE} run ${i}] ${Math.round((Date.now() - t0) / 1000)}s cold.usable=${r.cold?.marks?.usable} warm.usable=${r.warm?.marks?.usable} offline.usable=${r.offline?.marks?.usable} open=${JSON.stringify(Object.fromEntries(Object.entries(r.open ?? {}).map(([k, v]) => [k, v.ms ?? v.error?.slice(0, 40)])))} typing=${r.typing?.medianMs} search=${(r.search ?? []).map((s) => s.lastKeyToResultMs).join("/")} sync=${r.sync?.appliedAfterEditMs} mirrorKB=${Math.round((r.mirrorBytes ?? 0) / 1024)}`);
    writeFileSync(`results-${TIER}-${DEVICE}.json`, JSON.stringify(out, null, 1));
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
