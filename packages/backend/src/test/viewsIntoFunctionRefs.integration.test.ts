// Migration 188: saved views move from content_nodes.collection_views into function_refs
// (function-references proposal §6, B2). The world is written the way the column used to hold it
// (the shapes the old writers produced: tag views with tag_id, note views with node_id, a whiteboard
// tab with only `layout_config`, the removed 'list' layout, a trashed note, a hidden board), the
// migration SQL runs, and every view must come back the same through the one projection clients read
// (nodeRowProjection → holderViewsSql), run to the same rows, and keep its id. Shapes that cannot move
// stay in the column.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";
import { executeView } from "../services/collectionViewQuery.js";
import { holderViewsSql } from "../services/functionRefSql.js";
import { readableNodeIdSet } from "../services/readPolicy.js";
import { executeNoteView, listNoteViews } from "../services/noteViews.js";
import { executeTagView, listTagViews } from "../services/tagViews.js";
import { whiteboardNoteSql, whiteboardShownSql } from "../services/boardStore.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { MIGRATION_188, moveViewsIntoRefs } from "./helpers/migration188.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

registerShippedModules();

type Element = Record<string, unknown> & { id: string; layout: string };
const view = (over: Partial<Element> & { layout: string }, owner: Record<string, string>): Element => ({
  id: randomUUID(), name: `View ${randomUUID().slice(0, 6)}`, filters: [], sorts: [], group_by: null, visible_fields: [],
  layout_config: {}, pin_order: 0, created_at: "2026-10-01T08:00:00.000Z", updated_at: "2026-10-02T09:30:00.000Z", ...owner, ...over,
});

describe.skipIf(!isTestDatabase())("migration 188 — saved views into function_refs (DB)", () => {
  const admin: ActorCtx = { id: "m188-admin", name: "Admin", role: "admin", type: "human" };
  let WS = "";
  let tag = "", note = "", trashed = "", board = "", broken = "", weird = "";
  const tagViews: Element[] = [];
  const noteViews: Element[] = [];
  const trashedViews: Element[] = [];
  const members: string[] = [];
  const children: string[] = [];

  const insertNode = async (title: string, extra: { parent?: string; deleted?: boolean; views?: unknown } = {}) =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, deleted_at, collection_views)
       VALUES ($1, 'manual', 'content', $2, $3, $4, $5, $6, $7::jsonb) RETURNING id::text`,
      [WS, title, `m188-${randomUUID()}`, `${title}\n`, extra.parent ?? null, extra.deleted ? new Date() : null,
        extra.views === undefined ? null : JSON.stringify(extra.views)])).rows[0]!.id;
  const projected = async (id: string) => (await q<{ v: Element[] | null }>(
    `SELECT ${holderViewsSql("n")} AS v FROM content_nodes n WHERE n.id = $1`, [id])).rows[0]!.v;
  const column = async (id: string) => (await q<{ v: unknown }>(`SELECT collection_views AS v FROM content_nodes WHERE id = $1`, [id])).rows[0]!.v;
  const refCount = async (id: string) => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM function_refs WHERE holder_node_id = $1`, [id])).rows[0]!.n);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
    const n = randomUUID().slice(0, 8);
    tag = (await seedClassTag(WS, { name: `M188 ${n}`, slug: `m188-${n}`, nodeSlug: `m188-tag-${n}`, fields: [{ name: "stage", type: "text" }, { name: "due", type: "date" }, { name: "stage_date", type: "text" }] })).tagId;
    const owner = { tag_id: tag };
    tagViews.push(
      view({ layout: "table", name: "Everything", pin_order: 0, visible_fields: ["title", "stage"], sorts: [{ field: "title", dir: "desc" }] }, owner),
      view({ layout: "kanban", name: "Board", group_by: "stage", filters: [{ field: "stage", op: "eq", value: "open" }], pin_order: 2, visible_fields: ["title", "stage"] }, owner),
      view({ layout: "calendar", name: "When", visible_fields: ["title", "due"], layout_config: { date_field: "due" }, pin_order: 1 }, owner),
      view({ layout: "gallery", name: "Cards", layout_config: { card_size: "large" }, pin_order: 3 }, owner),
      // The removed 'list' layout is a table (migration 111 converted the stored ones; a straggler reads the same).
      view({ layout: "list", name: "Old list", sorts: [{ field: "stage", dir: "asc" }] }, owner),
      // Calendars from before the date field was declared: no date_field. One shows a date-typed field, one a field whose
      // name looks like a date but whose type is text, one nothing date-like.
      view({ layout: "calendar", name: "Undeclared", visible_fields: ["title", "due"], layout_config: {}, pin_order: 4 }, owner),
      view({ layout: "calendar", name: "Name only", visible_fields: ["title", "stage_date"], layout_config: {}, pin_order: 5 }, owner),
      view({ layout: "calendar", name: "Nothing", visible_fields: ["title", "stage"], layout_config: {}, pin_order: 6 }, owner),
    );
    await seedQ(`UPDATE content_nodes SET collection_views = $2::jsonb WHERE id = $1`, [tag, JSON.stringify(tagViews)]);

    for (const [i, stage] of ["open", "done", "open"].entries()) {
      const id = await insertNode(`Member ${i}`);
      members.push(id);
      await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, tag]);
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, 'stage', $3, 'text', 'ui')`, [WS, id, stage]);
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, 'due', $3, 'date', 'ui')`, [WS, id, `2026-11-0${i + 1}`]);
    }

    note = await insertNode(`M188 note ${n}`);
    const noteOwner = { node_id: note };
    // A whiteboard tab as the frontend wrote it (id, layout, layout_config only), a hidden one, a slides tab, a board that opens first.
    noteViews.push(
      view({ layout: "table", name: "Sub-notes", filters: [{ field: "title", op: "contains", value: "child" }], visible_fields: ["title"] }, noteOwner),
      { id: randomUUID(), layout: "canvas", layout_config: { opens_first: true } },
      view({ layout: "slides", name: "Slides", pin_order: 5 }, noteOwner),
    );
    await seedQ(`UPDATE content_nodes SET collection_views = $2::jsonb WHERE id = $1`, [note, JSON.stringify(noteViews)]);
    for (const title of ["child a", "child b", "other"]) children.push(await insertNode(title, { parent: note }));

    board = await insertNode(`M188 board ${n}`, { views: [view({ layout: "canvas", name: "Canvas", layout_config: { hidden: true } }, { node_id: "x" })] });
    trashedViews.push(view({ layout: "kanban", name: "In the trash", group_by: "stage" }, {}));
    trashed = await insertNode(`M188 trashed ${n}`, { deleted: true, views: trashedViews });

    // Shapes that cannot move: not an object, no id, a layout that is not a string, an over-long layout, a repeated id.
    const repeated = randomUUID();
    broken = await insertNode(`M188 broken ${n}`, { views: [
      view({ layout: "table", name: "Fine" }, {}), "just text", { layout: "table", name: "No id" }, { id: randomUUID(), layout: 7 },
      { id: randomUUID(), layout: "x".repeat(65) }, view({ id: repeated, layout: "table", name: "First of two" }, {}), view({ id: repeated, layout: "kanban", name: "Second of two" }, {}),
    ] });
    weird = await insertNode(`M188 weird ${n}`, { views: { not: "an array" } });

    await moveViewsIntoRefs();
  });

  const same = (stored: Element[] | null, expected: Element[], holderKey: "tag_id" | "node_id", holder: string) => {
    expect(stored).not.toBeNull();
    // Creation order is kept; every key the old element had comes back (the holder key from the row), the list layout as a table.
    expect(stored!.map((v) => v.id)).toEqual(expected.map((v) => v.id));
    for (const [i, original] of expected.entries()) {
      const { tag_id: _t, node_id: _n, ...rest } = original;
      expect(stored![i]).toMatchObject({ ...rest, layout: original.layout === "list" ? "table" : original.layout, [holderKey]: holder });
    }
  };

  it("a tag's views come back with the same id, name, layout, filters, sorts, grouping, pin and settings", async () => {
    const stored = await projected(tag);
    const expected = tagViews.map((v) => v.name === "Undeclared" ? { ...v, layout_config: { date_field: "due" } } : v);
    same(stored, expected, "tag_id", tag);
    expect(stored!.find((v) => v.name === "Old list")?.layout).toBe("table");
  });

  it("a note's views, including a whiteboard tab written with only layout_config, come back the same", async () => {
    same(await projected(note), noteViews, "node_id", note);
    expect((await projected(note))!.find((v) => v.layout === "canvas")).toMatchObject({ layout_config: { opens_first: true } });
  });

  it("a hidden whiteboard stays hidden and the board is still a whiteboard note; a trashed note keeps its views", async () => {
    const rows = (await q<{ id: string; whiteboard: boolean; shown: boolean }>(
      `SELECT n.id::text, ${whiteboardNoteSql("n")} AS whiteboard, ${whiteboardShownSql("n")} AS shown FROM content_nodes n WHERE n.id = ANY($1::uuid[])`,
      [[board, note, tag]])).rows;
    expect(rows.find((r) => r.id === board)).toMatchObject({ whiteboard: true, shown: false });
    expect(rows.find((r) => r.id === note)).toMatchObject({ whiteboard: true, shown: true });
    same(await projected(trashed), trashedViews, "node_id", trashed);
  });

  it("a calendar view without a date field gets a date-typed field its visible fields name; a name that only looks like a date, or no field, stays as it was", async () => {
    const stored = (await projected(tag))!;
    expect(stored.find((v) => v.name === "Undeclared")!.layout_config).toEqual({ date_field: "due" });
    expect(stored.find((v) => v.name === "Name only")!.layout_config).toEqual({});
    expect(stored.find((v) => v.name === "Nothing")!.layout_config).toEqual({});
    expect(stored.find((v) => v.name === "When")!.layout_config).toEqual({ date_field: "due" });
  });

  it("every view runs to the same rows as before: the filters, sorts and fields of the old element give the page", async () => {
    const readable = [...await readableNodeIdSet(admin, WS)];
    for (const original of tagViews) {
      const run = await executeTagView(admin, WS, tag, original.id, { limit: 500, offset: 0 }).catch((e) => { throw new Error(`${original.name}: ${e}`); });
      const direct = await executeView({
        workspaceId: WS, tagId: tag, filters: original.filters as never, sorts: original.sorts as never,
        visibleFields: original.visible_fields as string[], limit: 500, offset: 0, readableIds: readable,
      });
      expect(run, original.name as string).not.toBeNull();
      expect(run!.rows, original.name as string).toEqual(direct.rows);
      expect(run!.total).toBe(direct.total);
      expect(run!.view).toMatchObject({ layout: original.layout === "list" ? "table" : original.layout, group_by: original.group_by, visible_fields: original.visible_fields });
    }
    const tableView = noteViews.find((v) => v.layout === "table")!;
    const runNote = await executeNoteView(admin, WS, note, tableView.id, { limit: 500, offset: 0 }).catch((e) => { throw new Error(`note view: ${e}`); });
    const directNote = await executeView({
      workspaceId: WS, parentId: note, filters: tableView.filters as never, sorts: [], visibleFields: ["title"], limit: 500, offset: 0, readableIds: readable,
    });
    expect(runNote!.rows).toEqual(directNote.rows);
    expect(runNote!.rows.map((r) => r.title).sort()).toEqual(["child a", "child b"]);
  });

  it("the lists the routes serve read the moved views (tag and note)", async () => {
    expect((await listTagViews(admin, WS, tag))!.map((v) => (v as Element).id).sort()).toEqual(tagViews.map((v) => v.id).sort());
    expect((await listNoteViews(admin, WS, note))!.map((v) => (v as Element).id).sort()).toEqual(noteViews.map((v) => v.id).sort());
  });

  it("shapes that cannot move stay where they were, nothing is dropped, and the column is untouched", async () => {
    expect((await projected(broken))!.map((v) => v.name)).toEqual(["Fine", "First of two"]);
    expect(await column(broken)).toHaveLength(7);
    expect(await refCount(weird)).toBe(0);
    expect(await column(weird)).toEqual({ not: "an array" });
    expect(await column(tag)).toHaveLength(tagViews.length);
    // A holder has one row per view id, whatever the layout: a second one is refused by the database.
    const first = tagViews[0]!;
    await expect(seedQ(
      `INSERT INTO function_refs (workspace_id, function_id, instance, config, holder_node_id) VALUES ($1, 'kanban', $2, '{}'::jsonb, $3)`,
      [WS, first.id, tag])).rejects.toThrow(/function_refs_view_instance_unique|duplicate key/);
  });

  it("runs again without changing anything", async () => {
    // This world's own holders: the shared database also holds views other tests made and removed since the column froze
    // (running the migration again would bring those back — it runs once, when the server is upgraded).
    const mine = [tag, note, board, trashed, broken, weird];
    const counts = async () => (await q<{ n: string }>(`SELECT count(*) AS n FROM function_refs WHERE holder_node_id = ANY($1::uuid[])`, [mine])).rows[0]!.n;
    const before = await counts();
    const stored = await projected(tag);
    await seedQ(MIGRATION_188);
    expect(await counts()).toBe(before);
    expect(await projected(tag)).toEqual(stored);
  });

  it("a view moved by the migration can be renamed, pinned and deleted through the same writers as one made now", async () => {
    const { updateTagView, deleteTagView } = await import("../services/tagViews.js");
    const n = randomUUID().slice(0, 8);
    const own = (await seedClassTag(WS, { name: `M188 own ${n}`, slug: `m188-own-${n}`, nodeSlug: `m188-own-tag-${n}` })).tagId;
    const target = view({ layout: "gallery", name: "Cards" }, { tag_id: own });
    await seedQ(`UPDATE content_nodes SET collection_views = $2::jsonb WHERE id = $1`, [own, JSON.stringify([target])]);
    await moveViewsIntoRefs();
    await seedQ(`UPDATE content_nodes SET collection_views = NULL WHERE id = $1`, [own]); // the column is frozen: nothing may bring the view back
    expect(await updateTagView(admin, WS, own, target.id, { name: "Cards renamed", pin_order: -1 })).toBe(true);
    expect((await projected(own))!.find((v) => v.id === target.id)).toMatchObject({ name: "Cards renamed", pin_order: -1, layout: "gallery" });
    expect(await deleteTagView(admin, WS, own, target.id)).toBe(true);
    expect(await projected(own)).toBeNull();
  });
});
