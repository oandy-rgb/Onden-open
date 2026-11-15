// Server time of the History feed and of creating/renaming a note, against the current workspace size (no browser).
// usage: [DUMP=feed.json] BASE=http://localhost:5099 node feed-timing.mjs <tier> [runs=5]   (DUMP: write the last response, to compare two builds)
const BASE = process.env.BASE || "http://localhost:5099"; const TIER = process.argv[2] || "?"; const N = Number(process.argv[3] || 5);
const H = { origin: BASE, "content-type": "application/json" };
const s = await fetch(BASE + "/api/auth/sign-in/email", { method: "POST", headers: H, body: JSON.stringify({ email: "perf-owner@example.com", password: "perf-pass-12345" }) });
const cookie = s.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const ms = [], sizes = [];
let days, lastText;
for (let i = 0; i < N; i++) {
  const t = performance.now();
  const r = await fetch(BASE + "/api/history/feed?days=14", { headers: { ...H, cookie } });
  const text = await r.text(); ms.push(performance.now() - t); sizes.push(text.length);
  days = JSON.parse(text).days; lastText = text;
}
if (process.env.DUMP) (await import("node:fs")).writeFileSync(process.env.DUMP, lastText);
console.log(JSON.stringify({ tier: TIER, runs: N, feedMedianMs: Math.round(med(ms)), feedMaxMs: Math.round(Math.max(...ms)), bytes: sizes[0],
  days: days.map((d) => ({ date: d.date, notes: d.notes.length, notes_total: d.notes_total ?? null })) }));
