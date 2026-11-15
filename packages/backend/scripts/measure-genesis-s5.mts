// Cost of migration 202 (genesis stamps + structure baseline) on a database that has the notes but no stamps yet, in-memory PGlite:
//   npx tsx scripts/measure-genesis-s5.mts [notes]        (default 20000)
//   MEASURE_PG_URL=postgres://.../empty_database npx tsx scripts/measure-genesis-s5.mts [notes]
//       the same on a real Postgres server: an EMPTY throwaway database (every migration before 202 is applied to it; without pgvector the
//       vector column and its index are replaced by a plain array)
// It seeds a workspace the way an older server left it (triggers off while seeding, so nothing is stamped), prints what the migration's
// preview says, runs the migration (the file as it is, so it also proves it runs on PGlite), and prints the time, the rows added and the
// size of sync_stamps / structure_log before and after (pg_total_relation_size: heap plus indexes). Counts only; no real data is used.
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setEnvironment } from "../src/config.js";

setEnvironment({
  NODE_ENV: "production", ONDEN_DB_DRIVER: "pglite", ONDEN_PGLITE_DIR: "memory://",
  BETTER_AUTH_SECRET: "measure-only-never-used-to-sign-a-session", BETTER_AUTH_URL: "http://localhost", LOG_LEVEL: "warn",
});
const PG_URL = process.env.MEASURE_PG_URL ?? "";
type Rows = { rows: Array<Record<string, any>> };
let q: (sql: string, params?: unknown[]) => Promise<Rows>;
let inTransaction: (fn: () => Promise<void>) => Promise<void>;
if (PG_URL) {
  const { default: pg } = await import("pg");
  const { listMigrations, portableMigrationSql } = await import("../src/dbMigrations.js");
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm; SET TimeZone = 'UTC'");
  for (const m of await listMigrations()) {
    if (m.version >= "202") continue;
    await client.query(portableMigrationSql(m.sql).replace(/CREATE EXTENSION IF NOT EXISTS vector;/g, "").replace(/vector\(384\)/g, "real[]").replace(/CREATE INDEX[^;]*USING hnsw[^;]*;/gi, ""));
  }
  q = (sql, params) => client.query(sql, params) as Promise<Rows>;
  inTransaction = async (fn) => { await client.query("BEGIN"); try { await fn(); await client.query("COMMIT"); } catch (e) { await client.query("ROLLBACK"); throw e; } };
} else {
  const db = await import("../src/db.js");
  await db.migrate();
  q = db.q as typeof q;
  inTransaction = (fn) => db.allowUnstampedWrite("measurement fixture", () => db.withTransaction(fn)) as Promise<void>;
}

const N = Number(process.argv[2] ?? 20000);
const sqlText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../db/migrations/202_stamps_genesis.sql"), "utf8");
const lines = sqlText.split("\n");
const from = lines.findIndex((l) => l.startsWith("--   WITH trg AS"));
const preview: string[] = [];
for (let i = from; i < lines.length && lines[i] !== "--"; i++) preview.push(lines[i]!.replace(/^--   ?/, ""));

const ms = (t: number) => Math.round(performance.now() - t);
const ws = (await q(`INSERT INTO workspaces (name, slug) VALUES ('measure', 'measure-genesis') RETURNING id::text`)).rows[0]!.id;
const space = (await q(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
const owner = (await q(`INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'm', 'human') RETURNING id::text`, [ws])).rows[0]!.id;

// the world: triggers off, so nothing is stamped or logged (what the database looked like before stamps existed)
let t = performance.now();
await inTransaction(async () => {
await q(`SET LOCAL session_replication_role = replica`);
const TAGS = 60;
await q(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, tag_schema)
         SELECT $1, 'manual', 'class_tag', 'tag ' || g, 'tag-m-' || g,
                jsonb_build_object('fields', jsonb_build_array(jsonb_build_object('name','a')), 'extends', '[]'::jsonb, 'color', 'red', 'k' || g, g, 'm', 1)
           FROM generate_series(1, $2::int) g`, [ws, TAGS]);
await q(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id, deleted_at)
         SELECT $1, 'manual', 'content', 'note ' || g, 'note-m-' || g, repeat('body ', 40), $2, CASE WHEN g % 20 = 0 THEN now() END
           FROM generate_series(1, $3::int) g`, [ws, space, N]);
await q(`UPDATE content_nodes c SET parent_id = p.id
           FROM (SELECT id, row_number() OVER (ORDER BY slug) AS rn FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content') p,
                (SELECT id, row_number() OVER (ORDER BY slug) AS rn FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content') q
          WHERE c.id = q.id AND q.rn % 5 <> 0 AND p.rn = (q.rn / 5) + 1 AND p.id <> q.id`, [ws]);
const notes = `(SELECT id, row_number() OVER (ORDER BY slug) AS rn FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content')`;
const tags = `(SELECT id, row_number() OVER (ORDER BY slug) AS rn FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag')`;
await q(`INSERT INTO node_tags (node_id, tag_id) SELECT n.id, tg.id FROM ${notes} n JOIN ${tags} tg ON tg.rn = (n.rn % ${TAGS}) + 1 UNION SELECT n.id, tg.id FROM ${notes} n JOIN ${tags} tg ON tg.rn = ((n.rn * 7) % ${TAGS}) + 1 WHERE n.rn % 2 = 0`, [ws]);
await q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source)
         SELECT $1, n.id, k.key, 'v' || n.rn, k.source FROM ${notes} n CROSS JOIN (VALUES ('status','ui'), ('due','markdown'), ('prio','explicit'), ('child:x','derived')) k(key, source) WHERE n.rn % 3 <> 0`, [ws]);
await q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source)
         SELECT $1, n.id, '_canvas_sections', '[{"id":"s1","title":"a"},{"id":"s2","title":"b"},{"id":"s3","title":"c"}]', 'ui' FROM ${notes} n WHERE n.rn % 200 = 0`, [ws]);
await q(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin)
         SELECT $1, a.id, b.id, 'relates_to', 'active', CASE WHEN a.rn % 2 = 0 THEN 'manual' ELSE 'wikilink' END FROM ${notes} a JOIN ${notes} b ON b.rn = a.rn + 1 WHERE a.rn % 2 = 0 OR a.rn % 3 = 0`, [ws]);
await q(`INSERT INTO note_pointers (id, workspace_id, parent_id, target_id) SELECT gen_random_uuid(), $1, a.id, b.id FROM ${notes} a JOIN ${notes} b ON b.rn = a.rn + 2 WHERE a.rn % 10 = 0`, [ws]);
await q(`INSERT INTO node_positions (node_id, surface, x, y, workspace_id) SELECT n.id, (SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content' ORDER BY slug LIMIT 1), n.rn, n.rn, $1 FROM ${notes} n WHERE n.rn % 2 = 0`, [ws]);
await q(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id, config) SELECT $1, 'view', n.id, jsonb_build_object('a', 1, 'b', n.rn, 'c', 'x') FROM ${notes} n WHERE n.rn % 40 = 0`, [ws]);
});
const seedMs = ms(t);

const count = async (sql: string) => Number((await q(sql)).rows[0]!.n);
const size = async (table: string) => count(`SELECT pg_total_relation_size('${table}')::text AS n`);
const before = { stamps: await count(`SELECT count(*)::text AS n FROM sync_stamps`), log: await count(`SELECT count(*)::text AS n FROM structure_log`), stampBytes: await size("sync_stamps"), logBytes: await size("structure_log") };
const rows = await count(`SELECT count(*)::text AS n FROM content_nodes WHERE workspace_id = '${ws}'`);

t = performance.now();
const pv = (await q(preview.join("\n"))).rows as Array<Record<string, unknown>>;
const previewMs = ms(t);
console.log(JSON.stringify({ engine: PG_URL ? "postgres" : "pglite", notes: N, content_nodes_rows: rows, seedMs, previewMs }));
for (const r of pv) console.log(JSON.stringify(r));

t = performance.now();
await q(sqlText);
const runMs = ms(t);
const after = { stamps: await count(`SELECT count(*)::text AS n FROM sync_stamps`), log: await count(`SELECT count(*)::text AS n FROM structure_log`), stampBytes: await size("sync_stamps"), logBytes: await size("structure_log") };
t = performance.now();
await q(sqlText);
const rerunMs = ms(t);
const nullLines = await count(`SELECT count(*)::text AS n FROM structure_log WHERE origin = 'genesis' AND field <> 'baseline' AND new_value IS NULL`);
const again = await count(`SELECT count(*)::text AS n FROM sync_stamps`) + await count(`SELECT count(*)::text AS n FROM structure_log`);
console.log(JSON.stringify({ runMs, rerunMs, before, after, added: { stamps: after.stamps - before.stamps, log: after.log - before.log }, addedBytes: { stamps: after.stampBytes - before.stampBytes, log: after.logBytes - before.logBytes }, rerunAdded: again - after.stamps - after.log, baselineLinesWithNoValue: nullLines }));
process.exit(0);
