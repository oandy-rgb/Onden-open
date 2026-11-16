// Migration 200 (same-level order keys), proven on its own database: one built at migration 194, filled with the awkward
// shapes the integer order allowed (ties, gaps, negative numbers, duplicates, trashed rows, pointers), the order every
// list used is recorded, migration 200 runs, and the new lists must give the identical order. Then: the stamp that existed
// on the old field carries over, the backfill stamped and logged nothing, a rerun changes nothing, and the next move is
// stamped and logged on the same field.
//
// The "before" lists are the SQL each list used before this migration (sidebar: sort_order, created_at, id; the bootstrap and
// the sync delta: sort_order, created_at; pointers: sort_order only). The "after" lists are the code's own ORDER BY.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openPglite } from "../dbPglite.js";
import { listMigrations, portableMigrationSql } from "../dbMigrations.js";
import { SIBLING_ORDER_N, SIBLING_ORDER_P, UNSORTED_ORDER_N } from "../services/orderKeys.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

let pg: PGlite;
let ws = "";
const parentA = randomUUID(), parentB = randomUUID();
const ids: Record<string, string> = {};

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;
const idList = async (sql: string, params: unknown[] = []) => (await rows<{ id: string }>(sql, params)).map((r) => r.id);

beforeAll(async () => {
  if (!isTestDatabase()) return;
  pg = await openPglite({ dataDir: "memory://" });
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm");
  for (const m of await listMigrations()) {
    if (m.version >= "200") break;
    await pg.exec(portableMigrationSql(m.sql));
  }
  ws = (await rows<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Order', $1) RETURNING id`, [randomUUID()]))[0]!.id;
  const note = async (name: string, parent: string | null, sort: number, created: string, trashed = false, id: string = randomUUID()) => {
    ids[name] = id;
    await pg.query(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id, sort_order, created_at, deleted_at)
       VALUES ($1, $2, 'manual', 'content', $3, $4, '', $5, $6, $7, ${trashed ? "now()" : "NULL"})`,
      [id, ws, name, `s-${name}`, parent, sort, created],
    );
    return id;
  };
  await note("A", null, 0, "2026-01-01T00:00:00Z", false, parentA);
  await note("B", null, 0, "2026-01-02T00:00:00Z", false, parentB);
  // Under A: ties at 0 (created order decides), a gap, a negative number, a duplicate creation time (the id decides), a trashed row in the middle.
  await note("a1", parentA, 0, "2026-02-03T00:00:00Z");
  await note("a2", parentA, 0, "2026-02-01T00:00:00Z");
  await note("a3", parentA, 7, "2026-02-01T00:00:00Z");
  await note("a4", parentA, 7, "2026-02-01T00:00:00Z");
  await note("a5", parentA, -4, "2026-03-01T00:00:00Z");
  await note("a6", parentA, 1000000, "2026-01-05T00:00:00Z");
  await note("a7", parentA, 3, "2026-02-02T00:00:00Z", true);
  await note("a8", parentA, 0, "2026-02-02T12:00:00Z");
  // Under B: every row at 0 (the common case on the real database).
  for (let i = 0; i < 70; i++) await note(`b${i}`, parentB, 0, new Date(Date.UTC(2026, 3, 1, 0, 0, 70 - i)).toISOString());
  // Roots: the two parents (ties) and one more with a lower number.
  await note("r0", null, -1, "2026-06-01T00:00:00Z", true);
  // Pointers: ties and a negative, under a parent and at the root.
  for (const [name, parent, target, sort] of [["p1", parentA, "a1", 2], ["p2", parentA, "a2", 2], ["p3", parentA, "a3", -1], ["p4", null, "a1", 0], ["p5", null, "a3", 0]] as const) {
    ids[name] = (await rows<{ id: string }>(
      `INSERT INTO note_pointers (workspace_id, parent_id, target_id, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`, [ws, parent, ids[target], sort]))[0]!.id;
  }
}, 120_000);
afterAll(async () => { await pg?.close(); });

const LIVE = "workspace_id = $1 AND deleted_at IS NULL";
const sidebarBefore = (parent: string | null) => idList(
  `SELECT id FROM content_nodes WHERE ${LIVE} AND parent_id IS NOT DISTINCT FROM $2 ORDER BY sort_order, created_at, id`, [ws, parent]);
// The old bootstrap query had no id tie-break (ties came back in any order, the client sorted them again); id is added so the comparison has one answer.
const bootstrapBefore = () => idList(`SELECT id FROM content_nodes WHERE ${LIVE} ORDER BY sort_order ASC, created_at ASC, id ASC`, [ws]);
const pointersBefore = (parent: string | null) => idList(
  `SELECT id FROM note_pointers WHERE workspace_id = $1 AND parent_id IS NOT DISTINCT FROM $2 ORDER BY sort_order, created_at, id`, [ws, parent]);
const allBefore = (parent: string | null) => idList(
  `SELECT id FROM content_nodes WHERE workspace_id = $1 AND parent_id IS NOT DISTINCT FROM $2 ORDER BY sort_order, created_at, id`, [ws, parent]);

const sidebarAfter = (parent: string | null) => idList(
  `SELECT n.id FROM content_nodes n WHERE n.${LIVE} AND n.parent_id IS NOT DISTINCT FROM $2 ORDER BY ${SIBLING_ORDER_N}`, [ws, parent]);
const bootstrapAfter = () => idList(`SELECT n.id FROM content_nodes n WHERE n.${LIVE} ORDER BY ${SIBLING_ORDER_N}`, [ws]);
const pointersAfter = (parent: string | null) => idList(
  `SELECT p.id FROM note_pointers p WHERE p.workspace_id = $1 AND p.parent_id IS NOT DISTINCT FROM $2 ORDER BY ${SIBLING_ORDER_P}`, [ws, parent]);
const allAfter = (parent: string | null) => idList(
  `SELECT n.id FROM content_nodes n WHERE n.workspace_id = $1 AND n.parent_id IS NOT DISTINCT FROM $2 ORDER BY ${SIBLING_ORDER_N}`, [ws, parent]);

describe.skipIf(!isTestDatabase())("migration 200 — order keys", () => {
  const parents = [null, parentA, parentB];
  const script = (name: string) => readFileSync(new URL(`../../scripts/${name}`, import.meta.url), "utf8");
  const before: { nodeCount: number; proof: unknown[]; preview: Array<Record<string, unknown>>; sidebar: string[][]; bootstrap: string[]; pointers: string[][]; all: string[][]; stamps: unknown[]; log: number; unsortedView: string[]; headerPreview: Array<Record<string, unknown>> } = {unsortedView: [], headerPreview: [],  nodeCount: 0, proof: [], preview: [], sidebar: [], bootstrap: [], pointers: [], all: [], stamps: [], log: 0 };
  const stampRows = () => rows(`SELECT table_name, row_key, field, origin, seq, hlc_wall, hlc_counter FROM sync_stamps WHERE workspace_id = $1 ORDER BY table_name, row_key, field`, [ws]);
  const logCount = async () => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM structure_log WHERE workspace_id = $1`, [ws]))[0]!.n;
  const migrationSql = async () => portableMigrationSql((await listMigrations()).find((m) => m.version.startsWith("200_"))!.sql);

  // Tests run in a random order, so the recording and the migration happen once, before any of them.
  beforeAll(async () => {
    before.sidebar = await Promise.all(parents.map(sidebarBefore));
    before.bootstrap = await bootstrapBefore();
    before.pointers = await Promise.all(parents.map(pointersBefore));
    before.all = await Promise.all(parents.map(allBefore));
    before.stamps = await stampRows();
    before.log = await logCount();
    // Taken BEFORE the migration, with the SQL a table with no sort used then; every row of the group is at manual number 0.
    before.unsortedView = await idList(`SELECT id FROM content_nodes WHERE ${LIVE} AND parent_id = $2 ORDER BY sort_order, title`, [ws, parentB]);
    expect((await rows<{ n: number }>(`SELECT count(DISTINCT sort_order)::int AS n FROM content_nodes WHERE ${LIVE} AND parent_id = $2`, [ws, parentB]))[0]!.n).toBe(1);
    before.proof = await rows(script("order-keys-proof-before.sql"));
    before.preview = await rows(script("order-keys-preview.sql"));
    // The preview a person pastes from the migration's header comment ("--   WITH g AS (" … "ORDER BY table_name;").
    const header = (await listMigrations()).find((m) => m.version.startsWith("200_"))!.sql.split("\n");
    const first = header.findIndex((line) => line.startsWith("--   WITH g AS ("));
    const last = header.findIndex((line, i) => i > first && line.endsWith("ORDER BY table_name;"));
    before.headerPreview = await rows(header.slice(first, last + 1).map((line) => line.replace(/^--\s{0,3}/, "")).join("\n"));
    before.nodeCount = (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM content_nodes`))[0]!.n;
    await pg.exec(await migrationSql());
  });

  it("the owner's read-only queries: the preview counts what the migration fills, and the proof query gives the same lines before and after", async () => {
    const nodes = before.preview.find((r) => r.table_name === "content_nodes")!;
    expect(Number(nodes.rows_to_fill)).toBe(before.nodeCount);
    expect(Number(nodes.longest_group)).toBe(70);
    expect(Number(nodes.groups_with_ties)).toBeGreaterThanOrEqual(2);
    const pointers = before.preview.find((r) => r.table_name === "note_pointers")!;
    expect(Number(pointers.rows_to_fill)).toBe(5);
    expect(Object.keys(nodes).sort()).toEqual(["groups", "groups_all_equal", "groups_with_ties", "live_groups", "live_groups_all_equal", "live_groups_with_ties", "longest_group", "longest_live_group", "rows_to_fill", "table_name"]);
    expect(Number(nodes.groups_all_equal)).toBeGreaterThanOrEqual(1); // the 70 rows at one number
    // The query in the migration's own header (what a person copies) gives the same numbers as the script.
    expect(before.headerPreview).toEqual(before.preview);
    // (Other tests of this file add workspaces of their own after the recording: compare this workspace's lines.)
    const mine = (lines: unknown[]) => lines.filter((r) => (r as { workspace: string }).workspace === ws);
    const after = await rows(script("order-keys-proof-after.sql"));
    expect(mine(after)).toEqual(mine(before.proof));
    expect(JSON.stringify(after)).not.toMatch(/Shelf|title/);
    expect(mine(before.proof).length).toBeGreaterThanOrEqual(7);
  });

  it("the data covers what the integer order allowed", () => {
    expect(before.stamps.length).toBeGreaterThan(0);
    expect(before.sidebar[1]!.length).toBe(7);
    expect(before.all[1]!.length).toBe(8);
    expect(before.pointers[1]!.length).toBe(3);
  });

  it("keeps every list in the identical order, trashed rows included", async () => {
    expect(await Promise.all(parents.map(sidebarAfter))).toEqual(before.sidebar);
    // The bootstrap lists the whole workspace in one go: compare each parent's rows, which is what a client sorts anyway.
    const boot = await bootstrapAfter();
    const live = await rows<{ id: string; parent_id: string | null }>(`SELECT id, parent_id FROM content_nodes WHERE ${LIVE}`, [ws]);
    for (const [i, parent] of parents.entries()) {
      const mine = new Set(before.sidebar[i]);
      const ofParent = new Set(live.filter((r) => r.parent_id === parent).map((r) => r.id));
      expect(boot.filter((id) => ofParent.has(id))).toEqual(before.bootstrap.filter((id) => mine.has(id)));
    }
    expect(await Promise.all(parents.map(pointersAfter))).toEqual(before.pointers);
    expect(await Promise.all(parents.map(allAfter))).toEqual(before.all);
  });

  it("a view or query with no sort lists the same rows in the same order as before: title (a whole group at one manual number)", async () => {
    // Before (captured above, pre-migration): ORDER BY sort_order, title — every row of the group has sort_order 0, so title decides.
    const was = before.unsortedView;
    const now = await idList(`SELECT n.id FROM content_nodes n WHERE n.${LIVE} AND n.parent_id = $2 ORDER BY ${UNSORTED_ORDER_N}`, [ws, parentB]);
    expect(now).toEqual(was);
    expect(now).not.toEqual(await sidebarAfter(parentB)); // title order differs from creation order here: the view did not follow the key
  });

  it("gives every row of both tables its own key within its group", async () => {
    const keys = await rows<{ order_key: string }>(`SELECT order_key FROM content_nodes WHERE workspace_id = $1 AND parent_id = $2`, [ws, parentB]);
    expect(new Set(keys.map((k) => k.order_key)).size).toBe(70);
    const pointerKeys = await rows<{ order_key: string }>(`SELECT order_key FROM note_pointers WHERE workspace_id = $1 AND parent_id = $2`, [ws, parentA]);
    expect(new Set(pointerKeys.map((k) => k.order_key)).size).toBe(3);
  });

  it("stamped and logged nothing, and the stamp on the old field carried over", async () => {
    expect(await stampRows()).toEqual(before.stamps);
    expect(await logCount()).toBe(before.log);
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM content_nodes WHERE workspace_id = $1 AND order_stamp <> ''`, [ws]))[0]!.n).toBe(0);
  });

  it("a rerun changes nothing", async () => {
    const snapshot = () => rows(`SELECT id, order_key, order_stamp FROM content_nodes WHERE workspace_id = $1 ORDER BY id`, [ws]);
    const was = await snapshot();
    await pg.exec(await migrationSql());
    expect(await snapshot()).toEqual(was);
  });

  it("the next move is one row, stamped and logged on the same field, with the stamp copied into the row", async () => {
    // Its own workspace: this test changes data the others compare.
    const other = (await rows<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Move', $1) RETURNING id`, [randomUUID()]))[0]!.id;
    const make = async (title: string) => (await rows<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, order_key) VALUES ($1, 'manual', 'content', $2, $2, '', $3) RETURNING id`,
      [other, title, title === "x" ? "a0" : "a1"]))[0]!.id;
    const x = await make("x"), y = await make("y");
    await pg.query(`UPDATE content_nodes SET order_key = 'a0V' WHERE id = $1`, [y]);
    const stamp = (await rows<{ hlc_wall: string; hlc_counter: number }>(`SELECT hlc_wall, hlc_counter FROM sync_stamps WHERE workspace_id = $1 AND row_key = $2 AND field = 'sort'`, [other, y]))[0]!;
    const row = (await rows<{ order_stamp: string }>(`SELECT order_stamp FROM content_nodes WHERE id = $1`, [y]))[0]!;
    expect(row.order_stamp).toBe(String(stamp.hlc_wall).padStart(15, "0") + String(stamp.hlc_counter).padStart(6, "0"));
    const logged = await rows<{ old_value: string; new_value: string }>(`SELECT old_value, new_value FROM structure_log WHERE workspace_id = $1 AND row_key = $2 AND field = 'sort' ORDER BY id`, [other, y]);
    expect(logged.at(-1)).toEqual({ old_value: "a1", new_value: "a0V" });
    // The other row was not touched: its place has no move in the log and its stamp field is its creation's.
    expect((await rows(`SELECT 1 FROM structure_log WHERE workspace_id = $1 AND row_key = $2 AND field = 'sort' AND old_value IS NOT NULL`, [other, x]))).toHaveLength(0);
  });

  it("the old integer is still in the table, unchanged, and a new row has none", async () => {
    expect((await rows<{ sort_order: number }>(`SELECT sort_order FROM content_nodes WHERE id = $1`, [ids.a6]))[0]!.sort_order).toBe(1000000);
    const fresh = randomUUID();
    const elsewhere = (await rows<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Fresh', $1) RETURNING id`, [randomUUID()]))[0]!.id;
    await pg.query(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, $2, 'manual', 'content', 'fresh', 'fresh', '')`, [fresh, elsewhere]);
    expect((await rows<{ sort_order: number | null }>(`SELECT sort_order FROM content_nodes WHERE id = $1`, [fresh]))[0]!.sort_order).toBeNull();
  });
});

describe.skipIf(!isTestDatabase())("the migration's SQL and the shared helper make the same keys", () => {
  it("evenOrderKeys equals what the backfill wrote (first 62, the next 3844 and one of the third kind)", async () => {
    const { evenOrderKeys } = await import("@onden/markdown/contract");
    const text = readFileSync(new URL("../../db/migrations/200_order_keys.sql", import.meta.url), "utf8");
    expect(text).toContain("order_key_even_tmp");
    const db = await openPglite({ dataDir: "memory://" });
    const fn = text.slice(text.indexOf("CREATE OR REPLACE FUNCTION order_key_even_tmp"), text.indexOf("DO $$"));
    await db.exec(fn);
    const ranks = [0, 1, 61, 62, 63, 3905, 3906, 3907, 3906 + 3844, 20_000];
    const got = (await db.query<{ r: number; k: string }>(`SELECT r, order_key_even_tmp(r) AS k FROM unnest($1::int[]) AS r`, [ranks])).rows;
    const want = evenOrderKeys(20_001);
    expect(got.map((g) => g.k)).toEqual(ranks.map((r) => want[r]));
    await db.close();
  });
});
