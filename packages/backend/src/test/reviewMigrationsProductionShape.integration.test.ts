// Migrations 195 and 196 on a database shaped like the one they will meet in production (counts from the read-only preview of
// 2026-11-13): one review module tag holding 1 note card and 6 paragraph cards with 4 schedules; eight module tags, the inbox among
// them with 6 notes; two user tags that extend the table tag and have their own fields, saved views and notes; a tag in the trash
// that once provided review, with its own notes. The old shape is seeded by hand, then 195 and 196 run in order. A person must
// lose nothing: every former card is a card, every schedule row is the same bytes, the queue and status pages show the same cards,
// the extending tags keep what they have, and running both again changes nothing.
// A second workspace holds module tags people changed, to check the read-only preview's outcome column against what really happens.
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const context = vi.hoisted(() => ({ workspaceId: "" }));
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => context.workspaceId }));
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import reviewRouter from "../modules/review/routes.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import type { ReviewQueue, ReviewStatus } from "@onden/contract";

registerShippedModules();
const sql = (file: string) => readFileSync(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8");
const M195 = sql("195_review_into_function_refs.sql");
const M196 = sql("196_remove_module_tags.sql");
/** The read-only preview, exactly as the header of 196 prints it. */
const PREVIEW = (() => {
  const lines = M196.split("\n");
  const from = lines.findIndex((line) => line.startsWith("--   WITH m AS ("));
  const to = lines.findIndex((line) => line.startsWith("-- drill:"));
  return lines.slice(from, to).map((line) => line.replace(/^-- ?/, "")).join("\n");
})();
const NOW = "2026-11-13T02:00:00.000Z";
const DEFAULT_TITLE: Record<string, string> = { review: "review", tasks: "task", table: "table", kanban: "kanban", calendar: "calendar", gallery: "gallery", skills: "skills", capture: "capture" };

let actor: ActorCtx;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/review", reviewRouter);

describe.skipIf(!isTestDatabase())("migrations 195 and 196 on a production-shaped database (DB)", () => {
  let ws = "", other = "";
  let ann: ActorCtx, bob: ActorCtx;
  const id: Record<string, string> = {};
  const paragraphs: string[] = [];
  let scheduleBefore: string[] = [];
  let cardsBefore: string[] = [];
  let previewBefore: Array<Record<string, unknown>> = [];
  /** Where each previewed tag stood right after the first run of the two migrations. The preview is checked against this, not
   *  against the database when the test runs: the shuffle may run "running both again" first, and a second run can trash a tag the
   *  first one kept (one whose only reason to stay was an `extends` entry the first run removed). */
  const afterFirstRun = new Map<string, { in_trash: boolean; module: string | null }>();

  async function moduleTag(key: string, workspace: string, module: string, over: { title?: string; markdown?: string; color?: string; parent?: string; schema?: object } = {}) {
    id[key] = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_color, parent_id, tag_schema)
       VALUES ($1, 'manual', 'class_tag', $2, $3, $4, $5, $6, $7::jsonb) RETURNING id::text`,
      [workspace, over.title ?? DEFAULT_TITLE[module], `tag-${randomUUID()}`, over.markdown ?? "", over.color ?? null, over.parent ?? null,
        JSON.stringify({ name: over.title ?? module, module, behaviour: { modules: { [module]: { enabled: true } } }, ...(over.schema ?? {}) })])).rows[0]!.id;
  }
  async function userTag(key: string, workspace: string, schema: object) {
    id[key] = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, tag_schema) VALUES ($1, 'manual', 'class_tag', $2, $3, $4::jsonb) RETURNING id::text`,
      [workspace, key, `tag-${randomUUID()}`, JSON.stringify({ name: key, ...schema })])).rows[0]!.id;
  }
  async function note(key: string, workspace: string, tags: string[] = []) {
    id[key] = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, 'manual', 'content', $2, $3, '內文') RETURNING id::text`,
      [workspace, key, `n-${randomUUID()}`])).rows[0]!.id;
    for (const tag of tags) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id[key], id[tag]]);
  }
  async function paragraph(key: string, noteKey: string, tag: string) {
    id[key] = (await seedQ<{ id: string }>(
      `INSERT INTO block_nodes (workspace_id, note_id, block_ref, kind, label) VALUES ($1, $2, $3, 'paragraph', $4) RETURNING id::text`,
      [ws, id[noteKey], `b${randomUUID().slice(0, 8)}`, key])).rows[0]!.id;
    await seedQ(`INSERT INTO block_node_tags (block_node_id, tag_id, workspace_id) VALUES ($1, $2, $3)`, [id[key], id[tag], ws]);
    paragraphs.push(key);
  }
  const queue = async () => (await (await app.request(`/api/review/queue?now=${encodeURIComponent(NOW)}`)).json()) as ReviewQueue;
  const status = async () => (await (await app.request(`/api/review/status?now=${encodeURIComponent(NOW)}`)).json()) as ReviewStatus;
  const keyOf = (card: { node_id: string; block: { id: string } | null }) => card.block?.id ?? card.node_id;
  const schedules = async () => (await q<{ row: string }>(`SELECT row_to_json(s)::text AS row FROM review_states s WHERE workspace_id = $1 ORDER BY 1`, [ws])).rows.map((r) => r.row);
  /** Everything the two migrations may touch in these two workspaces, as text, so "changes nothing" is a comparison. The migrations
   *  run over the whole shared database, and a module tag another file left in a third workspace can change on a second run
   *  (a review tag that stayed only because it extended a removed tag is trashed then), so nothing outside the two is compared. */
  const snapshot = async () => ({
    refs: (await q<{ r: string }>(`SELECT row_to_json(r)::text AS r FROM (SELECT id, workspace_id, function_id, instance, holder_node_id, holder_block_id, config FROM function_refs WHERE workspace_id IN ($1, $2)) r ORDER BY 1`, [ws, other])).rows.map((x) => x.r),
    tags: (await q<{ r: string }>(`SELECT row_to_json(t)::text AS r FROM (SELECT id, title, tag_schema, tag_color, deleted_at IS NOT NULL AS in_trash, parent_id FROM content_nodes WHERE node_type = 'class_tag' AND workspace_id IN ($1, $2)) t ORDER BY 1`, [ws, other])).rows.map((x) => x.r),
    members: (await q<{ r: string }>(`SELECT row_to_json(m)::text AS r FROM (SELECT nt.node_id, nt.tag_id FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id WHERE n.workspace_id IN ($1, $2)) m ORDER BY 1`, [ws, other])).rows.map((x) => x.r),
    blockMembers: (await q<{ r: string }>(`SELECT row_to_json(m)::text AS r FROM (SELECT block_node_id, tag_id FROM block_node_tags WHERE workspace_id IN ($1, $2)) m ORDER BY 1`, [ws, other])).rows.map((x) => x.r),
    schedules: await schedules(),
    events: Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id IN ($1, $2)`, [ws, other])).rows[0]!.n),
  });
  const refOf = async (holder: string, column: "holder_node_id" | "holder_block_id") =>
    (await q(`SELECT 1 FROM function_refs WHERE ${column} = $1 AND function_id = 'review' AND instance = ''`, [holder])).rowCount;

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Prod shape', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    other = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Prod shape 2', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    context.workspaceId = ws;
    ann = await persistActor(ws, { id: "x", name: "Ann", role: "admin", type: "human" });
    bob = await persistActor(ws, { id: "x", name: "Bob", role: "editor", type: "human" });
    actor = ann;

    // The eight module tags: none changed by a person. The review one provides review (its function reference).
    for (const module of ["calendar", "capture", "gallery", "kanban", "review", "skills", "table", "tasks"]) await moduleTag(`m_${module}`, ws, module);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'review', $2)`, [ws, id.m_review]);
    // 1 note card and 6 paragraph cards (in two notes), 4 schedules (one person has three, another one).
    await note("card note", ws, ["m_review"]);
    await note("deck A", ws); await note("deck B", ws);
    for (const [i, host] of [["deck A", 1], ["deck A", 2], ["deck A", 3], ["deck B", 4], ["deck B", 5], ["deck B", 6]] as const) await paragraph(`paragraph ${host}`, i, "m_review");
    await seedQ(`INSERT INTO review_states (workspace_id, node_id, actor_id, state, previous_state, updated_at) VALUES ($1, $2, $3, '{"due":"2026-11-01T00:00:00.000Z","stability":4,"difficulty":5,"reps":3,"lapses":1,"state":"review","last_review":"2026-10-28T00:00:00.000Z"}', '{"due":"2026-10-28T00:00:00.000Z"}', '2026-10-28T00:00:00.000Z')`, [ws, id["card note"], ann.id]);
    for (const [n, who] of [[1, ann], [2, ann], [3, bob]] as const) {
      await seedQ(`INSERT INTO review_states (workspace_id, block_id, actor_id, state, updated_at) VALUES ($1, $2, $3, $4, '2026-10-29T00:00:00.000Z')`,
        [ws, id[`paragraph ${n}`], who.id, JSON.stringify({ due: `2026-11-0${n}T00:00:00.000Z`, stability: 2, difficulty: 6, reps: n, lapses: 0, state: "review", last_review: "2026-10-29T00:00:00.000Z" })]);
    }
    // The inbox with 6 notes; the skills tag with a skill; the table tag extended by two user tags with fields, saved views and notes.
    for (let i = 1; i <= 6; i++) await note(`inbox ${i}`, ws, ["m_capture"]);
    await note("a skill", ws, ["m_skills"]);
    for (const name of ["Course", "Paper"]) {
      await userTag(name, ws, { extends: [id.m_table], fields: [{ name: `${name}-作者`, type: "text" }] });
      await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id, config) VALUES ($1, 'table', $2, $3::jsonb)`, [ws, id[name], JSON.stringify({ source_tag_id: id.m_table })]);
      await seedQ(`INSERT INTO function_refs (workspace_id, function_id, instance, holder_node_id, config) VALUES ($1, 'table', $2, $3, $4::jsonb)`, [ws, `view-${name}`, id[name], JSON.stringify({ name: `${name} 檢視` })]);
      await note(`${name} note 1`, ws, [name]); await note(`${name} note 2`, ws, [name]);
    }
    // A tag in the trash that once provided review (the legacy switch), with its own notes: they were never cards.
    await userTag("OldCards", ws, { behaviour: { modules: { review: { enabled: true } } } });
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'review', $2)`, [ws, id.OldCards]);
    await note("old card 1", ws, ["OldCards"]); await note("old card 2", ws, ["OldCards"]);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [id.OldCards]);

    // A second workspace with module tags people changed, for the preview's outcome column.
    await moduleTag("o_kanban", other, "kanban", { title: "我的看板" });
    await moduleTag("o_tasks", other, "tasks", { schema: { description: "我的說明" } });
    await moduleTag("o_table", other, "table"); await moduleTag("o_tableChild", other, "table", { parent: id.o_table, title: "子標籤" });
    await seedQ(`UPDATE content_nodes SET tag_schema = '{"name":"子標籤"}'::jsonb WHERE id = $1`, [id.o_tableChild]);
    await moduleTag("o_gallery", other, "gallery", { color: "#ff0000" });
    await moduleTag("o_calendar", other, "calendar"); await note("o_member", other, ["o_calendar"]);
    await moduleTag("o_review", other, "review"); await note("o_cardNote", other, ["o_review"]);
    await moduleTag("o_trashed", other, "table", { title: "table-old" }); await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [id.o_trashed]);

    // What the person sees before: the cards of the old shape are the note and paragraphs on the review tag.
    cardsBefore = [id["card note"], ...Array.from({ length: 6 }, (_, i) => id[`paragraph ${i + 1}`])].sort();
    scheduleBefore = await schedules();
    previewBefore = (await q<Record<string, unknown>>(PREVIEW)).rows;
    await seedQ(M195);
    await seedQ(M196);
    for (const row of previewBefore) {
      afterFirstRun.set(String(row.id), (await q<{ in_trash: boolean; module: string | null }>(`SELECT deleted_at IS NOT NULL AS in_trash, tag_schema->>'module' AS module FROM content_nodes WHERE id = $1`, [row.id])).rows[0]!);
    }
  });
  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id IN ($1, $2)`, [ws, other]);
  });

  it("every former card is a card: the note and the six paragraphs, and nothing else", async () => {
    expect(await refOf(id["card note"]!, "holder_node_id")).toBe(1);
    for (let i = 1; i <= 6; i++) expect(await refOf(id[`paragraph ${i}`]!, "holder_block_id"), `paragraph ${i}`).toBe(1);
    expect((await q(`SELECT 1 FROM function_refs WHERE workspace_id = $1 AND function_id = 'review' AND (holder_node_id IS NOT NULL OR holder_block_id IS NOT NULL)`, [ws])).rowCount).toBe(7);
    for (const key of ["old card 1", "old card 2", "inbox 1", "a skill", "Course note 1"]) expect(await refOf(id[key]!, "holder_node_id"), key).toBe(0);
  });

  it("every schedule row is byte-for-byte what it was", async () => {
    expect(scheduleBefore).toHaveLength(4);
    expect(await schedules()).toEqual(scheduleBefore);
  });

  it("the queue and the status page show the same cards as before, for each person", async () => {
    for (const person of [ann, bob]) {
      actor = person;
      const shown = await queue();
      expect(shown.cards.map(keyOf).sort(), person.name).toEqual([id["card note"]!, ...Array.from({ length: 6 }, (_, i) => id[`paragraph ${i + 1}`]!)].sort());
      expect(shown.total).toBe(7);
      const page = await status();
      expect(page.overdue + page.today + page.new_available, person.name).toBe(7);
    }
    actor = ann;
    expect(cardsBefore).toHaveLength(7);
  });

  it("the review tag went to the trash through an event that History can undo; it made no card and takes none away", async () => {
    const tag = (await q<{ live: boolean; ev: string | null }>(`SELECT deleted_at IS NULL AS live, deleted_by_event_id::text AS ev FROM content_nodes WHERE id = $1`, [id.m_review])).rows[0]!;
    expect(tag.live).toBe(false);
    expect(tag.ev).not.toBeNull();
    expect((await q<{ inverse: string }>(`SELECT tx_meta->>'inverse_op' AS inverse FROM domain_events WHERE id = $1`, [tag.ev])).rows[0]!.inverse).toBe("node.undeleted");
    expect((await q(`SELECT 1 FROM function_refs WHERE holder_node_id = $1`, [id.m_review])).rowCount).toBe(0);
    expect((await q(`SELECT 1 FROM node_tags WHERE tag_id = $1`, [id.m_review])).rowCount).toBe(1); // the membership is what a restore brings back
  });

  it("the other module tags: skills and the inbox untouched (with their notes); the unchanged view and task tags in the trash", async () => {
    for (const key of ["m_skills", "m_capture"]) expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND deleted_at IS NULL AND tag_schema->>'module' IS NOT NULL`, [id[key]])).rowCount, key).toBe(1);
    expect((await q(`SELECT 1 FROM node_tags WHERE tag_id = $1`, [id.m_capture])).rowCount).toBe(6);
    for (const key of ["m_calendar", "m_gallery", "m_kanban", "m_table", "m_tasks"]) expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND deleted_at IS NOT NULL`, [id[key]])).rowCount, key).toBe(1);
  });

  it("the two tags that extended the table tag keep their fields, saved views and notes; only the extends entry is gone", async () => {
    for (const name of ["Course", "Paper"]) {
      const row = (await q<{ schema: { extends?: string[]; fields?: Array<{ name: string }> }; live: boolean }>(`SELECT tag_schema AS schema, deleted_at IS NULL AS live FROM content_nodes WHERE id = $1`, [id[name]])).rows[0]!;
      expect(row.live).toBe(true);
      expect(row.schema.extends).toEqual([]);
      expect(row.schema.fields).toEqual([{ name: `${name}-作者`, type: "text" }]);
      expect((await q(`SELECT 1 FROM function_refs WHERE holder_node_id = $1 AND function_id = 'table' AND instance = $2`, [id[name], `view-${name}`])).rowCount, `${name} saved view`).toBe(1);
      expect((await q(`SELECT 1 FROM function_refs WHERE holder_node_id = $1 AND function_id = 'table' AND instance = ''`, [id[name]])).rowCount, `${name} reference sourced from the removed tag`).toBe(0);
      expect((await q(`SELECT 1 FROM node_tags WHERE tag_id = $1`, [id[name]])).rowCount).toBe(2);
    }
  });

  it("a trashed tag that once provided review stays in the trash and its notes are still not cards", async () => {
    expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND deleted_at IS NOT NULL`, [id.OldCards])).rowCount).toBe(1);
    expect((await q(`SELECT 1 FROM function_refs WHERE holder_node_id = $1`, [id.OldCards])).rowCount).toBe(0);
    expect((await q(`SELECT 1 FROM node_tags WHERE tag_id = $1`, [id.OldCards])).rowCount).toBe(2);
  });

  it("the preview run before the upgrade named what the migration then did, for every module tag, and showed only counts and flags", async () => {
    expect(previewBefore.length).toBeGreaterThanOrEqual(15);
    for (const row of previewBefore) {
      expect(Object.keys(row)).not.toContain("title");
      const now = afterFirstRun.get(String(row.id))!;
      const will = String(row.will_happen);
      if (will === "trash") expect(now.in_trash, `${row.module} ${will}`).toBe(true);
      else if (will.startsWith("keep")) { expect(now.in_trash, `${row.module} ${will} ${JSON.stringify(row)}`).toBe(false); expect(will === "keep (loses the module mark)" ? now.module === null : now.module === row.module, `${row.module} ${will}`).toBe(true); }
      else if (will === "untouched (already in the trash)") expect(now.in_trash).toBe(true);
      else { expect(will).toBe("untouched (still read)"); expect(now.in_trash).toBe(false); expect(now.module).toBe(row.module); }
    }
    const outcome = (key: string) => previewBefore.find((row) => row.id === id[key])!.will_happen;
    expect(outcome("m_review")).toBe("trash");
    expect(outcome("m_capture")).toBe("untouched (still read)");
    expect(outcome("m_table")).toBe("trash");
    expect([outcome("o_kanban"), outcome("o_tasks"), outcome("o_table"), outcome("o_gallery"), outcome("o_calendar")]).toEqual(["keep (loses the module mark)", "keep", "keep (loses the module mark)", "keep (loses the module mark)", "keep (loses the module mark)"]);
    expect(outcome("o_review")).toBe("trash"); // its notes are cards through their own references, so they do not keep it
    expect(outcome("o_trashed")).toBe("untouched (already in the trash)");
    const reasons = (key: string) => previewBefore.find((row) => row.id === id[key])!;
    expect(reasons("o_kanban")).toMatchObject({ renamed: true });
    expect(reasons("o_tasks")).toMatchObject({ has_description: true });
    expect(reasons("o_table")).toMatchObject({ child_tags: "1" });
    expect(reasons("o_gallery")).toMatchObject({ has_colour: true });
    expect(reasons("o_calendar")).toMatchObject({ notes: "1", members_count: true });
    expect(reasons("m_table")).toMatchObject({ tags_extending_it: "2" });
    expect(reasons("m_review")).toMatchObject({ notes: "1", paragraphs: "6", members_count: false });
  });

  it("running both again changes nothing", async () => {
    const before = await snapshot();
    await seedQ(M195);
    await seedQ(M196);
    expect(await snapshot()).toEqual(before);
    actor = ann;
    expect((await queue()).total).toBe(7);
  });
});
