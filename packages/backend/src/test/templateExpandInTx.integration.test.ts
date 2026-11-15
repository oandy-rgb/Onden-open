// Template expansion inside the caller's transaction (W29): it reads the tag
// through the same transaction (a tag created moments ago in it expands), and
// each slot is its own savepoint, so a failing slot is recorded and skipped
// while the other slots and the tag application stand.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { q, withTransaction } from "../db.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { expandTemplate } from "../services/templateExpander.js";
import { localDayId } from "../localDay.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("template expansion in the caller's transaction (DB)", () => {
  let ws = "";
  let actor: ActorCtx = { id: `tpl-${randomUUID().slice(0, 6)}`, name: "Owner", role: "admin", type: "human" };
  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Tpl tx', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(ws, actor);
  });

  const children = (parent: string) => q<{ title: string }>(
    `SELECT title FROM content_nodes WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY title`, [parent]);

  it("expands a tag created earlier in the same transaction, and a slot failing in SQL doesn't sink the others", async () => {
    const slug = `tpl-${randomUUID().slice(0, 8)}`;
    // A real SQL failure for one slot: a trigger rejecting its title.
    const fn = `tpl_reject_${slug.replace(/-/g, "_")}`;
    await q(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.title = 'Broken ${slug}' THEN RAISE EXCEPTION 'slot rejected'; END IF; RETURN NEW; END $$`);
    await q(`CREATE TRIGGER ${fn} BEFORE INSERT ON content_nodes FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
    let parent = "";
    await withEventTransaction(ws, () => withTransaction(async () => {
      const tag = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
         VALUES ($1,'manual','class_tag',$2,$2,'',$3) RETURNING id`,
        [ws, slug, JSON.stringify({ slug, fields: [], template_children: [
          { title: "Notes" },
          // Fails in SQL (the trigger below): its savepoint rolls back alone.
          { title: `Broken ${slug}` },
          { title: "Sources" },
        ] })])).rows[0]!.id;
      parent = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1,'manual','content','Course',$2,'') RETURNING id`, [ws, `course-${slug}`])).rows[0]!.id;
      await expandTemplate(ws, parent, tag, actor);
    }));
    expect((await children(parent)).rows.map((r) => r.title)).toEqual(["Notes", "Sources"]);
    const failed = await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND event_type = 'TAG_TEMPLATE_SLOT_FAILED' AND target_id = $2`, [ws, parent]);
    expect(failed.rows).toHaveLength(1);
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${fn} ON content_nodes`);
      await q(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });

  it("a slot's body gets the derived state createNote gives any new note (links, backup)", async () => {
    const slug = `tpl-body-${randomUUID().slice(0, 8)}`;
    const target = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$2,'') RETURNING id`, [ws, `Target ${slug}`])).rows[0]!.id;
    let parent = "";
    await withEventTransaction(ws, () => withTransaction(async () => {
      const tag = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
         VALUES ($1,'manual','class_tag',$2,$2,'',$3) RETURNING id`,
        [ws, slug, JSON.stringify({ slug, fields: [], template_children: [
          { title: "Reading", body: `See [[Target ${slug}]] first. ^start` },
        ] })])).rows[0]!.id;
      parent = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1,'manual','content','Course',$2,'') RETURNING id`, [ws, `course-${slug}`])).rows[0]!.id;
      await expandTemplate(ws, parent, tag, actor);
    }));
    const child = (await q<{ id: string }>(`SELECT id FROM content_nodes WHERE parent_id = $1`, [parent])).rows[0]!.id;
    const edge = await q(`SELECT 1 FROM node_edges WHERE source_node_id = $1 AND target_node_id = $2 AND origin = 'wikilink'`, [child, target]);
    expect(edge.rows).toHaveLength(1);
    const backup = await q(`SELECT 1 FROM outbox WHERE workspace_id = $1 AND effect_kind = 'git_commit' AND dedup_key = $2`, [ws, `git_commit:${child}`]);
    expect(backup.rows).toHaveLength(1);
  });

  it("{date} / {datetime} in a slot's title and body expand as in the app's templates (D69)", async () => {
    const slug = `tpl-date-${randomUUID().slice(0, 8)}`;
    let parent = "";
    await withEventTransaction(ws, () => withTransaction(async () => {
      const tag = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
         VALUES ($1,'manual','class_tag',$2,$2,'',$3) RETURNING id`,
        [ws, slug, JSON.stringify({ slug, fields: [], template_children: [
          { title: "Minutes {date}", body: "Started {datetime}; {other} stays" },
        ] })])).rows[0]!.id;
      parent = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1,'manual','content','Standup',$2,'') RETURNING id`, [ws, `standup-${slug}`])).rows[0]!.id;
      await expandTemplate(ws, parent, tag, actor);
    }));
    const today = localDayId();
    const child = (await q<{ title: string; markdown: string }>(
      `SELECT title, markdown FROM content_nodes WHERE parent_id = $1`, [parent])).rows[0]!;
    expect(child.title).toBe(`Minutes ${today}`);
    expect(child.markdown).toMatch(new RegExp(`^Started ${today} \\d{2}:\\d{2}; \\{other\\} stays`));
  });
});
