// Aggregate "[http] METHOD path status ms" lines: per normalized route count, median, p95, max.
import { readFileSync } from "node:fs";
const f = process.argv[2];
const by = new Map();
for (const line of readFileSync(f, "utf8").split("\n")) {
  const m = line.match(/^\[http\] (\w+) (\S+) (\d+) (\d+)ms/);
  if (!m) continue;
  const [, method, path, , ms] = m;
  if (path === "/api/health") continue;
  const norm = path.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").replace(/\/\d+(?=\/|$)/g, "/:n");
  const k = `${method} ${norm}`;
  if (!by.has(k)) by.set(k, []);
  by.get(k).push(Number(ms));
}
const rows = [...by].map(([k, xs]) => { xs.sort((a, b) => a - b); return { k, n: xs.length, p50: xs[xs.length >> 1], p95: xs[Math.floor(xs.length * 0.95)], max: xs[xs.length - 1] }; });
rows.sort((a, b) => b.p95 - a.p95);
for (const r of rows.slice(0, Number(process.argv[3] || 20))) console.log(`| ${r.k} | ${r.n} | ${r.p50} | ${r.p95} | ${r.max} |`);
