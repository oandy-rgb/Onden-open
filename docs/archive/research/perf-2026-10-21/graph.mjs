// Static-import closure of built chunks (dynamic import() excluded), with raw and gzip sizes.
// usage: node graph.mjs <assetsDir> <entry.js> [entry2.js ...]
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, basename } from "node:path";
const [dir, ...entries] = process.argv.slice(2);
const seen = new Set();
const dyn = new Set();
function visit(f) {
  if (seen.has(f)) return;
  seen.add(f);
  const src = readFileSync(join(dir, f), "utf8");
  // static: import{..}from"./x.js" | import"./x.js" | export{..}from"./x.js"
  for (const m of src.matchAll(/(?:import|export)\s*(?:[\w*{}\s,$]*?from\s*)?["']\.\/([^"']+\.js)["']/g)) visit(m[1]);
  for (const m of src.matchAll(/import\(\s*["']\.\/([^"']+\.js)["']\s*\)/g)) dyn.add(m[1]);
  // vite's preload helper lists deps as strings "_astro/x.js" or "./x.js" in __vite__mapDeps
}
for (const e of entries) visit(basename(e));
let raw = 0, gz = 0;
const rows = [];
for (const f of seen) { const b = readFileSync(join(dir, f)); const g = gzipSync(b, { level: 6 }).length; raw += b.length; gz += g; rows.push([f, b.length, g]); }
rows.sort((a, b) => b[1] - a[1]);
for (const [f, r, g] of rows) console.log(`${(r / 1024).toFixed(0).padStart(6)} KB raw ${(g / 1024).toFixed(0).padStart(5)} KB gz  ${f}`);
console.log(`TOTAL ${seen.size} files, ${(raw / 1024).toFixed(0)} KB raw, ${(gz / 1024).toFixed(0)} KB gz`);
const dynOnly = [...dyn].filter((f) => !seen.has(f));
console.log(`dynamic-only imports reachable from these chunks: ${dynOnly.length}`);
