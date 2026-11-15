// Latency of creating one note (POST /api/nodes) and renaming it (PATCH title) against the current workspace size.
// usage: BASE=http://localhost:5099 node create-latency.mjs <tier> [n=10]
const BASE = process.env.BASE || "http://localhost:5099"; const TIER = process.argv[2] || "?"; const N = Number(process.argv[3] || 10);
const H = { origin: BASE, "content-type": "application/json" };
const s = await fetch(BASE + "/api/auth/sign-in/email", { method: "POST", headers: H, body: JSON.stringify({ email: "perf-owner@example.com", password: "perf-pass-12345" }) });
const cookie = s.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const create = [], rename = [];
for (let i = 0; i < N; i++) {
  let t = performance.now();
  const r = await fetch(BASE + "/api/nodes", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ title: `延遲測試 ${Date.now()}-${i}`, markdown: "短內容 [[筆記 10]]" }) });
  create.push(performance.now() - t); const n = await r.json();
  t = performance.now();
  await fetch(BASE + `/api/nodes/${n.id}`, { method: "PATCH", headers: { ...H, cookie }, body: JSON.stringify({ title: `延遲改名 ${Date.now()}-${i}` }) });
  rename.push(performance.now() - t);
}
console.log(JSON.stringify({ tier: TIER, n: N, createMedianMs: Math.round(med(create)), createMaxMs: Math.round(Math.max(...create)), renameMedianMs: Math.round(med(rename)), renameMaxMs: Math.round(Math.max(...rename)) }));
