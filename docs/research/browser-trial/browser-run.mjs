// 在 headless Chromium 的 module worker 裡跑 dist/browser/worker.js，量冷啟動、遷移、情境、記憶體。
// 用法：node build-browser.mjs --shims --write && node browser-run.mjs
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { createRequire } from "node:module";
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "dist/browser");
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const types = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html" };
const server = http.createServer((req, res) => {
  const name = basename(new URL(req.url, "http://x").pathname) || "index.html";
  if (name === "index.html") { res.setHeader("content-type", "text/html"); return res.end(`<!doctype html><meta charset=utf-8><title>trial</title>`); }
  const f = resolve(dist, name);
  if (!existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader("content-type", types[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream");
  res.end(readFileSync(f));
}).listen(0);
const port = server.address().port;
const sizes = Object.fromEntries(["worker.js", "pglite.wasm", "pglite.data", "initdb.wasm", "pgcrypto.tar.gz", "pg_trgm.tar.gz", "vector.tar.gz"].map((f) => {
  const b = readFileSync(resolve(dist, f));
  return [f, { rawKiB: Math.round(b.length / 1024), gzipKiB: Math.round(gzipSync(b, { level: 9 }).length / 1024), brotliKiB: Math.round(brotliCompressSync(b).length / 1024) }];
}));
console.log("資產大小（KiB）", JSON.stringify(sizes, null, 1));
const browser = await chromium.launch({ args: ["--enable-precise-memory-info"] });
const page = await browser.newPage();
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
await page.goto(`http://localhost:${port}/index.html`);
async function runWorker(dirParam, relaxed) {
  const t0 = Date.now();
  const out = await page.evaluate((url) => new Promise((ok) => {
    const w = new Worker(url, { type: "module" });
    w.onmessage = (e) => { ok(e.data); w.terminate(); };
    w.onerror = (e) => ok({ ok: false, error: "worker error: " + e.message });
  }), `http://localhost:${port}/worker.js` + (dirParam ? `?dir=${encodeURIComponent(dirParam)}&relaxed=${relaxed ? 1 : 0}` : ""));
  return { out, total: Date.now() - t0 };
}
const rssMB = () => Math.round(Number(execSync("ps -eo rss,comm | grep -i chrom | awk '{s+=$1} END {print s}'").toString().trim()) / 1024);
const mode = process.argv[2] ?? "memory";
const relaxed = process.argv[3] === "relaxed";
const uniq = `t${Date.now()}`;
const dirs = { memory: [null], idb: [`idb://${uniq}`, `idb://${uniq}`], opfs: [`opfs-ahp://${uniq}`, `opfs-ahp://${uniq}`] }[mode];
for (const d of dirs) {
  const { out, total } = await runWorker(d, relaxed);
  if (!out.ok) { console.log(mode, d, "FAILED:", out.error); continue; }
  console.log(JSON.stringify({ mode, relaxed, dataDir: d, workerWallMs: total, bootMs: out.bootMs, migrationsMs: out.migrationsMs, migrationsApplied: out.applied, parallel20Ms: out.parallel.ms, queueMaxDepth: out.stats.maxQueueDepth, lockWaitMs: Math.round(out.stats.lockWaitMs), dumpGzipKiB: out.dumpKiB, dumpMs: out.dumpMs, syncMs: out.syncMs, notesInDb: out.notes, chromiumTotalRssMB: rssMB() }));
}
await browser.close(); server.close();
