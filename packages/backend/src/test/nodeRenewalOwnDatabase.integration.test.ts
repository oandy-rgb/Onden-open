// Migration 213 sync_renew_node_id() on the database this process has, a real Postgres included (the multi-database cases are
// nodeRenewal.integration.test.ts, PGlite only). The renewal and a write after it run in one transaction that is then rolled back, so the shared
// test database keeps its node id; the workspace is this test's own. A file of its own: the node tests repoint the process's database handle.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowUnstampedWrite, q, withTransaction } from "../db.js";
import { haveOfAll } from "../spine/stampedBundle.js";
import { seedQ } from "./helpers/seedQ.js";

const anyTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const DB = join(import.meta.dirname, "..", "..", "db");
type Renewal = { old_node_id: string | null; new_node_id: string; workspaces: string; origins_added: string };
const notBefore = (a: readonly [number, number], b: readonly [number, number]) => a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);

describe("migration 213 on a fresh install", () => {
  it("schema.sql defines sync_take_node_id() and sync_renew_node_id() exactly as migration 213 does", () => {
    const fns = (text: string) => text.slice(text.indexOf("CREATE OR REPLACE FUNCTION sync_take_node_id()"), text.lastIndexOf("$$ LANGUAGE plpgsql;") + "$$ LANGUAGE plpgsql;".length);
    const migration = readFileSync(join(DB, "migrations", "213_renew_node_id.sql"), "utf8");
    const schema = readFileSync(join(DB, "schema.sql"), "utf8");
    expect(fns(migration)).toMatch(/sync_renew_node_id\(\)/);
    expect(schema).toContain(fns(migration));
  });
});

describe.skipIf(!anyTestDb)("the renewal on this process's own database (real Postgres too), rolled back", () => {
  it("keeps every stamp, numbers from 1, records the old id as held, and the next write is the new origin's number 1", async () => {
    const ws = (await seedQ<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Renewal', $1) RETURNING id::text`, [`renewal-${randomUUID()}`])).rows[0]!.id;
    for (const n of [1, 2, 3]) await seedQ(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, 'manual', 'content', $2, $3, '')`, [ws, `note ${n}`, `renewal-note-${n}`]);
    const idBefore = (await q<{ node_id: string }>(`SELECT node_id FROM sync_node`)).rows[0]!.node_id;
    const stampsOf = async () => (await q<{ r: string }>(`SELECT to_jsonb(s)::text AS r FROM sync_stamps s WHERE workspace_id = $1 ORDER BY table_name, row_key, field`, [ws])).rows.map((r) => r.r);
    const clockOf = async () => (await q<{ next_seq: string; hlc_wall: string; hlc_counter: number }>(`SELECT next_seq::text, hlc_wall::text, hlc_counter FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0]!;
    const stamps = await stampsOf(), clock = await clockOf();
    expect(Number(clock.next_seq)).toBe(5); // the workspace and the three notes: four writes, four numbers of this node
    class RolledBack extends Error {}
    await expect(allowUnstampedWrite("test: a write after the renewal, rolled back", () => withTransaction(async () => {
      const r = (await q<Renewal>(`SELECT * FROM sync_renew_node_id()`)).rows[0]!;
      expect(r.old_node_id).toBe(idBefore);
      expect(r.new_node_id).not.toBe(idBefore);
      expect(await stampsOf()).toEqual(stamps);
      expect(await clockOf()).toEqual({ ...clock, next_seq: "1" });
      expect((await q(`SELECT vouched_by, have FROM sync_origins WHERE workspace_id = $1 AND origin = $2`, [ws, idBefore])).rows).toEqual([{ vouched_by: "self-restore", have: haveOfAll(4) }]);
      await q(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, 'manual', 'content', 'after', 'renewal-after', '')`, [ws]);
      const next = (await q<{ origin: string; seq: string; hlc_wall: string; hlc_counter: number }>(`SELECT origin, seq::text, hlc_wall::text, hlc_counter FROM sync_stamps WHERE workspace_id = $1 AND origin <> $2 AND origin <> 'genesis'`, [ws, idBefore])).rows;
      expect(next.length).toBeGreaterThan(0);
      for (const s of next) {
        expect([s.origin, s.seq]).toEqual([r.new_node_id, "1"]);
        expect(notBefore([Number(s.hlc_wall), s.hlc_counter], [Number(clock.hlc_wall), clock.hlc_counter + 1])).toBe(true);
      }
      throw new RolledBack();
    }))).rejects.toBeInstanceOf(RolledBack);
    expect((await q<{ node_id: string }>(`SELECT node_id FROM sync_node`)).rows[0]!.node_id).toBe(idBefore);
    expect(await clockOf()).toEqual(clock);
  });
});
