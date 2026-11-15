// 搜尋實驗：1 萬篇筆記，比較（A）PGlite 上「已改好」的後端函式版（plpgsql，等同現在原型）、（B）ILIKE 無索引、（C）ILIKE＋GIN pg_trgm、（D）前端既有的離線搜尋（sql.js FTS5 trigram）。
// 並驗證 pgvector 在 PGlite 可用。用法：node search-bench.mjs [篇數，預設 10000]
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/home/user/Onden/package.json");
const N = Number(process.argv[2] ?? 10000);

// ── 語料（固定種子，可重現）──
let seed = 42; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const chars = Array.from("的一是不了人我在有他這中大來上國個到說們為子和你地出道也時年得就那要下以生會自著去之過家學對可她裡後小麼心多天而能好都然沒日於起還發成事只作當想看文無開手十用主行方又如前所本見經頭面公同三已老從動兩長知民樣現分將外但身些與高意進把法此實回二理美點月明其種聲全工己話兒者向情部正名定女問力機給等幾很業最間新什打便位因重被走電四第門相次東政海口使教加少並吃連相直資料結構演算法作業系統編譯器網路安全機率統計微積分線性代數程式設計計算組織記憶體管理行程排程死結搜尋樹平衡");
const zipf = () => chars[Math.floor(Math.pow(rnd(), 2.2) * chars.length)];
const words = Array.from({ length: 4000 }, () => Array.from({ length: 2 + Math.floor(rnd() * 3) }, zipf).join(""));
const eng = ["kafka", "deadlock", "index", "cache", "docker", "redis", "transformer", "bayes"];
const needles = { "死結": 40, "搜尋樹": 25, "記憶體": 300, "排程": 200, "kafka": 30 };
const docs = [];
for (let i = 0; i < N; i++) {
  let body = ""; while (body.length < 600 + rnd() * 400) body += words[Math.floor(Math.pow(rnd(), 1.6) * words.length)] + (rnd() < 0.12 ? "，" : rnd() < 0.05 ? "。" : rnd() < 0.04 ? " " + eng[Math.floor(rnd() * eng.length)] + " " : "");
  docs.push({ title: Array.from({ length: 5 + Math.floor(rnd() * 7) }, zipf).join(""), markdown: body });
}
for (const [term, count] of Object.entries(needles)) for (let k = 0; k < count; k++) { const d = docs[Math.floor(rnd() * N)]; const at = Math.floor(rnd() * d.markdown.length); d.markdown = d.markdown.slice(0, at) + term + d.markdown.slice(at); }
docs[7].title = "死結"; docs[8].title = "死結與預防"; docs[9].title = "關於死結的筆記"; // 排序測試：標題相同／開頭相同／包含
const corpusMB = (docs.reduce((a, d) => a + d.markdown.length + d.title.length, 0) * 3 / 1048576).toFixed(1);
console.log(`語料：${N} 篇，約 ${corpusMB} MB UTF-8`);

const pad = (s, n) => String(s).padEnd(n);
const med = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function time(fn, runs = 5) { const t = []; let r; for (let i = 0; i < runs; i++) { const s = performance.now(); r = await fn(); t.push(performance.now() - s); } return { ms: +med(t).toFixed(1), r }; }

// ── 查詢語法：詞、"片語"、OR、-排除（與 pgroonga 的查詢語法同一套，由左到右）──
function parseDsl(q) {
  const toks = [...q.matchAll(/("[^"]*"|\S+)/g)].map((m) => m[1]);
  const groups = []; let cur = null; let or = false; const neg = [];
  for (const t of toks) {
    if (t.toUpperCase() === "OR") { or = true; continue; }
    if (t.startsWith("-") && t.length > 1) { neg.push(t.slice(1).replace(/"/g, "")); or = false; continue; }
    const term = t.replace(/"/g, "");
    if (or && cur) cur.push(term); else { cur = [term]; groups.push(cur); }
    or = false;
  }
  return { groups, neg };
}
const esc = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);
/** trigramEngine 的草稿：回傳 WHERE 片段、參數、摘要用關鍵字、排序用表達式 */
function trigramQuery(q, startIdx = 1) {
  const { groups, neg } = parseDsl(q); const params = []; const conds = [];
  const p = (v) => (params.push("%" + esc(v) + "%"), `$${startIdx + params.length - 1}`);
  for (const g of groups) conds.push("(" + g.map((t) => { const i = p(t); return `(n.title ILIKE ${i}::text OR n.markdown ILIKE ${i}::text)`; }).join(" OR ") + ")");
  for (const t of neg) { const i = p(t); conds.push(`NOT (n.title ILIKE ${i}::text OR n.markdown ILIKE ${i}::text)`); }
  const terms = groups.flat();
  return { where: conds.join(" AND "), params, terms };
}
const first = (q) => parseDsl(q).groups[0]?.[0] ?? "";

const db = new PGlite({ extensions: { pg_trgm, vector } });
await db.exec("CREATE EXTENSION pg_trgm; CREATE EXTENSION vector;");
await db.exec("CREATE TABLE n (id serial PRIMARY KEY, title text NOT NULL, markdown text NOT NULL)");
let t = performance.now();
for (let i = 0; i < N; i += 500) { const part = docs.slice(i, i + 500); await db.query("INSERT INTO n(title, markdown) SELECT * FROM unnest($1::text[], $2::text[])", [part.map((d) => d.title), part.map((d) => d.markdown)]); }
console.log(`PGlite 寫入 ${N} 篇：${Math.round(performance.now() - t)} ms（無索引）`);
const compat = readFileSync(new URL("./src/pgroongaCompat.sql", import.meta.url), "utf8"); await db.exec(compat);

const queries = ["死結", "搜尋樹", "樹", "死結 OR 排程", "記憶體 -排程", "kafka", '"記憶體 管理"'];
const order = (q) => `(lower(n.title) = lower($${0})) DESC`; // placeholder（下面直接組字串）

async function runIlike(label, q) {
  const { where, params, terms } = trigramQuery(q, 2);
  const text = first(q);
  const occ = terms.map((_, i) => `(length(lower(n.markdown)) - length(replace(lower(n.markdown), lower($${100 + i}), ''))) / greatest(length($${100 + i}), 1)`);
  // 排序：標題相同 > 標題開頭相同 > 標題含詞 > 內文出現次數（pgroonga 的 TF-IDF 另計，未比較）
  const ps = [text, ...params];
  const termParams = terms.map((x) => x);
  const sql = `SELECT n.id, n.title FROM n WHERE ${where}
     ORDER BY (lower(n.title) = lower($1)) DESC, starts_with(lower(n.title), lower($1)) DESC, (n.title ILIKE '%' || $1 || '%') DESC,
              (length(lower(n.markdown)) - length(replace(lower(n.markdown), lower($1), ''))) DESC LIMIT 30`;
  return time(() => db.query(sql, ps));
}
const results = [];
async function section(name, fn) {
  console.log(`\n── ${name}`);
  for (const q of queries) { const { ms, r } = await fn(q); console.log(`${pad(q, 14)} ${String(ms).padStart(8)} ms  命中(上限30) ${r.rows.length}`); results.push({ name, q, ms, hits: r.rows.length }); }
}
await section("B. ILIKE 無索引（循序掃描）", (q) => runIlike("ilike", q));
await section("A. 後端現況原型：plpgsql onden_match（&@~ 相容函式，循序掃描）", (q) => time(() => db.query(`SELECT id, title FROM n WHERE (title &@~ $1 OR markdown &@~ $1) LIMIT 30`, [q])));
t = performance.now();
await db.exec("CREATE INDEX n_title_trgm ON n USING gin (title gin_trgm_ops); CREATE INDEX n_md_trgm ON n USING gin (markdown gin_trgm_ops);");
const idxMs = Math.round(performance.now() - t);
const sizes = (await db.query("SELECT pg_size_pretty(pg_total_relation_size('n')) AS tbl, pg_size_pretty(pg_relation_size('n_title_trgm')) AS ti, pg_size_pretty(pg_relation_size('n_md_trgm')) AS mi")).rows[0];
console.log(`\nGIN pg_trgm 索引建立 ${idxMs} ms；表＋索引 ${sizes.tbl}（title 索引 ${sizes.ti}，內文索引 ${sizes.mi}）`);
await section("C. ILIKE＋GIN pg_trgm", (q) => runIlike("gin", q));
const plan = async (q) => { const { where, params } = trigramQuery(q, 1); return (await db.query(`EXPLAIN SELECT n.id FROM n WHERE ${where}`, [first(q), ...params].slice(1))).rows.map((r) => r["QUERY PLAN"]).filter((l) => /Scan/.test(l)).map((l) => l.trim().slice(0, 70)); };
console.log("\n是否用到索引（EXPLAIN）：");
for (const q of ["死結", "搜尋樹", "樹", "kafka"]) console.log(" ", pad(q, 8), (await plan(q)).join(" | "));

// ── 排序品質（標題相同＞開頭相同＞包含）──
const top = await db.query(`SELECT n.title FROM n WHERE (n.title ILIKE $2 OR n.markdown ILIKE $2) ORDER BY (lower(n.title) = lower($1)) DESC, starts_with(lower(n.title), lower($1)) DESC, (n.title ILIKE '%'||$1||'%') DESC LIMIT 4`, ["死結", "%死結%"]);
console.log("\n排序（查「死結」前 4 筆標題）：", top.rows.map((r) => r.title.slice(0, 12)).join(" ｜ "));

// ── D. 前端既有離線搜尋（sql.js FTS5 trigram，與 packages/frontend/src/lib/localDbWorker.ts 同一種索引）──
const initSqlJs = require("/home/user/Onden/node_modules/sql.js");
const SQL = await initSqlJs();
const sdb = new SQL.Database();
// 實測：sql.js 1.14.1 的標準 wasm 沒有編進 FTS5（"no such module: fts5"）。前端 localDbWorker.ts 建 FTS5 失敗時會退回 LIKE（註解寫「FTS5 unavailable — search falls back to LIKE」），
// 所以離線搜尋實際走的是 LIKE 循序掃描；這裡就量那條路。
sdb.run("CREATE TABLE f (title TEXT, markdown TEXT)");
t = performance.now();
sdb.run("BEGIN"); const ins = sdb.prepare("INSERT INTO f(title, markdown) VALUES (?, ?)"); for (const d of docs) ins.run([d.title, d.markdown]); ins.free(); sdb.run("COMMIT");
console.log(`\nD. sql.js（前端離線搜尋實際路徑：LIKE）：寫入 ${Math.round(performance.now() - t)} ms`);
const sqlFor = (q) => {
  const { groups, neg } = parseDsl(q);
  // ≥3 字的詞用 FTS5 MATCH（trigram 的下限）；<3 字退回 LIKE（前端也是這樣）
  const termSql = (term) => `(title LIKE '%${term}%' OR markdown LIKE '%${term}%')`;
  const g = groups.map((gr) => "(" + gr.map(termSql).join(" OR ") + ")");
  const n = neg.map((term) => `NOT (title LIKE '%${term}%' OR markdown LIKE '%${term}%')`);
  return `SELECT title FROM f WHERE ${[...g, ...n].join(" AND ")} LIMIT 30`;
};
console.log("");
for (const q of queries) { const { ms, r } = await time(() => sdb.exec(sqlFor(q))); const n = r[0]?.values.length ?? 0; console.log(`${pad(q, 14)} ${String(ms).padStart(8)} ms  命中(上限30) ${n}`); results.push({ name: "D. sql.js LIKE", q, ms, hits: n }); }
const sqliteBytes = sdb.export().length;
console.log(`sql.js 匯出檔 ${(sqliteBytes / 1048576).toFixed(1)} MB`);

// ── pgvector ──
await db.exec("CREATE TABLE v (id serial PRIMARY KEY, e vector(384))");
t = performance.now();
const vec = () => "[" + Array.from({ length: 384 }, () => (rnd() - 0.5).toFixed(4)).join(",") + "]";
for (let i = 0; i < N; i += 500) await db.query("INSERT INTO v(e) SELECT unnest($1::text[])::vector", [Array.from({ length: Math.min(500, N - i) }, vec)]).catch(async (e) => { if (i === 0) throw e; });
console.log(`\npgvector：寫入 ${N} 個 384 維向量 ${Math.round(performance.now() - t)} ms`);
const q0 = vec();
const seq = await time(() => db.query("SELECT id FROM v ORDER BY e <=> $1 LIMIT 10", [q0]), 3);
console.log(`  精確（循序）最近鄰 ${seq.ms} ms`);
t = performance.now();
await db.exec("CREATE INDEX v_hnsw ON v USING hnsw (e vector_cosine_ops)");
console.log(`  hnsw 索引建立 ${Math.round(performance.now() - t)} ms`);
const hn = await time(() => db.query("SELECT id FROM v ORDER BY e <=> $1 LIMIT 10", [q0]), 3);
console.log(`  hnsw 最近鄰 ${hn.ms} ms`);
console.log("\nJSON:" + JSON.stringify(results));
