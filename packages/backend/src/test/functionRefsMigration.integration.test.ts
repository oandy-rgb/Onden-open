// Migration 166 (function references, B1): every tag's functions before and after are the same.
//
// The oracle is the pre-166 computation (helpers/legacyFunctions.ts: breadth-first over tag_schema.extends,
// nearest provider wins). The migration's backfill statement is run on tags written the old way (a module
// tag marker, the legacy behaviour.modules switch, extends to module tags, extends between user tags,
// cycles, missing and junk ids) in a workspace of its own, and every tag's functions and each function's
// settings source are compared. View functions (table/kanban/calendar/gallery) stay out of the table.
// The only expected difference from "before" is none: flattening user-tag extends copies what the old
// computation already gave the extending tag (docs/architecture/proposals/function-references-2026-11-02.md §9 Q1).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { legacyEffective, type LegacyTagRow } from "./helpers/legacyFunctions.js";
import { seedQ } from "./helpers/seedQ.js";

const VIEW = new Set(["table", "kanban", "calendar", "gallery"]);
const MIGRATION = readFileSync(new URL("../../db/migrations/166_function_refs.sql", import.meta.url), "utf8");
const FUNCTIONS = ["review", "read_later", "skills", "tasks_checkable", "calendar", "kanban"];

/** Deterministic PRNG (mulberry32) so a failing graph can be replayed from its seed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("migration 166 keeps every tag's functions", () => {
  const workspaces: string[] = [];
  afterAll(async () => { await q(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [workspaces]); });

  async function workspace(): Promise<string> {
    const id = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Migration 166', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    workspaces.push(id);
    return id;
  }
  async function tag(ws: string, id: string, schema: Record<string, unknown> | null, deleted = false): Promise<void> {
    await seedQ(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, tag_schema, deleted_at)
       VALUES ($1, $2, 'manual', 'class_tag', $3, $4, $5::jsonb, ${deleted ? "now()" : "NULL"})`,
      [id, ws, `t-${id.slice(0, 8)}`, `tag-${id}`, schema ? JSON.stringify(schema) : null],
    );
  }
  /** Run the backfill of migration 166 on one workspace's tags only (other tests share the database). */
  async function backfill(ws: string): Promise<void> {
    const scoped = MIGRATION.replace(
      "WHERE node_type = 'class_tag' AND deleted_at IS NULL\n),",
      `WHERE node_type = 'class_tag' AND deleted_at IS NULL AND workspace_id = '${ws}'\n),`,
    );
    expect(scoped).not.toBe(MIGRATION);
    await q(`DELETE FROM function_refs WHERE workspace_id = $1`, [ws]);
    await q(scoped);
  }
  async function compare(ws: string): Promise<void> {
    const rows = (await q<LegacyTagRow>(
      `SELECT id::text, tag_schema->>'module' AS module, tag_schema->'extends' AS extends, tag_schema->'behaviour' AS behaviour
         FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND deleted_at IS NULL`, [ws],
    )).rows;
    const before = legacyEffective(rows, (fn) => VIEW.has(fn));
    const after = new Map<string, Map<string, string>>();
    for (const row of (await q<{ holder: string; fn: string; source: string | null }>(
      `SELECT holder_node_id::text AS holder, function_id AS fn, config->>'source_tag_id' AS source
         FROM function_refs WHERE workspace_id = $1`, [ws],
    )).rows) {
      after.set(row.holder, (after.get(row.holder) ?? new Map()).set(row.fn, row.source ?? row.holder));
    }
    for (const row of rows) {
      expect([...(after.get(row.id) ?? new Map())].sort(), `tag ${row.id}`).toEqual([...(before.get(row.id) ?? new Map())].sort());
    }
  }

  it("module tag marker, legacy switch, extends to module tags, user-tag chains, cycles and junk", async () => {
    const ws = await workspace();
    const [review, readLater, calendar, mine, chain, loop1, loop2, ghost, trashed] = Array.from({ length: 9 }, () => randomUUID());
    await tag(ws, review!, { module: "review" });
    await tag(ws, readLater!, { module: "read_later" });
    await tag(ws, calendar!, { module: "calendar" });
    await tag(ws, mine!, { extends: [review, calendar, "not-an-id", 7, review], behaviour: { modules: { skills: { enabled: true }, tasks_checkable: { enabled: "yes" } } } });
    await tag(ws, chain!, { extends: [mine, readLater] });          // a user tag extending a user tag (flattened)
    await tag(ws, loop1!, { extends: [loop2], behaviour: { modules: { review: { enabled: true } } } });
    await tag(ws, loop2!, { extends: [loop1] });
    await tag(ws, ghost!, { extends: [randomUUID(), trashed] });    // missing and trashed targets contribute nothing
    await tag(ws, trashed!, { module: "review" }, true);
    await backfill(ws);
    await compare(ws);
    const refs = (await q<{ holder: string; fn: string }>(`SELECT holder_node_id::text AS holder, function_id AS fn FROM function_refs WHERE workspace_id = $1`, [ws])).rows;
    // A view module tag and whoever extends it get no reference (views move in B2); a flattened chain tag has both.
    expect(refs.some((r) => r.fn === "calendar")).toBe(false);
    expect(refs.filter((r) => r.holder === chain).map((r) => r.fn).sort()).toEqual(["read_later", "review", "skills"]);
    expect(refs.some((r) => r.holder === ghost)).toBe(false);
    // Running it again adds nothing (the migration can be repeated).
    const count = refs.length;
    await backfill(ws);
    expect((await q(`SELECT 1 FROM function_refs WHERE workspace_id = $1`, [ws])).rowCount).toBe(count);
  });

  it("random tag / function / extends graphs (property, seeded)", async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = rng(seed);
      const ws = await workspace();
      const ids = Array.from({ length: 2 + Math.floor(next() * 7) }, () => randomUUID());
      for (const id of ids) {
        const schema: Record<string, unknown> = {};
        if (next() < 0.35) schema.module = FUNCTIONS[Math.floor(next() * FUNCTIONS.length)];
        const targets = ids.filter(() => next() < 0.3);
        if (next() < 0.1) targets.push("junk" as never);
        if (targets.length) schema.extends = targets;
        const switches = FUNCTIONS.filter(() => next() < 0.2);
        if (switches.length) schema.behaviour = { modules: Object.fromEntries(switches.map((fn) => [fn, { enabled: next() < 0.8 }])) };
        await tag(ws, id, Object.keys(schema).length ? schema : null, next() < 0.1);
      }
      await backfill(ws);
      try { await compare(ws); } catch (error) { throw new Error(`seed ${seed}: ${(error as Error).message}`); }
    }
    // 40 runs of the backfill: ~1.5 s alone, past the 5 s default in a full real-PG run (not the table's size: 20 000
    // more nodes in another workspace leave it at 1.6 s), so the loop gets a budget of its own.
  }, 30_000);
});
