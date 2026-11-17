// Migration 209 (a note's place is one write; a tag's schema keys count for updated_at; the module sets are stored sorted): its read-only preview, a second run, that it
// rewrites no existing row or stamp, and what the new definition of sync_touch_updated_at gives for notes that already have data, next to 206's definition.
// One database (the shared test database); runs on PGlite and on a real Postgres.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { pool, q, withTransaction } from "../db.js";
import { rerunMigration } from "./helpers/rerunMigration.js";
import { buildSourceWorld } from "./helpers/stampedWorld.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const MIGRATION = join(import.meta.dirname, "../../db/migrations/209_place_is_one_write.sql");

/** The preview query in the header: the comment lines after `-- Read-only preview` up to the line that is only `--   ;`. */
function preview(): string {
  const lines = readFileSync(MIGRATION, "utf8").split("\n");
  const from = lines.findIndex((l) => l.startsWith("-- Read-only preview"));
  const body: string[] = [];
  for (const l of lines.slice(from + 1)) { if (l.trim() === "--   ;") break; if (l.startsWith("--  ")) body.push(l.slice(4)); }
  return body.join("\n");
}

/** Everything 209 could have touched, as one text per table: the stamps, the notes' columns it speaks of, the module sets. */
async function state(): Promise<string> {
  const parts = await Promise.all([
    q<{ h: string }>(`SELECT md5(string_agg(concat_ws('/', workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, saw::text, COALESCE(meta::text, '~')), ',' ORDER BY workspace_id, table_name, row_key, field)) AS h FROM sync_stamps`),
    q<{ h: string }>(`SELECT md5(string_agg(concat_ws('/', id, order_key, order_stamp, updated_at), ',' ORDER BY id)) AS h FROM content_nodes`),
    q<{ h: string }>(`SELECT md5(string_agg(concat_ws('/', id, modules_off::text, modules_confirmed::text), ',' ORDER BY id)) AS h FROM workspaces`),
  ]);
  return parts.map((p) => p.rows[0]!.h).join("|");
}

describe.skipIf(!isTestDb)("migration 209", () => {
  let world!: Awaited<ReturnType<typeof buildSourceWorld>>;
  beforeAll(async () => { world = await buildSourceWorld(null); }, 120_000); // one world (its people and invitations are unique per database)
  it("the preview runs in a read-only transaction and answers counts only; it rewrites nothing", async () => {
    const client = await pool.connect();
    let rows: { part: string; rows: string; est_bytes: string }[];
    try {
      await client.query("BEGIN READ ONLY");
      rows = (await client.query(preview())).rows;
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect(rows.map((r) => r.part)).toEqual([
      "notes whose parent stamp is newer than their order-key stamp (read as before, not rewritten)",
      "notes whose updated_at the new definition gives differently at their next write",
      "per-section stamps of board frames left as they are (no longer made, not copied)",
      "sync_stamps rows rewritten",
    ]);
    expect(rows[3]!.rows).toBe("0");
    for (const r of rows) expect(r.rows, r.part).toMatch(/^\d+$/);
    for (const r of rows) for (const v of Object.values(r)) expect(String(v)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no id
  });

  it("runs a second time without error and without changing a stamp, a note's place, its updated_at or a module set: only writes from now on are affected", async () => {
    const before = await state();
    await rerunMigration("209_place_is_one_write");
    expect(await state()).toBe(before);
  });

  it("the new sync_touch_updated_at against 206's on notes that already have data: they differ exactly for the notes whose tag-schema keys were written after their last counted unit", async () => {
    // a tag whose schema is written after everything else of it (the json trigger stamps the key; 209 counts it)
    const tag = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND deleted_at IS NULL ORDER BY id LIMIT 1`, [world.ws])).rows[0]!.id;
    await new Promise((r) => setTimeout(r, 20));
    await withTransaction(() => q(`UPDATE content_nodes SET tag_schema = COALESCE(tag_schema, '{}'::jsonb) || '{"probe_209": {"type": "text"}}'::jsonb WHERE id = $1`, [tag]));
    const counted = (labels: string) => `SELECT max(w) FROM (
        SELECT hlc_wall AS w FROM sync_stamps s WHERE s.workspace_id = n.workspace_id AND s.table_name IN (${labels}) AND s.row_key = n.id::text AND s.origin <> 'genesis' AND s.field NOT IN ('*', 'sort') AND COALESCE(s.meta->>'quiet', '') <> 'true'
        UNION ALL SELECT hlc_wall FROM sync_stamp_heads h WHERE h.workspace_id = n.workspace_id AND h.table_name IN (${labels}) AND h.row_key = n.id::text AND h.origin <> 'genesis' AND h.field NOT IN ('*', 'sort') AND COALESCE(h.meta->>'quiet', '') <> 'true') x`;
    const rows = (await q<{ id: string; old: string | null; now: string | null; schema_after: boolean }>(
      `SELECT n.id::text, (${counted("'content_nodes'")})::text AS old, (${counted("'content_nodes', 'content_nodes.tag_schema'")})::text AS now,
              COALESCE((SELECT max(hlc_wall) FROM sync_stamps s WHERE s.workspace_id = n.workspace_id AND s.table_name = 'content_nodes.tag_schema' AND s.row_key = n.id::text AND s.origin <> 'genesis'), 0)
                > COALESCE((${counted("'content_nodes'")}), 0) AS schema_after
         FROM content_nodes n WHERE n.workspace_id = $1`, [world.ws])).rows;
    const differ = rows.filter((r) => r.old !== r.now).map((r) => r.id).sort();
    const expected = rows.filter((r) => r.schema_after).map((r) => r.id).sort();
    expect(differ).toEqual(expected);
    expect(differ).toContain(tag); // not vacuous
    // and the preview the owner runs before deploying counts them (every workspace of the database: at least this one's)
    const counted209 = Number((await q<{ part: string; rows: string }>(preview())).rows.find((r) => r.part.startsWith("notes whose updated_at"))!.rows);
    expect(counted209).toBeGreaterThanOrEqual(differ.length);
    console.log(`[209 updated_at] ${rows.length} notes, ${differ.length} differ (all of them tags whose schema keys were written after their last counted unit)`);
  });
});
