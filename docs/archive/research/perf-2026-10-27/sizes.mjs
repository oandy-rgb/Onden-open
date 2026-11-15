// Build output sizes: biggest JS chunks (raw / gzip) and the local DB worker.
// usage: node sizes.mjs [assetsDir]   (default packages/frontend/dist/client/_astro; build first)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
const dir = process.argv[2] || new URL("../../../packages/frontend/dist/client/_astro", import.meta.url).pathname;
const rows = readdirSync(dir).filter((f) => /\.m?js$/.test(f)).map((f) => { const b = readFileSync(join(dir, f)); return { f, raw: b.length, gz: gzipSync(b, { level: 6 }).length }; }).sort((a, b) => b.raw - a.raw);
const kb = (n) => (n / 1024).toFixed(0);
console.log(`${rows.length} js files, total ${kb(rows.reduce((s, r) => s + r.raw, 0))} KB raw / ${kb(rows.reduce((s, r) => s + r.gz, 0))} KB gz`);
for (const r of rows.slice(0, 15)) console.log(`${kb(r.raw).padStart(6)} KB raw ${kb(r.gz).padStart(5)} KB gz  ${r.f}`);
for (const r of rows.filter((r) => /Worker|sql|wasm/i.test(r.f))) console.log(`worker/sql: ${kb(r.raw)} KB raw ${kb(r.gz)} KB gz ${r.f}`);
for (const f of readdirSync(dir).filter((f) => /\.wasm$/.test(f))) console.log(`wasm ${f}: ${kb(statSync(join(dir, f)).size)} KB raw ${kb(gzipSync(readFileSync(join(dir, f))).length)} KB gz`);
