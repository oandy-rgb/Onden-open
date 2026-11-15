// Migration 202: every unit that exists today gets a genesis write stamp, and the structure log gets a baseline.
// A database of its own (PGlite, every migration before 202 applied, the way a production database looks just before the upgrade):
// a workspace that has the rows but no stamps (what an older server left), a workspace whose rows were all stamped by the triggers,
// and a few units of the first one that keep a real stamp. The migration's own preview is run on it (read-only), the migration is run,
// and each test reads the result. The migration finds what to stamp in the trigger catalog, so the last tests wire up tables it
// has never heard of.
// realPostgresAlso: the migration is plain SQL and plpgsql that both engines run, but its run time and the byte estimate are the
// engine's own, and a real server is what production is. A real Postgres run uses an empty database it makes itself (OWN_DATABASE below);
// or point GENESIS_PG_URL at an EMPTY database of a Postgres 16 server (this file
// applies every migration to it, so it must be a throwaway) to run the same tests there. Without pgvector the vector column and its
// index are replaced by a plain array: nothing the stamps touch uses them.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { openPglite } from "../dbPglite.js";
import { listMigrations, portableMigrationSql } from "../dbMigrations.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { STAMPED_UNITS as UNITS } from "./helpers/stampedUnits.js";

const MIGRATION = "202_stamps_genesis";
const sqlText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../db/migrations", `${MIGRATION}.sql`), "utf8");

/** The preview query in the migration's header (comment lines `--   ...` from `WITH trg AS` up to the next bare `--`). */
/** How many (table, unit kind) pairs the preview says are baselined. */
const promisedUnitKinds = (rows: PreviewRow[]) => new Set(rows.filter((p) => p.part === "structure baseline").map((p) => `${p.table_name}|${p.unit}`)).size;

function previewQuery(): string {
  const lines = sqlText.split("\n");
  const from = lines.findIndex((l) => l.startsWith("--   WITH trg AS"));
  const out: string[] = [];
  for (let i = from; i < lines.length && lines[i] !== "--"; i++) out.push(lines[i]!.replace(/^--   ?/, ""));
  return out.join("\n");
}
/** The same query as the migration's own DO block runs (between `FOR v_step IN` and the last SELECT before the loop). */
function planInDoBlock(): string {
  const from = sqlText.indexOf("FOR v_step IN\n") + "FOR v_step IN\n".length;
  const to = sqlText.indexOf("\n    SELECT DISTINCT part, table_name, unit, src_sql FROM plan");
  return sqlText.slice(from, to).split("\n").map((l) => l.replace(/^ {4}/, "")).join("\n");
}
const planInPreview = () => previewQuery().split("\n,\nr AS (")[0]!;

type Row = Record<string, unknown>;
type PreviewRow = { part: string; table_name: string; unit: string; rows_now: string | null; already_there: string | null; will_add: string | null; est_bytes: string | null };

type Conn = {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
  /** The whole database as a restorable copy (PGlite only). */
  copy?: () => Promise<Conn>;
};
// On a real Postgres run (a `_test` DATABASE_URL, not PGlite) the file makes an empty database of its own on that server and drops it
// at the end, so every test here, the two-connection one included, runs there without anyone setting GENESIS_PG_URL.
const OWN_DATABASE = !process.env.GENESIS_PG_URL && process.env.ONDEN_DB_DRIVER !== "pglite" && isTestDatabase()
  ? `genesis_${randomUUID().replaceAll("-", "").slice(0, 12)}_test` : "";
const onSameServer = (database: string) => { const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; return url.toString(); };
async function ownDatabase(statement: string): Promise<void> {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try { await admin.query(statement); } finally { await admin.end(); }
}
const PG_URL = process.env.GENESIS_PG_URL ?? (OWN_DATABASE ? onSameServer(OWN_DATABASE) : "");
async function connect(): Promise<Conn> {
  if (!PG_URL) {
    const lite = await openPglite({ dataDir: "memory://" });
    await lite.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm");
    const wrap = (l: typeof lite): Conn => ({ query: (sql, params) => l.query(sql, params) as Promise<{ rows: never[] }>, exec: (sql) => l.exec(sql), close: () => l.close() });
    return { ...wrap(lite), copy: async () => { const dump = await lite.dumpDataDir("none"); return wrap(await openPglite({ dataDir: "memory://", loadDataDir: async () => dump })); } };
  }
  if (OWN_DATABASE) await ownDatabase(`CREATE DATABASE "${OWN_DATABASE}"`);
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm; SET TimeZone = 'UTC'");
  return { query: (sql, params) => client.query(sql, params) as Promise<{ rows: never[] }>, exec: (sql) => client.query(sql), close: () => client.end() };
}
/** What a server without pgvector needs of the migrations: the extension, the vector column and its index are left out. */
const withoutVector = (sql: string) => (PG_URL ? sql.replace(/CREATE EXTENSION IF NOT EXISTS vector;/g, "").replace(/vector\(384\)/g, "real[]").replace(/CREATE INDEX[^;]*USING hnsw[^;]*;/gi, "") : sql);

describe.skipIf(!isTestDatabase())("migration 202: genesis stamps and the structure baseline", { timeout: 240_000 }, () => {
  let db!: Conn;
  const tag = randomUUID().slice(0, 8);
  let W = ""; // the workspace an older server left: rows, no stamps
  let V = ""; // a workspace whose rows were all stamped by the triggers as they were written
  const ids: Record<string, string> = {};
  let preview: PreviewRow[] = [];
  let previewOnReadOnlySession: PreviewRow[] = [];
  let stampsBefore: Row[] = [];
  let logBefore: Row[] = [];
  let tablesBefore: Record<string, string> = {};
  let titlesBefore = "";
  let applied: { stamps: Row[]; log: Row[]; tables: Record<string, string>; titles: string } | null = null;

  const all = async <T extends Row = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const one = async <T extends Row = Row>(sql: string, params: unknown[] = []) => (await all<T>(sql, params))[0]!;

  /** A hash of every table but the two the migration writes: the migration may not change anything else. */
  async function tableHashes(): Promise<Record<string, string>> {
    const names = (await all<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
                                                AND table_name NOT IN ('sync_stamps', 'structure_log', 'schema_migrations') ORDER BY 1`)).map((r) => r.t);
    const out: Record<string, string> = {};
    for (const t of names) out[t] = (await one<{ h: string }>(`SELECT md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`)).h;
    return out;
  }
  const stampRows = () => all(`SELECT * FROM sync_stamps ORDER BY workspace_id, table_name, row_key, field`);
  const logRows = () => all(`SELECT l.id::text AS log_id, l.workspace_id, l.table_name, l.row_key, l.field, l.old_value, l.new_value, l.origin, l.seq::text AS seq, l.hlc_wall::text AS hlc_wall, l.hlc_counter, l.author, l.device FROM structure_log l ORDER BY l.id`);
  const titleHash = async () => (await one<{ h: string }>(`SELECT md5(COALESCE(string_agg(id::text || '|' || title || '|' || markdown, E'\n' ORDER BY id), '')) AS h FROM content_nodes`)).h;

  async function seedWorld(name: string): Promise<string> {
    const ws = (await one<{ id: string }>(`INSERT INTO workspaces (name, slug, modules_off, modules_confirmed) VALUES ($1, $2, '["review", "rss"]'::jsonb, '["capture"]'::jsonb) RETURNING id::text`, [name, `${name}-${tag}`])).id;
    const actor = (await one<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1, $2, 'human') RETURNING id::text`, [ws, `${name} owner`])).id;
    const space = (await one<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).id;
    const shared = (await one<{ id: string }>(`INSERT INTO spaces (workspace_id, name, kind, capabilities) VALUES ($1, 'Shared', 'shared', '{"publish": true, "backup": false}'::jsonb) RETURNING id::text`, [ws])).id;
    await db.query(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit') ON CONFLICT DO NOTHING`, [shared, actor]);
    const note = async (title: string, over: { parent?: string; deleted?: boolean; type?: string; schema?: unknown; views?: unknown } = {}) =>
      (await one<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id, parent_id, deleted_at, tag_schema, collection_views)
         VALUES ($1, 'manual', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb) RETURNING id::text`,
        [ws, over.type ?? "content", title, `${title.replace(/\W+/g, "-")}-${tag}-${name}`, `body of ${title} secret-text-${name}`, space, over.parent ?? null,
          over.deleted ? new Date().toISOString() : null, over.schema ? JSON.stringify(over.schema) : null, over.views ? JSON.stringify(over.views) : null])).id;
    const a = await note(`${name} alpha`);
    const b = await note(`${name} beta`, { parent: a });
    const c = await note(`${name} gamma`, { deleted: true });
    const board = await note(`${name} board`, { type: "canvas" });
    const tagA = await note(`${name} tag A`, { type: "class_tag", schema: { fields: [{ name: "x" }], extends: [], color: "red" } });
    const tagB = await note(`${name} tag B`, { type: "class_tag", schema: { module: "capture", name: "x" }, views: [{ id: "v1", name: "one" }, { id: "v2", name: "two" }] });
    for (const [n, t] of [[a, tagA], [b, tagA], [c, tagB]]) await db.query(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [n, t]);
    for (const [n, key, value, source] of [[a, "status", "doing", "ui"], [a, "due", "2030-01-01", "markdown"], [b, "prio", "3", "explicit"], [b, "child:x", "y", "derived"], [c, "fm", "z", "frontmatter"], [b, "auto", "1", "dispatcher"]]) {
      await db.query(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, $3, $4, $5)`, [ws, n, key, value, source]);
    }
    await db.query(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, '_canvas_sections', $3, 'ui')`,
      [ws, board, JSON.stringify([{ id: "s1", title: "left" }, { id: "s2", title: "right" }])]);
    await db.query(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1, $2, $3, 'relates_to', 'active', 'manual'), ($1, $3, $2, 'relates_to', 'suggested', 'wikilink')`, [ws, a, b]);
    await db.query(`INSERT INTO note_pointers (workspace_id, parent_id, target_id) VALUES ($1, $2, $3), ($1, NULL, $3)`, [ws, a, b]);
    await db.query(`INSERT INTO node_positions (node_id, surface, x, y, width, workspace_id) VALUES ($1, $2, 10, 20, 100, $3), ($4, 'graph', 1, 2, NULL, $3)`, [b, board, ws, a]);
    await db.query(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id, config) VALUES ($1, 'view', $2, '{"p": 1, "q": "two"}'::jsonb), ($1, 'mark', $3, '{}'::jsonb)`, [ws, a, b]);
    await db.query(`INSERT INTO actor_module_settings (actor_id, tag_id, settings) VALUES ($1, $2, '{"on": true}'::jsonb)`, [actor, tagA]);
    const feed = (await one<{ id: string }>(`INSERT INTO rss_subscriptions (workspace_id, space_id, title, url) VALUES ($1, $2, 'Feed', 'https://example.test/feed.xml') RETURNING id::text`, [ws, space])).id;
    await db.query(`INSERT INTO rss_mutes (workspace_id, actor_id, keyword, expires_at) VALUES ($1, $2, 'word', now() + interval '1 day')`, [ws, actor]);
    await db.query(`INSERT INTO external_calendars (id, workspace_id, actor_id, name, color, url_ciphertext, url_host) VALUES (gen_random_uuid(), $1, $2, 'Cal', '#fff', '\\x00', 'example.test')`, [ws, actor]);
    // a note that is purged for good: its tombstone is a stamp that must stay as it is
    const gone = await note(`${name} gone`);
    await db.query(`DELETE FROM content_nodes WHERE id = $1`, [gone]);
    // a row that exists before stamps and has been edited since: a field stamp and no whole-row stamp
    await db.query(`UPDATE content_nodes SET title = $2 WHERE id = $1`, [b, `${name} beta edited`]);
    Object.assign(ids, { [`${name}.a`]: a, [`${name}.b`]: b, [`${name}.c`]: c, [`${name}.board`]: board, [`${name}.tagA`]: tagA, [`${name}.tagB`]: tagB, [`${name}.gone`]: gone, [`${name}.shared`]: shared, [`${name}.feed`]: feed, [`${name}.actor`]: actor });
    return ws;
  }

  /** Make W look like a database from before stamps: take its stamps and log lines away, except the few it keeps. */
  async function stripWorld(ws: string): Promise<void> {
    await db.exec(`ALTER TABLE structure_log DISABLE TRIGGER USER`);
    await db.query(`DELETE FROM structure_log WHERE workspace_id = $1`, [ws]);
    await db.exec(`ALTER TABLE structure_log ENABLE TRIGGER USER`);
    await db.query(
      `DELETE FROM sync_stamps WHERE workspace_id = $1 AND NOT (
         (table_name = 'content_nodes' AND row_key = $2)                                     -- the whole row of one note stays stamped
         OR (table_name = 'content_nodes' AND row_key = $3 AND field <> '*')                  -- a row with only a field stamp
         OR (table_name = 'content_nodes.tag_schema' AND row_key = $4 AND field = 'key:fields') -- one key of one tag
         OR (table_name = 'content_nodes' AND row_key = $5 AND deleted))                      -- a tombstone`,
      [ws, ids["W.a"], ids["W.b"], ids["W.tagA"], ids["W.gone"]]);
  }

  beforeAll(async () => {
    db = await connect();
    for (const m of await listMigrations()) {
      if (m.version >= MIGRATION) continue;
      await db.exec(withoutVector(portableMigrationSql(m.sql)));
    }
    V = await seedWorld("V");
    W = await seedWorld("W");
    await stripWorld(W);
    // an attribute a new note inherited: stamped by the application at creation although its source is derived (#1658)
    await db.query(`SELECT sync_stamp_put($1::uuid, 'node_attributes', $2, '*', false, sync_stamp_current($1::uuid))`, [W, `${ids["W.b"]}/child:x`]);
    stampsBefore = await stampRows();
    logBefore = await logRows();
    tablesBefore = await tableHashes();
    titlesBefore = await titleHash();

    // the preview, as the owner would run it: on a database that has not had 202 applied, in a read-only transaction
    await db.exec("BEGIN READ ONLY");
    preview = (await db.query<PreviewRow>(previewQuery())).rows;
    await db.exec("ROLLBACK");
    await db.exec("SET default_transaction_read_only = on");
    previewOnReadOnlySession = (await db.query<PreviewRow>(previewQuery())).rows;
    await db.exec("SET default_transaction_read_only = off");

    // the migration, the way migrate() runs it
    await db.exec("BEGIN");
    await db.exec("SET LOCAL statement_timeout = 0");
    await db.exec(portableMigrationSql(sqlText));
    await db.exec("COMMIT");
    applied = { stamps: await stampRows(), log: await logRows(), tables: await tableHashes(), titles: await titleHash() };
  });
  afterAll(async () => {
    await db?.close();
    if (OWN_DATABASE) await ownDatabase(`DROP DATABASE IF EXISTS "${OWN_DATABASE}" WITH (FORCE)`);
  });

  const key = (r: Row) => [r.workspace_id, r.table_name, r.row_key, r.field].join("\u0001");
  const stampsAdded = () => {
    const before = new Set(stampsBefore.map(key));
    return applied!.stamps.filter((r) => !before.has(key(r)));
  };
  const logAdded = () => applied!.log.slice(logBefore.length);

  it("the preview runs on a database without 202, in a read-only transaction and on a read-only session, with the same answer", () => {
    expect(preview.length).toBeGreaterThan(20);
    expect(previewOnReadOnlySession).toEqual(preview);
  });

  it("the preview returns counts and byte estimates only: no title, text, id or value", () => {
    const text = JSON.stringify(preview);
    for (const secret of ["secret-text", "alpha", "beta", "Shared", "feed.xml", W, V, ids["W.a"]!]) expect(text).not.toContain(secret);
    for (const r of preview) {
      expect(["stamps", "structure baseline", "totals", "left without a stamp on purpose", "skipped (no workspace found, or a NULL in the key): not stamped"]).toContain(r.part);
      for (const v of [r.rows_now, r.already_there, r.will_add, r.est_bytes]) expect(v === null || /^\d+$/.test(String(v))).toBe(true);
    }
  });

  it("the plan in the header is the plan the migration runs", () => {
    expect(planInDoBlock()).toBe(planInPreview());
  });

  it("the preview says, for each table and unit kind, what the migration then adds (stamps)", () => {
    const unit = (table: string, field: string) => (field === "*" ? "row" : `${field.slice(0, field.indexOf(":") + 1)}*`);
    const added = new Map<string, number>();
    for (const r of stampsAdded()) added.set(`${r.table_name}|${unit(String(r.table_name), String(r.field))}`, (added.get(`${r.table_name}|${unit(String(r.table_name), String(r.field))}`) ?? 0) + 1);
    const promised = new Map<string, number>();
    for (const r of preview.filter((p) => p.part === "stamps" && Number(p.will_add) > 0)) {
      const k = `${r.table_name}|${r.unit.startsWith("row") ? "row" : r.unit}`;
      promised.set(k, (promised.get(k) ?? 0) + Number(r.will_add));
    }
    expect(Object.fromEntries([...promised].sort())).toEqual(Object.fromEntries([...added].sort()));
    // every table with a trigger has its line, also when it has no rows
    for (const t of ["content_nodes", "node_tags", "node_attributes", "node_edges", "note_pointers", "node_positions", "spaces", "space_members", "workspaces", "function_refs",
                     "content_nodes.tag_schema", "content_nodes.collection_views", "spaces.capabilities", "function_refs.config", "workspaces.modules_off", "node_attributes._canvas_sections",
                     "rss_mutes", "rss_subscriptions", "external_calendars", "actor_module_settings", "block_node_tags"]) {
      expect(preview.some((p) => p.part === "stamps" && p.table_name === t), t).toBe(true);
    }
    const total = preview.find((p) => p.part === "totals" && p.table_name === "sync_stamps")!;
    expect(Number(total.rows_now)).toBe(stampsBefore.length);
    expect(Number(total.will_add)).toBe(stampsAdded().length);
  });

  it("the preview says what the migration then adds (structure baseline, with one marker per workspace and unit kind)", async () => {
    const added = new Map<string, number>();
    for (const r of logAdded().filter((l) => l.table_name !== "baseline")) {
      const field = String(r.field).startsWith("capability:") ? "capability:*" : String(r.field);
      added.set(`${r.table_name}|${field}`, (added.get(`${r.table_name}|${field}`) ?? 0) + 1);
    }
    const promised = new Map<string, number>();
    for (const r of preview.filter((p) => p.part === "structure baseline" && Number(p.will_add) > 0)) promised.set(`${r.table_name}|${r.unit}`, Number(r.will_add));
    expect(Object.fromEntries([...promised].sort())).toEqual(Object.fromEntries([...added].sort()));
    const total = preview.find((p) => p.part === "totals" && p.table_name === "structure_log")!;
    expect(Number(total.rows_now)).toBe(logBefore.length);
    expect(Number(total.will_add)).toBe(logAdded().length);
    const workspaces = Number((await one<{ n: string }>(`SELECT count(*)::text AS n FROM workspaces`)).n);
    expect(logAdded().filter((l) => l.table_name === "baseline").length).toBe(workspaces * promisedUnitKinds(preview));
  });

  it("every unit gets a stamp: the ones that had one keep it, the others the genesis stamp", async () => {
    const units = await all<{ ws: string; tn: string; rk: string; fld: string }>(UNITS);
    expect(units.length).toBeGreaterThan(60);
    const have = new Map(applied!.stamps.map((r) => [key(r), r]));
    const hadBefore = new Map(stampsBefore.map((r) => [key(r), r]));
    for (const u of units) {
      const k = [u.ws, u.tn, u.rk, u.fld].join("\u0001");
      const stamp = have.get(k);
      expect(stamp, `${u.tn} ${u.fld} has no stamp`).toBeDefined();
      if (hadBefore.has(k)) expect(stamp).toEqual(hadBefore.get(k));
      else expect(stamp).toMatchObject({ origin: "genesis", seq: "0", hlc_wall: "0", hlc_counter: 0, author: null, device: null, deleted: false });
    }
  });

  it("a stamp that exists is not touched: the stamps of before are all there, row for row", () => {
    const after = new Map(applied!.stamps.map((r) => [key(r), r]));
    for (const r of stampsBefore) expect(after.get(key(r)), `${r.table_name} ${r.field}`).toEqual(r);
    // the tombstone, the field-only row, the application's stamp on an inherited attribute
    expect(after.get([W, "content_nodes", ids["W.gone"], "*"].join("\u0001"))).toMatchObject({ deleted: true });
    expect(after.get([W, "content_nodes", ids["W.b"], "title"].join("\u0001"))).toMatchObject({ origin: expect.not.stringMatching(/^genesis$/) });
    expect(after.get([W, "content_nodes", ids["W.b"], "*"].join("\u0001"))).toMatchObject({ origin: "genesis" });
    expect(after.get([W, "node_attributes", `${ids["W.b"]}/child:x`, "*"].join("\u0001"))).toMatchObject({ origin: expect.not.stringMatching(/^genesis$/) });
  });

  it("a genesis stamp is the same constants everywhere: nothing from this node, this moment or chance", () => {
    const shapes = new Set(stampsAdded().map((r) => JSON.stringify([r.origin, r.seq, r.hlc_wall, r.hlc_counter, r.author, r.device, r.deleted])));
    expect([...shapes]).toEqual([JSON.stringify(["genesis", "0", "0", 0, null, null, false])]);
  });

  it("what is not stamped on purpose is not: text-produced and computed attributes, automatic edges, a unit of a workspace that already has stamps", () => {
    const added = stampsAdded();
    const has = (table: string, rk: string, ws = W) => added.some((r) => r.workspace_id === ws && r.table_name === table && r.row_key === rk);
    expect(has("node_attributes", `${ids["W.a"]}/status`)).toBe(true);        // ui
    expect(has("node_attributes", `${ids["W.b"]}/prio`)).toBe(true);          // explicit
    expect(has("node_attributes", `${ids["W.b"]}/auto`)).toBe(true);          // dispatcher
    expect(has("node_attributes", `${ids["W.a"]}/due`)).toBe(false);          // markdown
    expect(has("node_attributes", `${ids["W.c"]}/fm`)).toBe(false);           // frontmatter
    expect(has("node_attributes", `${ids["W.b"]}/child:x`)).toBe(false);      // derived (it has its own stamp from creation)
    expect(added.some((r) => r.table_name === "node_edges" && r.row_key === `${ids["W.b"]}/${ids["W.a"]}/relates_to`)).toBe(false); // wikilink edge
    expect(added.filter((r) => r.workspace_id === V)).toEqual([]);             // V was stamped as it was written
    expect(added.some((r) => r.table_name === "content_nodes" && r.row_key === ids["W.gone"])).toBe(false); // the purged note: only its tombstone
  });

  it("the baseline has the structure of today, stamped genesis, and a marker for each workspace", async () => {
    const added = logAdded();
    expect(added.every((l) => l.origin === "genesis" && l.seq === "0" && l.hlc_wall === "0" && l.hlc_counter === 0 && l.author === null && l.device === null)).toBe(true);
    expect(added.every((l) => l.old_value === null)).toBe(true);
    const markers = added.filter((l) => l.table_name === "baseline");
    const workspaces = (await all<{ id: string }>(`SELECT id::text FROM workspaces`)).map((r) => r.id).sort();
    expect([...new Set(markers.map((m) => m.workspace_id))].sort()).toEqual(workspaces);
    expect(markers.every((m) => m.new_value === null && m.old_value === null)).toBe(true);
    // each workspace has one marker per unit kind, and each kind that has lines has its marker
    const kinds = new Set(markers.map((m) => `${m.row_key}|${m.field}`));
    expect(kinds.size * workspaces.length).toBe(markers.length);
    for (const l of added.filter((x) => x.table_name !== "baseline")) {
      const kind = String(l.field).startsWith("capability:") ? "capability:*" : String(l.field);
      expect(kinds.has(`${l.table_name}|${kind}`), `${l.table_name} ${l.field}`).toBe(true);
    }
    // each note: its parent, space and deleted state
    const beta = added.filter((l) => l.workspace_id === W && l.table_name === "content_nodes" && l.row_key === ids["W.b"]);
    expect(Object.fromEntries(beta.map((l) => [l.field, l.new_value]))).toMatchObject({ parent: ids["W.a"], deleted: "false" });
    const gamma = added.find((l) => l.workspace_id === W && l.row_key === ids["W.c"] && l.field === "deleted");
    expect(gamma!.new_value).toBe("true");
    // a tag applied, a board card as one JSON text, a board's section frames, a member's permission, a capability switch
    expect(added.some((l) => l.table_name === "node_tags" && l.field === "tag" && l.row_key === ids["W.a"] && l.new_value === ids["W.tagA"])).toBe(true);
    const card = added.find((l) => l.table_name === "node_positions" && l.field === "card" && l.workspace_id === W && l.row_key === `${ids["W.b"]}/${ids["W.board"]}`);
    expect(JSON.parse(String(card!.new_value))).toMatchObject({ x: 10, y: 20, width: 100 });
    expect(added.some((l) => l.table_name === "node_attributes" && l.field === "sections" && l.workspace_id === W)).toBe(true);
    expect(added.some((l) => l.table_name === "space_members" && l.field === "permission" && l.new_value === "edit" && l.workspace_id === W)).toBe(true);
    expect(added.find((l) => l.table_name === "spaces" && l.field === "capability:publish" && l.row_key === ids["W.shared"])!.new_value).toBe("true");
  });

  it("the baseline says exactly what the INSERT trigger logged when the same rows were made (workspace V, every line)", () => {
    const real = new Map<string, string | null>();
    for (const l of logBefore.filter((x) => x.workspace_id === V)) real.set([l.table_name, l.row_key, l.field, l.new_value].join("\u0001"), l.new_value as string | null);
    const baseline = logAdded().filter((l) => l.workspace_id === V && l.table_name !== "baseline");
    expect(baseline.length).toBeGreaterThan(15);
    for (const l of baseline) expect(real.has([l.table_name, l.row_key, l.field, l.new_value].join("\u0001")), `${l.table_name} ${l.field} ${l.new_value}`).toBe(true);
    // and none was missed: every unit the trigger logged for a row that still exists is in the baseline
    const baselined = new Set(baseline.map((l) => [l.table_name, l.row_key, l.field].join("\u0001")));
    const live = new Set(applied!.stamps.filter((s) => s.workspace_id === V && !s.deleted).map((s) => `${s.table_name}\u0001${s.row_key}`));
    for (const l of logBefore.filter((x) => x.workspace_id === V && x.new_value !== null && live.has(`${x.table_name}\u0001${x.row_key}`) && x.table_name !== "content_nodes.collection_views")) {
      if (l.table_name === "node_attributes" && l.field === "sections") continue;
      expect(baselined.has([l.table_name, l.row_key, l.field].join("\u0001")), `${l.table_name} ${l.field}`).toBe(true);
    }
  });

  it("nothing else changes: every other table has the same rows, and every note's title and text the same hash", () => {
    expect(applied!.tables).toEqual(tablesBefore);
    expect(applied!.titles).toBe(titlesBefore);
  });

  it("no event, no clock tick, no membership change: sync_clock and membership_epoch are as they were", async () => {
    const clock = (await all(`SELECT * FROM sync_clock ORDER BY workspace_id`)).length;
    expect(clock).toBeGreaterThanOrEqual(0);
    expect(applied!.tables["sync_clock"]).toBe(tablesBefore["sync_clock"]);
    expect(applied!.tables["domain_events"]).toBe(tablesBefore["domain_events"]);
    expect(applied!.tables["outbox"]).toBe(tablesBefore["outbox"]);
    expect(applied!.tables["workspaces"]).toBe(tablesBefore["workspaces"]);
  });

  it("an ordinary write after the migration stamps as it always did, and beats the genesis stamp", async () => {
    await db.query(`UPDATE content_nodes SET title = 'changed after 202' WHERE id = $1`, [ids["W.a"]]);
    const title = await one<Row>(`SELECT * FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = 'title'`, [W, ids["W.a"]]);
    expect(title.origin).not.toBe("genesis");
    expect(Number(title.hlc_wall)).toBeGreaterThan(0);
    const genesis = await one<Row>(`SELECT * FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = '*'`, [W, ids["W.c"]]);
    expect([Number(title.hlc_wall), Number(title.hlc_counter)] > [Number(genesis.hlc_wall), Number(genesis.hlc_counter)]).toBe(true);
    // and the first write to a genesis-stamped attribute key stamps only what it changes
    await db.query(`UPDATE node_attributes SET value = 'done' WHERE node_id = $1 AND key = 'status'`, [ids["W.a"]]);
    expect(await one(`SELECT field, origin FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'node_attributes' AND row_key = $2 AND field = 'value'`, [W, `${ids["W.a"]}/status`])).toMatchObject({ field: "value" });
  });

  it("running it again changes nothing", async () => {
    const [stamps, log, tables] = [await stampRows(), await logRows(), await tableHashes()];
    await db.exec("BEGIN");
    await db.exec(portableMigrationSql(sqlText));
    await db.exec("COMMIT");
    expect(await stampRows()).toEqual(stamps);
    expect(await logRows()).toEqual(log);
    expect(await tableHashes()).toEqual(tables);
  });

  it("a database backed up after the migration and restored keeps its stamps, and running the migration on it adds none", async () => {
    if (!db.copy) return; // a server: pg_dump / pg_restore is the owner's restore drill (scripts/restore-drill.sh), not run here
    // the whole database (the way pg_dump / pg_restore carries it): the stamps, the baseline and the marker travel with it
    const copy = await db.copy();
    try {
      const count = async () => (await copy.query<{ s: string; l: string }>(`SELECT (SELECT count(*) FROM sync_stamps)::text AS s, (SELECT count(*) FROM structure_log)::text AS l`)).rows[0]!;
      const restored = await count();
      expect(Number(restored.s)).toBe((await stampRows()).length);
      expect(Number(restored.l)).toBe((await logRows()).length);
      await copy.exec("BEGIN");
      await copy.exec(portableMigrationSql(sqlText));
      await copy.exec("COMMIT");
      expect(await count()).toEqual(restored);
    } finally {
      await copy.close();
    }
  });

  it("the migration only reads content_nodes and the other big tables (ACCESS SHARE, which blocks no write) and writes the two side tables", async () => {
    await db.exec("BEGIN");
    try {
      await db.exec(`DELETE FROM sync_stamps WHERE origin = 'genesis' AND table_name = 'content_nodes'`);
      await db.exec(portableMigrationSql(sqlText));
      const held = await all<{ relname: string; modes: string }>(
        `SELECT c.relname::text AS relname, string_agg(DISTINCT l.mode, ',' ORDER BY l.mode) AS modes FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = pg_backend_pid() AND c.relname IN ('content_nodes', 'node_tags', 'node_attributes', 'node_positions', 'node_edges', 'note_pointers', 'sync_stamps', 'structure_log')
          GROUP BY 1 ORDER BY 1`);
      const modes = Object.fromEntries(held.map((r) => [r.relname, r.modes]));
      for (const t of ["content_nodes", "node_tags", "node_attributes", "node_positions", "node_edges", "note_pointers"]) expect(modes[t], t).toBe("AccessShareLock");
      expect(modes["sync_stamps"]).toBe("RowExclusiveLock");
      expect(modes["structure_log"]).toBe("AccessShareLock,RowExclusiveLock");
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it.skipIf(!PG_URL)("a write that runs while the migration is open ends with its own stamp, not the genesis one (real server, two connections)", async () => {
    // the migration's transaction holds a genesis stamp for a tag application that a second connection then removes (its trigger writes the
    // tombstone on the same key); it waits for the migration to end, then its tombstone replaces the genesis stamp
    const other = new pg.Client({ connectionString: PG_URL });
    await other.connect();
    try {
      const row = await one<{ node_id: string; tag_id: string }>(`SELECT node_id::text, tag_id::text FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id WHERE n.workspace_id = $1 LIMIT 1`, [W]);
      const stampKey = `${row.node_id}/${row.tag_id}`;
      await db.query(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'node_tags' AND row_key = $2`, [W, stampKey]);
      await db.exec("BEGIN");
      await db.exec(portableMigrationSql(sqlText)); // the genesis stamp is inserted here, not yet visible to the other connection
      let finished = false;
      const write = other.query(`DELETE FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [row.node_id, row.tag_id]).then(() => { finished = true; });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(finished, "the write waits for the migration's stamp on the same key").toBe(false);
      await db.exec("COMMIT");
      await write;
      const stamp = await one<Row>(`SELECT origin, deleted FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'node_tags' AND row_key = $2 AND field = '*'`, [W, stampKey]);
      expect(stamp).toMatchObject({ deleted: true });
      expect(stamp.origin).not.toBe("genesis");
      // and a write that committed first is not overwritten by the migration
      const written = await one<{ node_id: string; tag_id: string }>(`SELECT node_id::text, tag_id::text FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id WHERE n.workspace_id = $1 LIMIT 1`, [W]);
      const key2 = `${written.node_id}/${written.tag_id}`;
      await db.query(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'node_tags' AND row_key = $2`, [W, key2]);
      await other.query(`DELETE FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [written.node_id, written.tag_id]);
      await db.exec("BEGIN");
      await db.exec(portableMigrationSql(sqlText));
      await db.exec("COMMIT");
      expect(await one(`SELECT origin, deleted FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'node_tags' AND row_key = $2 AND field = '*'`, [W, key2])).toMatchObject({ deleted: true });
    } finally {
      await other.end();
    }
  });

  it("two runs on the same data write the same stamps: taking the genesis stamps away and running again gives them back bit for bit", async () => {
    const genesis = async () => (await all(`SELECT * FROM sync_stamps WHERE origin = 'genesis' AND seq = 0 ORDER BY workspace_id, table_name, row_key, field`));
    const first = await genesis();
    expect(first.length).toBeGreaterThan(50);
    await db.exec(`DELETE FROM sync_stamps WHERE origin = 'genesis'`);
    await db.exec("BEGIN");
    await db.exec(portableMigrationSql(sqlText));
    await db.exec("COMMIT");
    expect(await genesis()).toEqual(first);
  });

  it("a table or JSON column wired up later is covered without editing the migration, and a trigger function it does not know stops it", async () => {
    await db.exec(`CREATE TABLE genesis_probe (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, note text, opts jsonb NOT NULL DEFAULT '{}', live boolean NOT NULL DEFAULT true)`);
    await db.exec(`CREATE TRIGGER genesis_probe_row AFTER INSERT ON genesis_probe FOR EACH ROW WHEN (NEW.live)
                     EXECUTE FUNCTION sync_stamp_trigger('genesis_probe', 'id', 'workspace_id', 'note=note', 'note=note')`);
    await db.exec(`CREATE TRIGGER genesis_probe_opts AFTER INSERT ON genesis_probe FOR EACH ROW
                     EXECUTE FUNCTION sync_stamp_json_trigger('genesis_probe.opts', 'id', 'workspace_id', 'opts', 'object', 'opt:', 'genesis_probe', 'opt:')`);
    await db.exec(`ALTER TABLE genesis_probe DISABLE TRIGGER USER`);
    const probe = (await one<{ id: string }>(`INSERT INTO genesis_probe (workspace_id, note, opts) VALUES ($1, 'n', '{"a": 1, "b": 2}') RETURNING id::text`, [W])).id;
    const dead = (await one<{ id: string }>(`INSERT INTO genesis_probe (workspace_id, note, live) VALUES ($1, 'x', false) RETURNING id::text`, [W])).id;
    await db.exec(`ALTER TABLE genesis_probe ENABLE TRIGGER USER`);
    // a table whose workspace cannot be found: its rows are reported, not stamped
    await db.exec(`CREATE TABLE genesis_probe_lost (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note_id uuid NOT NULL)`);
    await db.exec(`CREATE TRIGGER genesis_probe_lost_row AFTER INSERT ON genesis_probe_lost FOR EACH ROW EXECUTE FUNCTION sync_stamp_trigger('genesis_probe_lost', 'id', 'via:note_id', '', '')`);
    await db.exec(`ALTER TABLE genesis_probe_lost DISABLE TRIGGER USER`);
    await db.exec(`INSERT INTO genesis_probe_lost (note_id) VALUES (gen_random_uuid()), (gen_random_uuid())`);
    await db.exec(`ALTER TABLE genesis_probe_lost ENABLE TRIGGER USER`);
    const previewRows = (await db.query<PreviewRow>(previewQuery())).rows;
    const wantsProbe = previewRows.filter((r) => r.table_name.startsWith("genesis_probe") && r.part !== "skipped (no workspace found, or a NULL in the key): not stamped");
    expect(wantsProbe.map((r) => `${r.part}|${r.table_name}|${r.unit}|${r.will_add}`).sort()).toEqual([
      "stamps|genesis_probe.opts|opt:*|2", "stamps|genesis_probe|row|1", "stamps|genesis_probe_lost|row|0",
      // these two baselines are not taken yet in any workspace: partly taken is shown per unit kind
      "structure baseline|genesis_probe|note|1", "structure baseline|genesis_probe|opt:*|2",
    ].sort());
    expect(previewRows.filter((r) => r.part.startsWith("skipped")).map((r) => `${r.table_name}|${r.rows_now}`)).toEqual(["genesis_probe_lost|2"]);
    const workspaceCount = Number((await one<{ n: string }>(`SELECT count(*)::text AS n FROM workspaces`)).n);
    const genesisLines = async () => Number((await one<{ n: string }>(`SELECT count(*)::text AS n FROM structure_log WHERE origin = 'genesis' AND row_key <> 'genesis_probe' AND table_name <> 'genesis_probe'`)).n);
    const otherBefore = await genesisLines();
    const pass = await one<Record<string, string>>(`SELECT * FROM sync_genesis_pass()`);
    // the new column's baseline only: 1 line for the note field, 2 for the two options; one marker per workspace for each of the two kinds
    expect(pass).toEqual({ stamps_added: "3", baseline_lines_added: "3", markers_added: String(2 * workspaceCount), rows_skipped: "2" });
    expect(await one(`SELECT * FROM sync_genesis_pass()`)).toEqual({ stamps_added: "0", baseline_lines_added: "0", markers_added: "0", rows_skipped: "2" });
    expect(await genesisLines()).toBe(otherBefore); // nothing that was baselined before is repeated
    const stamps = await all<{ row_key: string; field: string; origin: string }>(`SELECT row_key, field, origin FROM sync_stamps WHERE workspace_id = $1 AND table_name LIKE 'genesis_probe%' ORDER BY table_name, field`, [W]);
    expect(stamps.map((s) => `${s.row_key === probe ? "probe" : "?"}|${s.field}`).sort()).toEqual(["probe|*", "probe|opt:a", "probe|opt:b"]);
    expect(stamps.some((s) => s.row_key === dead)).toBe(false); // the WHEN of the trigger decides which rows
    // a trigger function of this family the migration does not know
    await db.exec(`CREATE FUNCTION sync_stamp_other_trigger() RETURNS trigger AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql`);
    await db.exec(`CREATE TRIGGER genesis_probe_other AFTER INSERT ON genesis_probe FOR EACH ROW EXECUTE FUNCTION sync_stamp_other_trigger()`);
    const unknown = (await db.query<PreviewRow>(previewQuery())).rows.filter((r) => r.part.startsWith("trigger this migration does not know"));
    expect(unknown.map((r) => r.table_name)).toEqual(["sync_stamp_other_trigger"]);
    await db.exec("BEGIN");
    await expect(db.exec(portableMigrationSql(sqlText))).rejects.toThrow(/does not know/);
    await db.exec("ROLLBACK");
    // leave nothing behind for the tests that run after this one (the order of tests is random)
    await db.exec(`DROP TABLE genesis_probe; DROP TABLE genesis_probe_lost; DROP FUNCTION sync_stamp_other_trigger()`);
    await db.query(`DELETE FROM sync_stamps WHERE table_name LIKE 'genesis_probe%'`);
    await db.exec(`ALTER TABLE structure_log DISABLE TRIGGER USER; DELETE FROM structure_log WHERE table_name = 'genesis_probe' OR (table_name = 'baseline' AND row_key LIKE 'genesis_probe%'); ALTER TABLE structure_log ENABLE TRIGGER USER`);
  });
});
