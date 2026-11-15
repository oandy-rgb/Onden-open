// Migration 192 (read-later removed): nothing is dropped silently.
//   • the "finished" table is renamed, rows intact;
//   • an untouched read-later tag with no notes goes to the trash (restorable, with its NODE_DELETED event);
//   • a tag with notes, or one the owner changed, stays as an ordinary tag with every note still on it;
//   • function references naming read_later are removed from other tags;
//   • running it again changes nothing.
//
// The real SQL runs in a transaction that is rolled back, so the shared test database is left as it was.
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { seedQ } from "./helpers/seedQ.js";

const MIGRATION = readFileSync(new URL("../../db/migrations/192_remove_read_later.sql", import.meta.url), "utf8");

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("migration 192 removes read-later without losing data", () => {
  const workspaces: string[] = [];
  const workspace = async () => {
    const id = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Migration 192', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    workspaces.push(id);
    return id;
  };
  const markedTag = async (ws: string, opts: { title?: string; markdown?: string; color?: string; fields?: unknown[]; parent?: string } = {}) => {
    const { tagId } = await seedClassTag(ws, { name: opts.title ?? "read-later", fields: opts.fields as never });
    await seedQ(
      `UPDATE content_nodes SET tag_schema = tag_schema || '{"module":"read_later"}'::jsonb, markdown = COALESCE($2, ''), tag_color = $3, parent_id = $4 WHERE id = $1`,
      [tagId, opts.markdown ?? null, opts.color ?? null, opts.parent ?? null]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'read_later', $2)`, [ws, tagId]);
    return tagId;
  };
  const note = async (ws: string, tagId: string) => {
    const id = randomUUID();
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug) VALUES ($1, $2, 'manual', 'content', $3, $3)`, [id, ws, `n-${id}`]);
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, tagId]);
    return id;
  };
  const row = async (id: string) => (await q<{ deleted_at: Date | null; deleted_by_event_id: string | null; tag_schema: Record<string, unknown> }>(
    `SELECT deleted_at, deleted_by_event_id::text, tag_schema FROM content_nodes WHERE id = $1`, [id])).rows[0]!;
  const rollback = new Error("rollback");
  const inRolledBackTransaction = async (body: () => Promise<void>) => {
    await expect(withTransaction(async () => { await body(); throw rollback; })).rejects.toBe(rollback);
  };

  afterAll(async () => { await q(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [workspaces]); });
  beforeAll(() => { expect(MIGRATION).toContain("read_later_done_removed_192"); });

  it("an untouched tag with no notes goes to the trash and can come back; the rest stays as ordinary tags", async () => {
    const empty = await workspace();
    const used = await workspace();
    const edited = await workspace();
    const unused = await markedTag(empty);
    const withNotes = await markedTag(used);
    const keptNote = await note(used, withNotes);
    const colored = await markedTag(edited, { color: "#ff0000" });
    const written = await markedTag(await workspace(), { markdown: "my own words" });
    const withField = await markedTag(await workspace(), { fields: [{ name: "from", type: "text" }] });
    const parent = await markedTag(await workspace());
    const child = (await seedClassTag((await q<{ workspace_id: string }>(`SELECT workspace_id FROM content_nodes WHERE id = $1`, [parent])).rows[0]!.workspace_id, { name: "child" })).tagId;
    await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [child, parent]);
    const renamed = await markedTag(await workspace(), { title: "reading list" });
    const otherTag = (await seedClassTag(used, { name: "course" })).tagId;
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'read_later', $2), ($1, 'review', $2)`, [used, otherTag]);

    await inRolledBackTransaction(async () => {
      await q(MIGRATION);
      const gone = await row(unused);
      expect(gone.deleted_at).not.toBeNull();
      expect(gone.deleted_by_event_id).not.toBeNull();
      expect(gone.tag_schema.module).toBeUndefined();
      const event = (await q<{ event_type: string; target_id: string }>(`SELECT event_type, target_id FROM domain_events WHERE id = $1`, [gone.deleted_by_event_id])).rows[0];
      expect(event).toEqual({ event_type: "NODE_DELETED", target_id: unused });

      for (const id of [withNotes, colored, written, withField, parent, renamed]) {
        const kept = await row(id);
        expect(kept.deleted_at, id).toBeNull();
        expect(kept.tag_schema.module, id).toBeUndefined();
      }
      expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [keptNote, withNotes])).rowCount).toBe(1);
      expect((await row(child)).deleted_at).toBeNull();
      // Other tags lose only the read_later reference.
      expect((await q<{ function_id: string }>(`SELECT function_id FROM function_refs WHERE holder_node_id = $1`, [otherTag])).rows).toEqual([{ function_id: "review" }]);
      expect((await q(`SELECT 1 FROM function_refs WHERE function_id = 'read_later' AND workspace_id = ANY($1::uuid[])`, [workspaces])).rowCount).toBe(0);

      // Running it again changes nothing.
      const before = (await q(`SELECT count(*)::int AS n FROM domain_events WHERE actor_id = 'migration:192' AND workspace_id = ANY($1::uuid[])`, [workspaces])).rows[0];
      await q(MIGRATION);
      expect((await q(`SELECT count(*)::int AS n FROM domain_events WHERE actor_id = 'migration:192' AND workspace_id = ANY($1::uuid[])`, [workspaces])).rows[0]).toEqual(before);
    });
  });

  it("renames the old table and keeps its rows; a table already renamed is left alone", async () => {
    const ws = await workspace();
    const a = await markedTag(ws);
    const target = await note(ws, a);
    await inRolledBackTransaction(async () => {
      await q(`DROP TABLE IF EXISTS read_later_done_removed_192`);
      await q(`CREATE TABLE read_later_done (node_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE, actor_id text NOT NULL, done_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (node_id, actor_id))`);
      await q(`INSERT INTO read_later_done (node_id, actor_id) VALUES ($1, 'someone')`, [target]);
      await q(MIGRATION);
      expect((await q(`SELECT to_regclass('public.read_later_done') AS t`)).rows[0]).toEqual({ t: null });
      expect((await q(`SELECT node_id::text, actor_id FROM read_later_done_removed_192`)).rows).toEqual([{ node_id: target, actor_id: "someone" }]);
      await q(MIGRATION);
      expect((await q(`SELECT 1 FROM read_later_done_removed_192`)).rowCount).toBe(1);
    });
  });
});
