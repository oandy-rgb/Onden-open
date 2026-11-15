// Search latency + how long the backend event loop is blocked while a search runs.
// A ping to /api/health every 20 ms measures loop stall: its max latency and the total time pings were >100 ms late.
// usage: BASE=http://localhost:5099 node eventloop.mjs <tier> [rounds=7]   (run right after a backend restart for a fair series)
import { writeFileSync } from "node:fs";
const BASE = process.env.BASE || "http://localhost:5099";
const TIER = process.argv[2] || "5k", ROUNDS = Number(process.argv[3] || 7);
const H = { origin: BASE, "content-type": "application/json" };
const s = await fetch(BASE + "/api/auth/sign-in/email", { method: "POST", headers: H, body: JSON.stringify({ email: "perf-owner@example.com", password: "perf-pass-12345" }) });
const cookie = s.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const get = (p) => fetch(BASE + p, { headers: { ...H, cookie } });
const out = [];
for (const [label, q] of [["title", "筆記 777"], ["common", "演算法 期中"], ["rare", "夸克螺旋"]]) {
  for (let r = 0; r < ROUNDS; r++) {
    let stop = false, max = 0, stall = 0; const pings = [];
    const pinger = (async () => { while (!stop) { const t = performance.now(); await get("/api/health").then((x) => x.text()).catch(() => {}); const d = performance.now() - t; pings.push(d); max = Math.max(max, d); if (d > 100) stall += d; await new Promise((r) => setTimeout(r, 20)); } })();
    const t0 = performance.now();
    const res = await get("/api/nodes/search?q=" + encodeURIComponent(q)); const body = await res.json();
    const ms = Math.round(performance.now() - t0); stop = true; await pinger;
    out.push({ label, q, round: r + 1, status: res.status, results: Array.isArray(body) ? body.length : -1, searchMs: ms, pingMaxMs: Math.round(max), stallMs: Math.round(stall) });
    console.log(JSON.stringify(out[out.length - 1]));
  }
}
writeFileSync(`eventloop-${TIER}.json`, JSON.stringify(out, null, 1));
