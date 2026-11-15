// Migration 195: review cards are notes and paragraphs that carry their own function reference; a tag no longer makes cards.
// A workspace in the OLD shape (notes and paragraphs members of a tag that provided review: the module tag, a tag that extended it,
// a tag with the legacy switch) must lose no card and no schedule. The old shape is seeded by hand on the current schema; the
// migration file is then run, which is also what re-running it after an upgrade does.
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";
import { persistActor } from "./helpers/persistActor.js";
import { buildSyncDelta } from "../services/sync/index.js";
import type { ActorCtx } from "../types.js";

const MIGRATION = readFileSync(new URL("../../db/migrations/195_review_into_function_refs.sql", import.meta.url), "utf8");

describe.skipIf(!isTestDatabase())("migration 195 — review into function references (DB)", () => {
  let ws = "";
  let other = "";
  let owner: ActorCtx = { id: "", name: "Owner", role: "admin", type: "human" };
  let since = 0;
  const id: Record<string, string> = {};

  async function tag(key: string, title: string, schema: object, workspace = ws) {
    id[key] = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, tag_schema)
       VALUES ($1, 'manual', 'class_tag', $2, $3, $4::jsonb) RETURNING id::text`, [workspace, title, `tag-${randomUUID()}`, JSON.stringify(schema)])).rows[0]!.id;
  }
  async function note(key: string, opts: { type?: string; deleted?: boolean; hidden?: boolean; tags?: string[]; workspace?: string } = {}) {
    id[key] = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden, deleted_at)
       VALUES ($1, 'manual', $2, $3, $4, 'body', $5, ${opts.deleted ? "now()" : "NULL"}) RETURNING id::text`,
      [opts.workspace ?? ws, opts.type ?? "content", key, `n-${randomUUID()}`, opts.hidden ?? false])).rows[0]!.id;
    for (const t of opts.tags ?? []) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id[key], id[t]]);
  }
  async function block(key: string, noteKey: string, tags: string[], hidden = false) {
    id[key] = (await seedQ<{ id: string }>(
      `INSERT INTO block_nodes (workspace_id, note_id, block_ref, kind, label, hidden_at) VALUES ($1, $2, $3, 'paragraph', $4, ${hidden ? "now()" : "NULL"}) RETURNING id::text`,
      [ws, id[noteKey], `b${randomUUID().slice(0, 8)}`, key])).rows[0]!.id;
    for (const t of tags) await seedQ(`INSERT INTO block_node_tags (block_node_id, tag_id, workspace_id) VALUES ($1, $2, $3)`, [id[key], id[t], ws]);
  }
  const noteRef = async (key: string) => (await q(`SELECT 1 FROM function_refs WHERE holder_node_id = $1 AND function_id = 'review' AND instance = ''`, [id[key]])).rowCount;
  const blockRef = async (key: string) => (await q(`SELECT 1 FROM function_refs WHERE holder_block_id = $1 AND function_id = 'review'`, [id[key]])).rowCount;
  const tagRefs = async (key: string) => (await q(`SELECT 1 FROM function_refs WHERE holder_node_id = $1 AND function_id = 'review'`, [id[key]])).rowCount;

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('M195', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    other = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('M195b', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(ws, owner);

    await tag("module", "review", { name: "review", module: "review" });
    await tag("extender", "Course", { name: "Course", extends: [] });
    await tag("legacy", "Legacy", { name: "Legacy", behaviour: { modules: { review: { enabled: true } } } });
    await tag("plain", "Plain", { name: "Plain" });
    await tag("deadSource", "Dead source", { name: "Dead source" });
    await tag("goneTag", "Gone", { name: "Gone" });
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [id.goneTag]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'review', $2)`, [ws, id.module]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id, config) VALUES ($1, 'review', $2, $3::jsonb)`, [ws, id.extender, JSON.stringify({ source_tag_id: id.module })]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'review', $2)`, [ws, id.legacy]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id, config) VALUES ($1, 'review', $2, $3::jsonb)`, [ws, id.deadSource, JSON.stringify({ source_tag_id: id.goneTag })]);

    await note("byModule", { tags: ["module"] });
    await note("byExtender", { tags: ["extender"] });
    await note("byLegacy", { tags: ["legacy"] });
    await note("byBoth", { tags: ["module", "extender"] });
    await note("trashedCard", { deleted: true, tags: ["module"] });
    await note("plainOnly", { tags: ["plain"] });
    await note("deadSourceOnly", { tags: ["deadSource"] });
    await note("aBoard", { type: "canvas", tags: ["module"] });
    await note("untagged");
    await note("elsewhere", { workspace: other });
    await block("blockByModule", "untagged", ["module"]);
    await block("blockByExtender", "untagged", ["extender"]);
    await block("hiddenBlock", "untagged", ["module"], true);
    await block("blockPlain", "untagged", ["plain"]);
    await block("blockUntagged", "untagged", []);

    // A person's schedule on a card that was a card only through the extender, and on a paragraph.
    await seedQ(`INSERT INTO review_states (workspace_id, node_id, actor_id, state) VALUES ($1, $2, $3, '{"due":"2026-12-01T00:00:00.000Z"}')`, [ws, id.byExtender, owner.id]);
    await seedQ(`INSERT INTO review_states (workspace_id, block_id, actor_id, state) VALUES ($1, $2, $3, '{"due":"2026-12-02T00:00:00.000Z"}')`, [ws, id.blockByExtender, owner.id]);
    await seedQ(`INSERT INTO actor_module_settings (actor_id, tag_id, settings) VALUES ($1, $2, '{"new_per_day": 5}')`, [owner.id, id.module]);
    since = Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events`)).rows[0]!.m);
    await seedQ(MIGRATION);
  });

  it("every note that was a card gets its own reference, whichever tag made it a card", async () => {
    for (const key of ["byModule", "byExtender", "byLegacy", "byBoth"]) expect(await noteRef(key), key).toBe(1);
  });

  it("a card in the trash keeps being one (it comes back with its note)", async () => {
    expect(await noteRef("trashedCard")).toBe(1);
  });

  it("notes that were never cards stay so: plain tag, a tag whose settings source is gone, not a note, untagged, another workspace", async () => {
    for (const key of ["plainOnly", "deadSourceOnly", "aBoard", "untagged", "elsewhere"]) expect(await noteRef(key), key).toBe(0);
  });

  it("every paragraph that was a card gets its own reference, hidden ones too (their text may come back)", async () => {
    for (const key of ["blockByModule", "blockByExtender", "hiddenBlock"]) expect(await blockRef(key), key).toBe(1);
    for (const key of ["blockPlain", "blockUntagged"]) expect(await blockRef(key), key).toBe(0);
  });

  it("tag-level review is gone: no tag holds a review reference, no legacy switch is left", async () => {
    for (const key of ["module", "extender", "legacy", "deadSource"]) expect(await tagRefs(key), key).toBe(0);
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND (tag_schema->'behaviour'->'modules') ? 'review'`, [ws])).rowCount).toBe(0);
  });

  it("nothing a person wrote is touched: schedules, personal settings, memberships, notes, tags", async () => {
    expect((await q(`SELECT 1 FROM review_states WHERE actor_id = $1`, [owner.id])).rowCount).toBe(2);
    expect((await q<{ settings: object }>(`SELECT settings FROM actor_module_settings WHERE actor_id = $1`, [owner.id])).rows[0]!.settings).toEqual({ new_per_day: 5 });
    expect((await q(`SELECT 1 FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id WHERE n.workspace_id = $1`, [ws])).rowCount).toBe(9);
    expect((await q(`SELECT 1 FROM block_node_tags WHERE workspace_id = $1`, [ws])).rowCount).toBe(4);
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND deleted_at IS NULL`, [ws])).rowCount).toBe(5);
    expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id.byModule])).rows[0]!.markdown).toBe("body");
  });

  it("a tag that lost its reference or switch has a tag event, so a client with an older sync cursor reads it again", async () => {
    const events = (await q<{ target_id: string; event_type: string }>(
      `SELECT target_id, event_type FROM domain_events WHERE workspace_id = $1 AND id > $2 AND actor_id = 'migration:195'`, [ws, since])).rows;
    expect(events.every((e) => e.event_type === "TAG_MODULES_MIGRATED")).toBe(true);
    expect(new Set(events.map((e) => e.target_id))).toEqual(new Set([id.module, id.extender, id.legacy, id.deadSource]));
    const delta = await buildSyncDelta(owner, ws, { since, known: [] });
    expect(delta.tags?.find((t) => t.id === id.legacy)).toBeDefined();
  });

  it("a paragraph or note reference is removed with its paragraph or note", async () => {
    // Its own rows: the tests may run in any order.
    await note("doomedNote");
    await block("doomedBlock", "doomedNote", []);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'review', $2)`, [ws, id.doomedNote]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_block_id) VALUES ($1, 'review', $2)`, [ws, id.doomedBlock]);
    await seedQ(`DELETE FROM block_nodes WHERE id = $1`, [id.doomedBlock]);
    expect(await blockRef("doomedBlock")).toBe(0);
    await seedQ(`DELETE FROM content_nodes WHERE id = $1`, [id.doomedNote]);
    expect(await noteRef("doomedNote")).toBe(0);
  });

  it("a reference needs exactly one holder", async () => {
    await expect(seedQ(`INSERT INTO function_refs (workspace_id, function_id) VALUES ($1, 'review')`, [ws])).rejects.toThrow();
    await expect(seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id, holder_block_id) VALUES ($1, 'review', $2, $3)`, [ws, id.untagged, id.blockPlain])).rejects.toThrow();
  });

  it("running it again changes nothing more", async () => {
    const snapshot = async () => (await q(`SELECT function_id, holder_node_id::text, holder_block_id::text FROM function_refs WHERE workspace_id = $1 ORDER BY 1, 2, 3`, [ws])).rows;
    const before = await snapshot();
    const events = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE workspace_id = $1`, [ws])).rows[0]!.n;
    await seedQ(MIGRATION);
    expect(await snapshot()).toEqual(before);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE workspace_id = $1`, [ws])).rows[0]!.n).toBe(events);
  });
});
