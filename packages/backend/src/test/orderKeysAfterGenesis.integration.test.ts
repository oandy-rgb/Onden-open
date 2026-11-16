// Migration 200 on a database that already took 201 and 202 (production's state before this upgrade), and on a new install
// where 200 runs before 202. 202 could not baseline the place (nothing logged it yet); 200's last step must, and
// both orders must end in the same structure_log lines. Own PGlite database each (real Postgres: the migrations themselves are
// covered by orderKeysMigration.integration.test.ts and genesisStampsMigration.integration.test.ts).
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openPglite } from "../dbPglite.js";
import { listMigrations, portableMigrationSql } from "../dbMigrations.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

type Row = Record<string, unknown>;
const migration = async (prefix: string) => portableMigrationSql((await listMigrations()).find((m) => m.version.startsWith(prefix))!.sql);

async function database(apply: (pg: PGlite, run: (prefix: string) => Promise<void>) => Promise<void>): Promise<PGlite> {
  const pg = await openPglite({ dataDir: "memory://" });
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm");
  await apply(pg, async (prefix) => { await pg.exec(await migration(prefix)); });
  return pg;
}
/** Every migration except these, in order. */
async function applyAllBut(pg: PGlite, skip: string[], upTo = "999"): Promise<void> {
  for (const m of await listMigrations()) {
    if (m.version.slice(0, 3) > upTo || skip.some((s) => m.version.startsWith(s))) continue;
    await pg.exec(portableMigrationSql(m.sql));
  }
}
async function seed(pg: PGlite, withKey: boolean): Promise<string> {
  const ws = ((await pg.query<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Genesis order', $1) RETURNING id`, [randomUUID()])).rows[0]!).id;
  const parent = randomUUID();
  const notes: Array<[string, string | null, number, string]> = [
    ["P", null, 0, parent], ["c1", parent, 0, randomUUID()], ["c2", parent, 0, randomUUID()], ["c3", parent, 5, randomUUID()], ["t", parent, 1, randomUUID()],
  ];
  for (const [name, p, sort, id] of notes) {
    await pg.query(
      withKey
        ? `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id, order_key, deleted_at)
           VALUES ($1, $2, 'manual', 'content', $3, $4, '', $5, $6, ${name === "t" ? "now()" : "NULL"})`
        : `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id, sort_order, deleted_at)
           VALUES ($1, $2, 'manual', 'content', $3, $4, '', $5, $6, ${name === "t" ? "now()" : "NULL"})`,
      [id, ws, name, `s-${name}`, p, withKey ? `a${sort}` : sort]);
  }
  return ws;
}
const placeLines = async (pg: PGlite, ws: string) => (await pg.query<Row>(
  `SELECT row_key, new_value, origin FROM structure_log WHERE workspace_id = $1 AND table_name = 'content_nodes' AND field = 'sort' ORDER BY id`, [ws])).rows;
/** The key each note has by folding the log in id order (the replay the log's tests use) next to the table. */
async function replayProblems(pg: PGlite, ws: string): Promise<string[]> {
  const replayed = new Map<string, unknown>();
  for (const l of await placeLines(pg, ws)) replayed.set(String(l.row_key), l.new_value);
  const now = (await pg.query<{ id: string; order_key: string }>(`SELECT id, order_key FROM content_nodes WHERE workspace_id = $1`, [ws])).rows;
  return now.filter((n) => replayed.get(n.id) !== n.order_key).map((n) => `${n.id}: log says ${String(replayed.get(n.id))}, row has ${n.order_key}`);
}
const passResult = async (pg: PGlite) => (await pg.query<Row>(`SELECT stamps_added::int AS s, baseline_lines_added::int AS l, markers_added::int AS m FROM sync_genesis_pass()`)).rows[0]!;

describe.skipIf(!isTestDatabase())("migration 200 and the genesis baseline (202)", () => {
  let after202: PGlite; let ws202 = ""; let preview: Row[] = []; let headerPreview: Row[] = []; let linesBefore200 = 0; let linesAfter200 = 0; let markerCount = 0; let nodeCount = 0; let linesAfterRerun = 0; let passAfterRerun: Row = {};
  let before202: PGlite; let wsNew = "";

  beforeAll(async () => {
    // (a) Production's state: 201 and 202 applied, 200 not; the baseline holds the integers.
    after202 = await database(async (pg) => {
      await applyAllBut(pg, ["200", "202", "203"], "201");
      ws202 = await seed(pg, false);
      await pg.exec(await migration("202"));
    });
    linesBefore200 = (await placeLines(after202, ws202)).length;
    nodeCount = Number((await after202.query<{ n: number }>(`SELECT count(*)::int AS n FROM content_nodes`)).rows[0]!.n);
    preview = (await after202.query<Row>(readFileSync(new URL("../../scripts/order-keys-preview.sql", import.meta.url), "utf8"))).rows;
    const header = (await listMigrations()).find((m) => m.version.startsWith("200_"))!.sql.split("\n");
    const first = header.findIndex((line) => line.startsWith("--   WITH g AS ("));
    const last = header.findIndex((line, i) => i > first && line.endsWith("ORDER BY table_name;"));
    headerPreview = (await after202.query<Row>(header.slice(first, last + 1).map((line) => line.replace(/^--\s{0,3}/, "")).join("\n"))).rows;
    await after202.exec(await migration("200"));
    linesAfter200 = (await placeLines(after202, ws202)).length;
    markerCount = (await after202.query(`SELECT 1 FROM structure_log WHERE workspace_id = $1 AND table_name = 'baseline' AND row_key = 'content_nodes' AND field = 'sort'`, [ws202])).rows.length;
    await after202.exec(await migration("200"));
    linesAfterRerun = (await placeLines(after202, ws202)).length;
    passAfterRerun = await passResult(after202);
    // (b) A new install's order: 200 before 202 (the function does not exist when 200 ends), rows there, then 202.
    before202 = await database(async (pg) => {
      await applyAllBut(pg, ["202", "203"], "201");
      wsNew = await seed(pg, true);
      await pg.exec(await migration("202"));
    });
  }, 180_000);
  afterAll(async () => { await after202?.close(); await before202?.close(); });

  it("the read-only preview runs on a database that has 201 and 202 but not 200, and counts the rows 200 will fill", () => {
    const nodes = preview.find((r) => r.table_name === "content_nodes")!;
    expect(Number(nodes.rows_to_fill)).toBe(nodeCount);
    expect(Number(nodes.groups_all_equal)).toBe(0);
    expect(Number(nodes.groups_with_ties)).toBeGreaterThanOrEqual(1);
    expect(headerPreview).toEqual(preview);
  });

  it("202 wrote no baseline of the place (nothing logged it before 200); 200's last step baselines the keys and the pass has nothing left to add", async () => {
    expect(linesBefore200).toBe(0);
    expect(linesAfter200).toBe(5);
    expect(await replayProblems(after202, ws202)).toEqual([]);
    expect(new Set((await placeLines(after202, ws202)).map((l) => l.origin))).toEqual(new Set(["genesis"]));
    expect(markerCount).toBe(1);
    expect(await passResult(after202)).toEqual({ s: 0, l: 0, m: 0 });
  });

  it("running 200 again adds no line", () => {
    expect(linesAfterRerun).toBe(linesAfter200);
    expect(passAfterRerun).toEqual({ s: 0, l: 0, m: 0 });
  });

  it("the other order (200, then rows, then 202) gives the baseline of the keys, and the pass has nothing left to add", async () => {
    const lines = await placeLines(before202, wsNew);
    expect(lines).toHaveLength(10); // the insert trigger's 5 (200 was already in) + 202's baseline of the keys, 5
    expect(await replayProblems(before202, wsNew)).toEqual([]);
    expect(await passResult(before202)).toEqual({ s: 0, l: 0, m: 0 });
    // Same final answer in both orders: the last line of every note is the key it has.
    const lastLine = async (pg: PGlite, ws: string) => (await pg.query<{ k: string }>(
      `SELECT string_agg(order_key, ',' ORDER BY title) AS k FROM content_nodes WHERE workspace_id = $1`, [ws])).rows[0]!.k;
    expect((await lastLine(after202, ws202)).split(",")).toHaveLength((await lastLine(before202, wsNew)).split(",").length);
  });
});
