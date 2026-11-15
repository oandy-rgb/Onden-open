// Run inside the backend container: throwaway variant of snippetPlainText that
// collects characters in an array (same output), to see if the slowdown goes away.
import { readFileSync, writeFileSync } from "node:fs";
let src = readFileSync("/app/packages/markdown/dist/snippet.js", "utf8");
const start = src.indexOf("export function snippetPlainText");
const end = src.indexOf("\n}\n", start) + 3;
let fn = src.slice(start, end);
fn = fn.replace('let out = "";', 'const parts = []; let outLen = 0;')
  .replaceAll("out.length > 0", "outLen > 0")
  .replace('out += " ";', 'parts.push(" "); outLen++;')
  .replace("out += ch;", "parts.push(ch); outLen++;")
  .replace("return out;", 'return parts.join("");');
src = src.slice(0, start) + fn + src.slice(end);
writeFileSync("/app/packages/markdown/dist/snippet-fixtest.js", src);
const pg = (await import("/app/node_modules/pg/lib/index.js")).default;
const orig = await import("/app/packages/markdown/dist/snippet.js");
const fixed = await import("/app/packages/markdown/dist/snippet-fixtest.js");
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const r = await c.query(`SELECT n.markdown AS b FROM content_nodes n WHERE (n.title &@~ $1 OR n.markdown &@~ $1) AND n.deleted_at IS NULL ORDER BY pgroonga_score(tableoid, ctid) DESC LIMIT 50`, ["演算法 期中"]);
let same = true;
for (const row of r.rows) if (orig.snippetPlainText(row.b) !== fixed.snippetPlainText(row.b)) same = false;
console.log("same output:", same);
for (let round = 1; round <= 5; round++) {
  const t = performance.now();
  for (const row of r.rows) fixed.snippetAround(row.b, ["期中", "演算法"]);
  console.log("array variant round", round, Math.round(performance.now() - t), "ms");
}
await c.end();
