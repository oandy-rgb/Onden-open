// What the built app page (dist/client/index.html) loads before any import():
// its stylesheets/scripts, the island's component-url/renderer-url, and the
// static import closure of those modules. Prints raw + gzip per file and a
// total. Usage: node scripts/login-page-weight.mjs [--json]
// (docs/archive/research/perf-logged-in-2026-10-21.md, section A.)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const DIST = join(fileURLToPath(new URL("..", import.meta.url)), "dist/client");
const html = readFileSync(join(DIST, "index.html"), "utf8");
const seen = new Map();

const sizes = (file) => {
  const buf = readFileSync(join(DIST, file));
  return { raw: buf.length, gzip: gzipSync(buf).length };
};
const visit = (file) => {
  if (seen.has(file)) return;
  const src = readFileSync(join(DIST, file), "utf8");
  seen.set(file, { ...sizes(file), kind: "js" });
  // static `import ... from "./x.js"` and `import "./x.js"`; dynamic import() is not followed
  for (const m of src.matchAll(/(?:\bimport|\bexport)\s*(?:[^'"()]*?\bfrom\s*)?["'](\.[^"']+\.js)["']/g)) {
    visit(join(file, "..", m[1]).replace(/\\/g, "/"));
  }
};
for (const m of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)) seen.set(m[1].slice(1), { ...sizes(m[1].slice(1)), kind: "css" });
for (const m of html.matchAll(/(?:component-url|renderer-url|src)="(\/_astro\/[^"]+\.js)"/g)) visit(m[1].slice(1));
for (const m of html.matchAll(/import\(["'](\/_astro\/[^"']+\.js)["']\)/g)) void m; // dynamic: not counted

const rows = [...seen].map(([file, s]) => ({ file, ...s }));
const total = (kind) => rows.filter((r) => r.kind === kind).reduce((a, r) => ({ raw: a.raw + r.raw, gzip: a.gzip + r.gzip }), { raw: 0, gzip: 0 });
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ rows, js: total("js"), css: total("css") }, null, 2));
} else {
  const kb = (n) => (n / 1024).toFixed(1).padStart(8) + " KB";
  for (const r of rows.sort((a, b) => b.gzip - a.gzip)) console.log(`${r.kind.padEnd(3)} ${kb(r.raw)} raw ${kb(r.gzip)} gzip  ${r.file}`);
  for (const k of ["js", "css"]) console.log(`TOTAL ${k.toUpperCase().padEnd(3)} ${kb(total(k).raw)} raw ${kb(total(k).gzip)} gzip`);
}
