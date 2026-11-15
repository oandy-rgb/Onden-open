// Migration 144: the starter packs no longer stamp empty child notes, and the
// ones already stamped (and never touched) go to the trash. Fixtures are made
// the way production made them: a pack tag with template_children, applied to
// a note through createNote, so every creation event and marker is real.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { q } from "../db.js";
import { createNote } from "../services/noteCreate.js";
import { updateNode } from "../services/nodeUpdate.js";
import { installTagPackApproved, validateTagPack } from "../services/tagPacks.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(resolve(here, "../../db/migrations/144_remove_starter_template_children.sql"), "utf8");

// What the four starter packs shipped before this change.
const OLD_PACKS: Record<string, string[]> = {
  book: ["Summary", "Highlights", "Quotes", "Critique"],
  person: ["Conversations", "Things to remember", "Important dates"],
  meeting: ["Agenda", "Decisions", "Action items"],
  project: ["Tasks", "Decisions", "Meeting notes", "Retrospective"],
};

describe.skipIf(!isTestDatabase())("migration 144 — starter pack template children (DB)", () => {
  let ws = "";
  let actor: ActorCtx = { id: "m144-owner", name: "Owner", role: "admin", type: "human" };
  const tags: Record<string, string> = {};
  const notes: Record<string, string> = {};

  async function installTag(name: string, titles: string[]) {
    const checked = validateTagPack({
      _format: "onden.tagpack/v1", name, version: "1.0.0", fields: [],
      template_children: titles.map((title) => ({ title, body: "" })),
    });
    if (!checked.ok) throw new Error(checked.error);
    tags[name] = (await installTagPackApproved(ws, { actorId: actor.id, actorType: "user" }, checked.pack)).id;
  }
  async function tagged(key: string, tag: string) {
    notes[key] = (await createNote({
      actor, workspaceId: ws, title: key, markdown: "", tagIds: [tags[tag]!], event: { uiContext: "test.m144" },
    })).node.id as string;
  }
  async function child(parent: string, title: string): Promise<string> {
    const { rows } = await q<{ id: string }>(
      `SELECT id FROM content_nodes WHERE parent_id = $1 AND title = $2`, [notes[parent], title]);
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  }
  async function liveTitles(parent: string): Promise<string[]> {
    return (await q<{ title: string }>(
      `SELECT title FROM content_nodes WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY sort_order`, [notes[parent]],
    )).rows.map((r) => r.title);
  }
  const templateTitles = async (tag: string) => (await q<{ t: string[] }>(
    `SELECT ARRAY(SELECT e->>'title' FROM jsonb_array_elements(tag_schema->'template_children') e) AS t
       FROM content_nodes WHERE id = $1`, [tags[tag]])).rows[0]!.t;

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('M144', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(ws, actor);
    for (const [name, titles] of Object.entries(OLD_PACKS)) await installTag(name, titles);
    // A user's own template that merely shares two titles with a pack.
    await installTag("mine", ["Agenda", "Notes"]);

    await tagged("bookUntouched", "book");
    await tagged("meetingUntouched", "meeting");
    await tagged("projectUntouched", "project"); // "Decisions" is slot 1 here too
    await tagged("personUntouched", "person");
    await tagged("customTemplate", "mine");

    // A book where each child was touched in a different way.
    await tagged("bookTouched", "book");
    const bookTouched = (t: string) => child("bookTouched", t);
    await updateNode(ws, await bookTouched("Summary"), { markdown: "my summary" }, { actor });
    await updateNode(ws, await bookTouched("Highlights"), { title: "Best parts" }, { actor });
    await createNote({ actor, workspaceId: ws, title: "deeper", markdown: "", parentId: await bookTouched("Quotes"), event: { uiContext: "test.m144" } });
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, 'status', 'todo')`,
      [ws, await bookTouched("Critique")]);

    // Attribute value changed without an event, and a tag on the child: neither
    // can be shown untouched.
    await tagged("bookEdgy", "book");
    await seedQ(`UPDATE node_attributes SET value = 'x' WHERE node_id = $1 AND key = '_tpl_origin'`, [await child("bookEdgy", "Summary")]);
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [await child("bookEdgy", "Highlights"), tags.mine]);

    // Rows with the marker but no creation event at all (the history is gone):
    // nothing proves they were never edited.
    const orphanParent = randomUUID();
    notes.bookNoHistory = orphanParent;
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown)
             VALUES ($1, $2, 'manual', 'content', 'bookNoHistory', $3, '')`, [orphanParent, ws, `m144-${randomUUID()}`]);
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [orphanParent, tags.book]);
    const slug = (await q<{ s: string }>(`SELECT tag_schema->>'slug' AS s FROM content_nodes WHERE id = $1`, [tags.book])).rows[0]!.s;
    const orphanChild = randomUUID();
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id)
             VALUES ($1, $2, 'manual', 'content', 'Summary', $3, '', $4)`, [orphanChild, ws, `m144-${randomUUID()}`, orphanParent]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, '_tpl_origin', $3, 'derived')`,
      [ws, orphanChild, `${orphanParent}:${slug}:0`]);

    // The parent no longer carries the tag.
    await tagged("bookUntagged", "book");
    await seedQ(`DELETE FROM node_tags WHERE node_id = $1`, [notes.bookUntagged]);

    // A child whose title is not its slot's title in the tag's pack.
    await tagged("bookRetitled", "book");
    await seedQ(`UPDATE content_nodes SET title = 'Agenda' WHERE id = $1`, [await child("bookRetitled", "Summary")]);

    await seedQ(MIGRATION);
  });

  it("trashes the untouched children of each pack, by their own slot", async () => {
    expect(await liveTitles("bookUntouched")).toEqual([]);
    expect(await liveTitles("meetingUntouched")).toEqual([]);
    expect(await liveTitles("projectUntouched")).toEqual([]);
    expect(await liveTitles("personUntouched")).toEqual([]);
    const trashed = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM content_nodes WHERE parent_id = $1 AND deleted_at IS NOT NULL`, [notes.projectUntouched]);
    expect(trashed.rows[0]!.n).toBe("4");
  });

  it("trashes by soft delete with a NODE_DELETED event that undelete can use; nothing is purged", async () => {
    const row = (await q<{ id: string; deleted_by_event_id: string }>(
      `SELECT id, deleted_by_event_id FROM content_nodes WHERE parent_id = $1 AND title = 'Summary'`, [notes.bookUntouched])).rows[0]!;
    const event = (await q<{ event_type: string; actor_id: string; target_id: string; tx_meta: { inverse_op: string } }>(
      `SELECT event_type, actor_id, target_id, tx_meta FROM domain_events WHERE id = $1`, [row.deleted_by_event_id])).rows[0]!;
    expect(event).toMatchObject({ event_type: "NODE_DELETED", actor_id: "migration:144", target_id: row.id });
    expect(event.tx_meta.inverse_op).toBe("node.undeleted");
  });

  it("keeps a child that was edited, renamed, given a child or an attribute", async () => {
    expect(await liveTitles("bookTouched")).toEqual(["Summary", "Best parts", "Quotes", "Critique"]);
  });

  it("keeps a child it cannot show to be untouched", async () => {
    // Quotes and Critique, beside them, were plain, so they go.
    expect(await liveTitles("bookEdgy")).toEqual(["Summary", "Highlights"]);
    expect(await liveTitles("bookNoHistory")).toEqual(["Summary"]);
  });

  it("keeps the children of a note that no longer has the tag, and ones whose title is not their slot's", async () => {
    expect(await liveTitles("bookUntagged")).toEqual(["Summary", "Highlights", "Quotes", "Critique"]);
    expect(await liveTitles("bookRetitled")).toEqual(["Agenda"]); // the other three were plain
  });

  it("leaves a user's own template and its children alone, even with titles a pack uses", async () => {
    expect(await liveTitles("customTemplate")).toEqual(["Agenda", "Notes"]);
    expect(await templateTitles("mine")).toEqual(["Agenda", "Notes"]);
  });

  it("clears template_children on the pack tags, with an event that keeps the old list", async () => {
    for (const name of Object.keys(OLD_PACKS)) expect(await templateTitles(name)).toEqual([]);
    const event = (await q<{ tx_meta: { prev_field_values: { template_children: Array<{ title: string }> } } }>(
      `SELECT tx_meta FROM domain_events WHERE target_id = $1 AND event_type = 'TAG_SCHEMA_UPDATED' AND actor_id = 'migration:144'`,
      [tags.book])).rows[0]!;
    expect(event.tx_meta.prev_field_values.template_children.map((c) => c.title)).toEqual(OLD_PACKS.book);
  });

  it("is idempotent", async () => {
    const before = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1`, [ws])).rows[0]!.n;
    await seedQ(MIGRATION);
    const after = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1`, [ws])).rows[0]!.n;
    expect(after).toBe(before);
  });
});
