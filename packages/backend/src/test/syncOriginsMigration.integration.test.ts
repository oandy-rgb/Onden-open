// Migration 206 (db/migrations/206_sync_change_bundles.sql): additive, with a read-only preview, and the origins of workspaces that were joined before it come from their join record.
// SAFETY: only runs against a *_test database; skips otherwise. It runs the migration again on the shared test database (helpers/rerunMigration.ts puts the later migrations' functions back).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { rerunMigration } from "./helpers/rerunMigration.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("migration 206", () => {
  const preview = () => {
    const lines = readFileSync(join(import.meta.dirname, "../../db/migrations/206_sync_change_bundles.sql"), "utf8").split("\n");
    const from = lines.findIndex((l) => l.startsWith("-- Read-only preview"));
    const body: string[] = [];
    for (const l of lines.slice(from)) { if (l.trim() === "--   ;") break; if (l.startsWith("--   SELECT") || l.startsWith("--   UNION")) body.push(l.slice(5)); }
    return body.join("\n");
  };
  it("its preview is read-only and counts only; running it again rewrites no stamp and gives a joined workspace its source as an origin", async () => {
    const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Origins', $1) RETURNING id`, [`origins-${randomUUID()}`])).rows[0]!.id;
    const owner = (await q<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'Owner', 'human') RETURNING id::text`, [ws])).rows[0]!.id;
    await q(`INSERT INTO sync_join (workspace_id, source_node, cut_seq, state, person_actor_id) VALUES ($1, 'a-source-node', 41, 'done', $2)`, [ws, owner]);
    const read = async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        const r = await client.query(preview());
        await client.query("ROLLBACK");
        return r.rows as { part: string; rows: string; est_bytes: string }[];
      } finally { client.release(); }
    };
    const rows = await read();
    expect(rows.map((r) => r.part)).toEqual(["sync_origins rows made from finished joins", "sync_stamps rows rewritten"]);
    expect(Number(rows[0]!.rows)).toBe(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_join WHERE state = 'done'`)).rows[0]!.n));
    for (const r of rows) for (const v of Object.values(r)) expect(String(v)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);

    const stamps = async () => (await q<{ h: string }>(`SELECT md5(string_agg(concat_ws('/', workspace_id, table_name, row_key, field, origin, seq, saw::text, COALESCE(meta::text, '')), ',' ORDER BY workspace_id, table_name, row_key, field)) AS h FROM sync_stamps`)).rows[0]!.h;
    const before = await stamps();
    await rerunMigration("206_sync_change_bundles");
    expect(await stamps()).toBe(before); // nothing rewritten
    const origin = (await q<{ origin: string; vouched_by: string; have: Record<string, number> }>(`SELECT origin, vouched_by, have FROM sync_origins WHERE workspace_id = $1`, [ws])).rows;
    expect(origin).toEqual([{ origin: "a-source-node", vouched_by: "snapshot", have: { content_nodes: 41 } }]);
    await rerunMigration("206_sync_change_bundles"); // and again: the same
    expect((await q(`SELECT 1 FROM sync_origins WHERE workspace_id = $1`, [ws])).rows).toHaveLength(1);
    await q(`DELETE FROM sync_origins WHERE workspace_id = $1`, [ws]);
    await q(`DELETE FROM sync_join WHERE workspace_id = $1`, [ws]);
  });
});
