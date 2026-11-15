// Run inside the backend container: same rows as the search, read through node-postgres.
import pg from "/app/node_modules/pg/lib/index.js";
import { snippetAround, snippetPlainText } from "/app/packages/markdown/dist/snippet.js";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = "演算法 期中";
for (let round = 1; round <= 4; round++) {
  const r = await c.query(`SELECT n.id, n.title, n.markdown AS snippet_body, pgroonga_query_extract_keywords($1) AS snippet_terms
    FROM content_nodes n WHERE (n.title &@~ $1 OR n.markdown &@~ $1) AND n.deleted_at IS NULL
    ORDER BY pgroonga_score(tableoid, ctid) DESC LIMIT 50`, [q]);
  let t = performance.now();
  for (const row of r.rows) snippetPlainText(row.snippet_body);
  const plain = performance.now() - t;
  t = performance.now();
  for (const row of r.rows) snippetAround(row.snippet_body, row.snippet_terms);
  console.log("round", round, "rows", r.rows.length, "plainText", Math.round(plain), "ms; snippetAround", Math.round(performance.now() - t), "ms");
}
await c.end();
