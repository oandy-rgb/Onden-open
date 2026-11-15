// Attribute a minified chunk's bytes to source files/packages via its sourcemap.
// usage: node mapsize.cjs <chunk.js> [topN] [--files]
const fs = require("fs");
const { SourceMapConsumer } = require("source-map-js");
const [file, topArg, flag] = process.argv.slice(2);
const code = fs.readFileSync(file, "utf8");
const map = JSON.parse(fs.readFileSync(file + ".map", "utf8"));
const smc = new SourceMapConsumer(map);
const lines = code.split("\n");
const lineStart = []; let acc = 0; for (const l of lines) { lineStart.push(acc); acc += Buffer.byteLength(l) + 1; }
const maps = [];
smc.eachMapping((m) => maps.push(m), null, SourceMapConsumer.GENERATED_ORDER);
const bySrc = new Map();
for (let i = 0; i < maps.length; i++) {
  const m = maps[i], n = maps[i + 1];
  const line = lines[m.generatedLine - 1] ?? "";
  const endCol = n && n.generatedLine === m.generatedLine ? n.generatedColumn : line.length;
  const bytes = Buffer.byteLength(line.slice(m.generatedColumn, endCol));
  const src = m.source || "(none)";
  bySrc.set(src, (bySrc.get(src) ?? 0) + bytes);
}
function group(src) {
  const nm = src.lastIndexOf("node_modules/");
  if (nm >= 0) { const rest = src.slice(nm + 13).split("/"); return "npm:" + (rest[0].startsWith("@") ? rest[0] + "/" + rest[1] : rest[0]); }
  const i = src.indexOf("/src/"); if (i >= 0) { const parts = src.slice(i + 5).split("/"); return (src.includes("markdown/src") ? "markdown:" : "frontend:") + parts.slice(0, parts.length > 1 ? 2 : 1).join("/"); }
  return src;
}
const agg = new Map();
for (const [s, b] of bySrc) { const g = flag === "--files" ? s.replace(/^.*?(node_modules|src)\//, "$1/") : group(s); agg.set(g, (agg.get(g) ?? 0) + b); }
const total = [...agg.values()].reduce((a, b) => a + b, 0);
console.log(`${file.split("/").pop()}: ${(fs.statSync(file).size / 1024).toFixed(0)} KB, attributed ${(total / 1024).toFixed(0)} KB`);
for (const [g, b] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, Number(topArg || 30))) console.log(`${(b / 1024).toFixed(1).padStart(7)} KB  ${g}`);
