// Migration 196: the module tag nodes go. What it must do to data that already exists:
//   * a live module tag nobody changed (review, tasks, a view) goes to the trash through a NODE_DELETED event, so it can be restored;
//   * a tag a person changed (renamed, body, colour, child tag, personal settings, notes they put on it) stays; a view tag that stays
//     loses the module mark, a review or tasks tag keeps it (their settings / word are still read from it);
//   * skills and the inbox are left exactly as they are; a tag already in the trash is left as it is;
//   * a user tag that extended a removed tag loses that entry (and has a tag event, so a client re-reads it); references sourced from
//     a removed tag are deleted; running it twice changes nothing more.
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";
import { persistActor } from "./helpers/persistActor.js";
import { buildSyncDelta } from "../services/sync/index.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import type { ActorCtx } from "../types.js";

const MIGRATION = readFileSync(new URL("../../db/migrations/196_remove_module_tags.sql", import.meta.url), "utf8");
const DEFAULT_TITLE: Record<string, string> = { review: "複習", tasks: "task", table: "表格", kanban: "kanban", calendar: "月曆", gallery: "卡片" };

describe.skipIf(!isTestDatabase())("migration 196 — the module tag nodes go (DB)", () => {
  const workspaces: string[] = [];
  const id: Record<string, string> = {};
  let owner: ActorCtx = { id: "", name: "Owner", role: "admin", type: "human" };
  let since = 0;
  let clean = "", changed = "", special = "";

  const workspace = async () => {
    const wid = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('M196', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    workspaces.push(wid);
    return wid;
  };
  async function moduleTag(key: string, ws: string, module: string, over: { title?: string; markdown?: string; color?: string; parent?: string; deleted?: boolean; schema?: object } = {}) {
    id[key] = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_color, parent_id, tag_schema, deleted_at)
       VALUES ($1, 'manual', 'class_tag', $2, $3, $4, $5, $6, $7::jsonb, ${over.deleted ? "now()" : "NULL"}) RETURNING id::text`,
      [ws, over.title ?? DEFAULT_TITLE[module] ?? module, `tag-${randomUUID()}`, over.markdown ?? "", over.color ?? null, over.parent ?? null,
        JSON.stringify({ name: over.title ?? module, module, behaviour: { modules: { [module]: { enabled: true } } }, ...(over.schema ?? {}) })])).rows[0]!.id;
  }
  async function note(key: string, ws: string, tags: string[] = []) {
    id[key] = (await seedQ<{ id: string }>(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, 'manual', 'content', $2, $3, 'text') RETURNING id::text`,
      [ws, key, `n-${randomUUID()}`])).rows[0]!.id;
    for (const t of tags) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id[key], id[t]]);
  }
  const row = async (key: string) => (await q<{ title: string; mod: string | null; live: boolean; extendsIds: string[]; switches: string[]; deletedBy: string | null }>(
    `SELECT title, tag_schema->>'module' AS mod, deleted_at IS NULL AS live, deleted_by_event_id::text AS "deletedBy",
            ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(tag_schema->'extends') = 'array' THEN tag_schema->'extends' ELSE '[]'::jsonb END)) AS "extendsIds",
            ARRAY(SELECT jsonb_object_keys(CASE WHEN jsonb_typeof(tag_schema->'behaviour'->'modules') = 'object' THEN tag_schema->'behaviour'->'modules' ELSE '{}'::jsonb END)) AS switches
       FROM content_nodes WHERE id = $1`, [id[key]])).rows[0]!;

  beforeAll(async () => {
    clean = await workspace(); changed = await workspace(); special = await workspace();
    owner = await persistActor(clean, owner);
    // 1. Nobody changed any of them. The review tag's members are the cards migration 195 already gave their own reference.
    for (const module of ["review", "tasks", "table", "kanban", "calendar", "gallery"]) await moduleTag(`clean_${module}`, clean, module);
    await note("aCard", clean, ["clean_review"]);
    await moduleTag("userTag", clean, "table", { title: "書籍", schema: {} });
    await seedQ(`UPDATE content_nodes SET tag_schema = '{"name":"書籍"}'::jsonb WHERE id = $1`, [id.userTag]);
    await seedQ(`UPDATE content_nodes SET tag_schema = jsonb_set(tag_schema, '{extends}', $2::jsonb) WHERE id = $1`, [id.userTag, JSON.stringify([id.clean_table, id.clean_review])]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id, config) VALUES ($1, 'tasks', $2, $3::jsonb)`, [clean, id.userTag, JSON.stringify({ source_tag_id: id.clean_tasks })]);
    // 2. Each one changed in a way a person would.
    await moduleTag("renamedTable", changed, "table", { title: "我的表格" });
    await moduleTag("bodyCalendar", changed, "calendar", { markdown: "我寫的說明" });
    await moduleTag("colourGallery", changed, "gallery", { color: "#ff0000" });
    await moduleTag("parentKanban", changed, "kanban");
    await moduleTag("childOfKanban", changed, "kanban", { parent: id.parentKanban, title: "子標籤" });
    await seedQ(`UPDATE content_nodes SET tag_schema = '{"name":"子標籤"}'::jsonb WHERE id = $1`, [id.childOfKanban]);
    await moduleTag("limitsReview", changed, "review", { schema: { behaviour: { review: { new_per_day: 7 }, modules: { review: { enabled: true } } } } });
    await moduleTag("usedTasks", changed, "tasks");
    await note("plainNote", changed, ["usedTasks"]);
    await moduleTag("personalReview", special, "review");
    await moduleTag("trashedTable", special, "table", { deleted: true });
    await moduleTag("skills", special, "skills", { title: "skill" });
    await moduleTag("inbox", special, "capture", { title: "收件匣" });
    await seedQ(`INSERT INTO actor_module_settings (actor_id, tag_id, settings) VALUES ($1, $2, '{"new_per_day": 3}')`, [owner.id, id.personalReview]);
    since = Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events`)).rows[0]!.m);
    await seedQ(MIGRATION);
  });

  it("a module tag nobody changed goes to the trash through a NODE_DELETED event that can be undone", async () => {
    for (const module of ["review", "tasks", "table", "kanban", "calendar", "gallery"]) {
      const tag = await row(`clean_${module}`);
      expect(tag.live, module).toBe(false);
      const event = (await q<{ event_type: string; target_id: string; inverse: string }>(
        `SELECT event_type, target_id, tx_meta->>'inverse_op' AS inverse FROM domain_events WHERE id = $1`, [tag.deletedBy])).rows[0];
      expect(event, module).toEqual({ event_type: "NODE_DELETED", target_id: id[`clean_${module}`], inverse: "node.undeleted" });
    }
  });

  it("a trashed tag comes back from History with its members still on it", async () => {
    // Its own workspace (not in `workspaces`), so the other tests, which may run in any order, never see the restored tag.
    const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('M196 restore', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    const actor = await persistActor(ws, { id: "", name: "Owner", role: "admin", type: "human" });
    await moduleTag("restoreTag", ws, "review");
    await note("restoreCard", ws, ["restoreTag"]);
    await seedQ(MIGRATION);
    const trashed = await row("restoreTag");
    expect(trashed.live).toBe(false);
    const done = await restoreEvent(trashed.deletedBy!, { actor, workspaceId: ws });
    expect("code" in done ? done : null).toBeNull();
    expect((await row("restoreTag")).live).toBe(true);
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [id.restoreCard, id.restoreTag])).rowCount).toBe(1);
  });

  it("memberships of a removed tag stay where they are (a restore needs them)", async () => {
    expect((await q(`SELECT 1 FROM node_tags WHERE tag_id = $1`, [id.clean_review])).rowCount).toBe(1);
  });

  it("a tag a person changed stays; a view tag that stays is an ordinary tag, review and tasks keep their mark", async () => {
    for (const key of ["renamedTable", "bodyCalendar", "colourGallery", "parentKanban", "childOfKanban"]) {
      expect(await row(key), key).toMatchObject({ live: true, mod: null, deletedBy: null });
    }
    expect((await row("renamedTable")).title).toBe("我的表格");
    expect((await row("renamedTable")).switches).not.toContain("table");
    expect(await row("limitsReview")).toMatchObject({ live: true, mod: "review", deletedBy: null });
    expect(await row("usedTasks")).toMatchObject({ live: true, mod: "tasks" });
    expect(await row("personalReview")).toMatchObject({ live: true, mod: "review" });
    expect((await q<{ settings: object }>(`SELECT settings FROM actor_module_settings WHERE tag_id = $1`, [id.personalReview])).rows[0]!.settings).toEqual({ new_per_day: 3 });
  });

  it("the app's default grey is not a colour a person chose", async () => {
    const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('M196 grey', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    await moduleTag("greyTag", ws, "calendar", { color: "#888888" });
    await seedQ(MIGRATION);
    expect((await row("greyTag")).live).toBe(false);
  });

  it("skills and the inbox are left exactly as they are; a tag already in the trash is not touched", async () => {
    expect(await row("skills")).toMatchObject({ live: true, mod: "skills", deletedBy: null });
    expect(await row("inbox")).toMatchObject({ live: true, mod: "capture", deletedBy: null });
    expect(await row("trashedTable")).toMatchObject({ live: false, mod: "table", deletedBy: null });
  });

  it("a user tag that extended a removed tag loses only that entry; references sourced from it are deleted; it has a tag event", async () => {
    expect((await row("userTag")).extendsIds).toEqual([]);
    expect((await q(`SELECT 1 FROM function_refs WHERE holder_node_id = $1`, [id.userTag])).rowCount).toBe(0);
    expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND deleted_at IS NULL AND title = '書籍'`, [id.userTag])).rowCount).toBe(1);
    const events = (await q<{ target_id: string; event_type: string }>(
      `SELECT target_id, event_type FROM domain_events WHERE id > $1 AND actor_id = 'migration:196' AND target_id = ANY($2::text[])`, [since, [id.userTag, id.renamedTable]])).rows;
    expect(events.map((e) => `${e.target_id}:${e.event_type}`).sort()).toEqual([`${id.renamedTable}:TAG_MODULES_MIGRATED`, `${id.userTag}:TAG_MODULES_MIGRATED`].sort());
    const delta = await buildSyncDelta(owner, clean, { since, known: [] });
    expect(delta.tags?.find((tag) => tag.id === id.userTag)).toBeDefined();
  });

  it("running it again changes nothing more", async () => {
    const snapshot = async () => (await q(`SELECT id::text, title, deleted_at, tag_schema FROM content_nodes WHERE workspace_id = ANY($1::uuid[]) ORDER BY id`, [workspaces])).rows;
    const before = await snapshot();
    const events = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE workspace_id = ANY($1::uuid[])`, [workspaces])).rows[0]!.n;
    await seedQ(MIGRATION);
    expect(await snapshot()).toEqual(before);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE workspace_id = ANY($1::uuid[])`, [workspaces])).rows[0]!.n).toBe(events);
  });
});
