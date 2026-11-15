// 手機／桌面「開啟到能打字」時間軸（本機拋棄式環境專用，不要對正式站跑）。
// usage: BASE=http://localhost:5099 node open-timeline.mjs <tier> <desktop|phone> <runs> [label]
// 每次：全新 context → 冷開（空儲存）→ 等鏡像寫完 → 熱開（有鏡像）→ 離線熱開。
// 寫入 timeline-<label>-<tier>-<device>.json。資料用 ../perf-2026-10-27/ 的 seed 腳本建。
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:5099";
const [TIER = "1k", DEVICE = "phone", RUNS = "3", LABEL = "run"] = process.argv.slice(2);
const PHONE = DEVICE === "phone";
// 冷開關頁後等多久再熱開。0＝馬上重開（關頁時的存檔還在寫，熱開會先遇到「別的分頁存了新快照」）；10000＝隔一會兒再開。
const GAP_MS = Number(process.env.GAP_MS || 0);
const AUTH = { email: "perf-owner@example.com", password: "perf-pass-12345" };
const H = { origin: BASE, "content-type": "application/json" };

const INIT = `(() => {
  const P = window.__perf = { rpc: [], marks: {}, keys: [], lt: [] };
  try { localStorage.setItem("onden.welcomeDismissed", "1"); } catch {}
  const mark = (k) => { if (P.marks[k] === undefined) P.marks[k] = performance.now(); };
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(url, opts) {
      super(url, opts);
      mark("workerCreated");
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
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const check = () => {
    if (document.readyState !== "loading" && !document.getElementById("app-initial-loading")) mark("shell");
    if (document.querySelector(".membership-gate")) { mark("gateUp"); P.gateNow = true; }
    else if (P.gateNow) { mark("gateDown"); P.gateNow = false; }
    const grid = document.querySelector(".workspace-grid");
    const inert = !grid || grid.hasAttribute("inert");
    const dataUp = document.querySelectorAll(".obsidian-page-row").length > 0 || (!!document.querySelector(".mobile-bottom-nav") && /建立了/.test(document.body.innerText));
    if (dataUp) mark("dataShown");
    if (dataUp && !document.querySelector(".membership-gate") && !inert) mark("usable");
    const cm = [...document.querySelectorAll(".cm-content")].find(visible);
    const typable = !!cm && !document.querySelector(".membership-gate") && !inert;
    if (typable) mark("editorTypable");
    // 最後一次進入「可打字」的時間：冷開時閘門可能在第一次可打字之後才升起，所以用最後一次當成穩定可打字。
    if (typable && !P.typableNow) P.marks.typableLast = performance.now();
    P.typableNow = typable;
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
  if (PHONE) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  if (PHONE) await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 9e6 / 8, uploadThroughput: 3e6 / 8 });
  const reqs = new Map();
  let t0;
  cdp.on("Network.requestWillBeSent", (e) => { t0 ??= e.timestamp; reqs.set(e.requestId, { url: e.request.url, start: e.timestamp - t0 }); });
  cdp.on("Network.loadingFinished", (e) => { const r = reqs.get(e.requestId); if (r) r.end = e.timestamp - t0; });
  return { cdp, api: () => [...reqs.values()].filter((r) => r.end !== undefined && /\/api\/(bootstrap|sync|events)/.test(r.url)).map((r) => ({ path: new URL(r.url).pathname + new URL(r.url).search.slice(0, 30), startMs: Math.round(r.start * 1000), endMs: Math.round(r.end * 1000) })) };
}

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
const ltIn = (lt, from, to) => { const xs = lt.filter(([s]) => s >= from && s <= to).map(([, d]) => d); return { n: xs.length, sum: xs.reduce((a, b) => a + b, 0), max: xs.length ? Math.max(...xs) : 0 }; };

async function openOnce(ctx, label, { typeWindowMs = 0 } = {}) {
  const page = await ctx.newPage();
  const ins = await instrument(page);
  const t0 = Date.now();
  await page.goto("/?view=notes");
  // 穩定可打字：進入可打字狀態後 2.5 秒內閘門沒有再升起。
  await page.waitForFunction(() => { const P = window.__perf; return P?.typableNow === true && performance.now() - P.marks.typableLast > 2500; }, null, { timeout: 300_000, polling: 100 });
  const R = { label, wallToUsableMs: Date.now() - t0 };
  // 能不能真的打字：點進編輯器、打一個字，看它出現（按鍵到下一個 frame）。
  let typed = null;
  try {
    const cm = page.locator(".cm-content").filter({ visible: true }).first();
    await cm.waitFor({ timeout: 60_000 });
    await cm.click({ position: { x: 20, y: 10 } });
    await page.evaluate(() => { window.__perf.keys = []; window.__perf.trackKeys = true; });
    const typeStart = await page.evaluate(() => performance.now());
    const n = typeWindowMs ? Math.floor(typeWindowMs / 150) : 3;
    for (let i = 0; i < n; i++) { await page.keyboard.type("a"); await page.waitForTimeout(150); }
    const keys = await page.evaluate(() => { window.__perf.trackKeys = false; return window.__perf.keys; });
    const s = [...keys].sort((a, b) => a - b);
    typed = { n: s.length, medianMs: Math.round(s[s.length >> 1] ?? -1), p95Ms: Math.round(s[Math.floor(s.length * 0.95)] ?? -1), maxMs: Math.round(s[s.length - 1] ?? -1), fromMs: Math.round(typeStart) };
  } catch (e) { typed = { error: String(e).slice(0, 120) }; }
  R.typing = typed;
  const p = await page.evaluate(() => ({ marks: { ...window.__perf.marks }, rpc: [...window.__perf.rpc], lt: [...window.__perf.lt] }));
  R.marks = Object.fromEntries(Object.entries(p.marks).map(([k, v]) => [k, Math.round(v)]));
  const usable = p.marks.typableLast ?? p.marks.editorTypable ?? p.marks.usable;
  const persist = p.rpc.filter((r) => r.op === "persistBootstrap");
  R.persistBootstrap = persist.map((r) => ({ startMs: r.start, endMs: r.start + r.ms }));
  R.rpcOver100 = p.rpc.filter((r) => r.ms > 100).map((r) => `${r.op}@${r.start}:${r.ms}`);
  R.rpcAll = p.rpc.filter((r) => r.start < usable + 500).map((r) => `${r.op}@${r.start}+${r.ms}`);
  R.longTasksList = p.lt.filter(([s]) => s < usable + 500).map(([s, d]) => `${s}+${d}`);
  R.longTasksToTypable = ltIn(p.lt, 0, usable);
  R.api = ins.api();
  // 鏡像寫完：IndexedDB 大小連續兩次（3 秒）不變。
  const settleStart = Date.now();
  let last = -1;
  for (let k = 0; k < 60; k++) { await page.waitForTimeout(3000); const sz = await idbSize(page); if (sz > 0 && sz === last) break; last = sz; }
  R.mirrorSettledAfterUsableMs = Date.now() - settleStart + (typeWindowMs || 450);
  R.longTasksTotal = ltIn((await page.evaluate(() => window.__perf.lt)), 0, 1e9);
  await page.close();
  return R;
}

const browser = await chromium.launch();
const out = [];
for (let i = 1; i <= Number(RUNS); i++) {
  const ctx = await browser.newContext({
    baseURL: BASE, locale: "zh-TW", serviceWorkers: "allow",
    ...(PHONE ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } }),
  });
  await ctx.addInitScript(INIT);
  const s = await ctx.request.post("/api/auth/sign-in/email", { data: AUTH, headers: H });
  if (!s.ok()) throw new Error("signin " + s.status());
  const R = { tier: TIER, device: DEVICE, run: i };
  try {
    R.cold = await openOnce(ctx, "cold", { typeWindowMs: 6000 });
    await new Promise((r) => setTimeout(r, GAP_MS));
    R.warm = await openOnce(ctx, "warm", { typeWindowMs: 3000 });
    await ctx.setOffline(true);
    R.offline = await openOnce(ctx, "offline");
  } catch (e) { R.error = String(e).slice(0, 300); }
  await ctx.close();
  out.push(R);
  const f = (x) => x ? `typable=${x.marks?.typableLast ?? x.marks?.usable} gate=${x.marks?.gateUp ?? "-"}→${x.marks?.gateDown ?? "-"} keyMed=${x.typing?.medianMs}/${x.typing?.p95Ms}/${x.typing?.maxMs} settled+${x.mirrorSettledAfterUsableMs}` : "-";
  console.log(`[${TIER} ${DEVICE} #${i}] cold ${f(R.cold)} | warm ${f(R.warm)} | offline ${f(R.offline)}${R.error ? " ERR " + R.error : ""}`);
  writeFileSync(`timeline-${LABEL}-${TIER}-${DEVICE}.json`, JSON.stringify(out, null, 1));
}
await browser.close();
