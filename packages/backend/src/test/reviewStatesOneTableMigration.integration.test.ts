// Migration 183: block_review_states moves into review_states (block_id). Every row arrives unchanged, the old table
// is gone, a second run changes nothing; a row is one card (a note or a block, never both or neither), one per person,
// and a deleted block or note still takes its schedules with it.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { q } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(resolve(here, "../../db/migrations/183_review_states_one_table.sql"), "utf8");
// The table as migration 120 made it: what a database before 183 holds.
const OLD_TABLE = readFileSync(resolve(here, "../../db/migrations/120_block_review_states.sql"), "utf8");

describe.skipIf(!isTestDatabase())("migration 183 — one review_states table (DB)", () => {
  let workspaceId = "";
  const note = async () => {
    const id = randomUUID();
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, $2, 'manual', 'content', 'M183', $3, '甲 {複習}')`,
      [id, workspaceId, `m183-${id.slice(0, 8)}`]);
    return id;
  };
  const block = async (noteId: string, ref: string) => (await seedQ<{ id: string }>(
    `INSERT INTO block_nodes (workspace_id, note_id, block_ref, kind, label, text_cache) VALUES ($1, $2, $3, 'paragraph', $3, $3) RETURNING id::text`,
    [workspaceId, noteId, ref])).rows[0]!.id;
  const rowsOf = async (blockIds: string[]) => (await q<{ block_id: string; actor_id: string; state: string; previous_state: string | null; updated_at: string }>(
    `SELECT block_id::text, actor_id, state, previous_state, updated_at::text FROM review_states WHERE block_id = ANY($1::uuid[]) ORDER BY block_id, actor_id`,
    [blockIds])).rows;

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('M183',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
  });

  it("moves every block schedule over unchanged, drops the old table, and can run again", async () => {
    const noteId = await note();
    const [a, b] = [await block(noteId, "a183"), await block(noteId, "b183")];
    await q(OLD_TABLE);
    const old = [
      [a, "p1", '{"reps":2}', '{"reps":1}', "2026-11-01 10:00:00+00"],
      [a, "p2", '{"reps":1}', null, "2026-11-02 11:00:00+00"],
      [b, "p1", "", null, "2026-11-03 12:00:00+00"],
    ] as const;
    for (const [id, actor, state, previous, at] of old) {
      await seedQ(`INSERT INTO block_review_states (workspace_id, block_id, actor_id, state, previous_state, updated_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [workspaceId, id, actor, state, previous, at]);
    }
    const before = (await q<{ block_id: string; actor_id: string; state: string; previous_state: string | null; updated_at: string }>(
      `SELECT block_id::text, actor_id, state, previous_state, updated_at::text FROM block_review_states WHERE block_id = ANY($1::uuid[]) ORDER BY block_id, actor_id`,
      [[a, b]])).rows;

    await seedQ(MIGRATION);
    expect(await rowsOf([a, b])).toEqual(before);
    expect((await q<{ t: string | null }>(`SELECT to_regclass('block_review_states')::text AS t`)).rows[0]!.t).toBeNull();

    await seedQ(MIGRATION);
    expect(await rowsOf([a, b])).toEqual(before);
  });

  it("a row is one card, once per person, and goes with its block or note", async () => {
    const noteId = await note();
    const c = await block(noteId, "c183");
    await seedQ(`INSERT INTO review_states (workspace_id, block_id, actor_id, state) VALUES ($1,$2,'p1','')`, [workspaceId, c]);
    await expect(seedQ(`INSERT INTO review_states (workspace_id, block_id, actor_id, state) VALUES ($1,$2,'p1','')`, [workspaceId, c])).rejects.toThrow();
    await expect(seedQ(`INSERT INTO review_states (workspace_id, actor_id, state) VALUES ($1,'p1','')`, [workspaceId])).rejects.toThrow();
    await expect(seedQ(`INSERT INTO review_states (workspace_id, node_id, block_id, actor_id, state) VALUES ($1,$2,$3,'p9','')`, [workspaceId, noteId, c])).rejects.toThrow();
    // A note's card and a block's card of the same person stand side by side.
    await seedQ(`INSERT INTO review_states (workspace_id, node_id, actor_id, state) VALUES ($1,$2,'p1','')`, [workspaceId, noteId]);

    await seedQ(`DELETE FROM block_nodes WHERE id = $1`, [c]);
    expect(await rowsOf([c])).toEqual([]);
    expect((await q(`SELECT 1 FROM review_states WHERE node_id = $1`, [noteId])).rowCount).toBe(1);
    await seedQ(`DELETE FROM content_nodes WHERE id = $1`, [noteId]);
    expect((await q(`SELECT 1 FROM review_states WHERE node_id = $1`, [noteId])).rowCount).toBe(0);
  });
});
