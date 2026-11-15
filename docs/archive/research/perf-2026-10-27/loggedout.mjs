// Logged-out page loads (fresh context): FCP/LCP, requests and bytes by type, JS chunk list.
// usage: node loggedout.mjs <path> <desktop|phone> [runs]
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:5099";
const [path = "/", device = "phone", runs = "5"] = process.argv.slice(2);
const PHONE = device === "phone";
const NET = PHONE ? { offline: false, latency: 150, downloadThroughput: 9e6 / 8, uploadThroughput: 3e6 / 8 } : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
const browser = await chromium.launch();
const out = [];
for (let i = 0; i < Number(runs); i++) {
  const ctx = await browser.newContext({ baseURL: BASE, serviceWorkers: "block", ...(PHONE ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : { viewport: { width: 1440, height: 900 } }) });
  await ctx.addInitScript(() => { window.__lcp = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  if (PHONE) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", NET);
  const reqs = new Map();
  cdp.on("Network.requestWillBeSent", (e) => reqs.set(e.requestId, { url: e.request.url, t0: e.timestamp }));
  cdp.on("Network.loadingFinished", (e) => { const r = reqs.get(e.requestId); if (r) { r.enc = e.encodedDataLength; r.t1 = e.timestamp; } });
  await page.goto(path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => ({ fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime, lcp: window.__lcp, ttfb: performance.getEntriesByType("navigation")[0].responseStart, load: performance.getEntriesByType("navigation")[0].loadEventEnd }));
  const by = { js: 0, css: 0, font: 0, other: 0 }; const js = [];
  for (const r of reqs.values()) {
    if (r.enc === undefined) continue;
    const p = new URL(r.url).pathname;
    const k = /\.m?js$/.test(p) ? "js" : p.endsWith(".css") ? "css" : /\.woff2?$/.test(p) ? "font" : "other";
    by[k] += r.enc; if (k === "js") js.push([p.split("/").pop(), Math.round(r.enc / 1024)]);
  }
  out.push({ ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v)])), requests: [...reqs.values()].filter((r) => r.enc !== undefined).length, kb: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Math.round(v / 1024)])), js });
  await ctx.close();
}
await browser.close();
const med = (k) => { const s = out.map((o) => o[k]).sort((a, b) => a - b); return s[s.length >> 1]; };
console.log(JSON.stringify({ path, device, fcp: med("fcp"), lcp: med("lcp"), ttfb: med("ttfb"), load: med("load"), requests: out[0].requests, kb: out[0].kb, js: out[0].js.sort((a, b) => b[1] - a[1]).slice(0, 12) }));
