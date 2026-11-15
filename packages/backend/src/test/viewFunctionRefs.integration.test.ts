// Saved views as function references (B2): one storage for a tag's and a note's views, no view module tags,
// and a view's holder / workspace bound on every write. A tag with a view of a layout has that layout's
// function; nothing is added to tag_schema.extends and no #月曆-like tag is made.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const context = vi.hoisted(() => ({ workspaceId: "" }));
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => context.workspaceId }));
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import { functionIndex, functionsOf, removeFunction, setFunctionConfig } from "../services/functionRefs.js";
import { createNoteView, deleteNoteView, listNoteViews, updateNoteView } from "../services/noteViews.js";
import { createTagView, deleteTagView, listTagViews, updateTagView, viewCreateSchema } from "../services/tagViews.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

registerShippedModules();

describe.skipIf(!isTestDatabase())("saved views as function references (DB)", () => {
  let ws = "";
  let other = "";
  let admin: ActorCtx;
  const make = (body: Record<string, unknown>) => viewCreateSchema.parse(body);
  const tag = async (name = `vf-${randomUUID().slice(0, 8)}`) => (await seedClassTag(ws, { name })).tagId;
  const note = async (workspace = ws) => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, 'manual', 'content', $2, $3, '') RETURNING id::text`,
    [workspace, `vf note`, `vf-${randomUUID()}`])).rows[0]!.id;
  const refsOf = async (holder: string) => (await q<{ function_id: string; instance: string; config: Record<string, unknown> }>(
    `SELECT function_id, instance, config FROM function_refs WHERE holder_node_id = $1 ORDER BY created_at, id`, [holder])).rows;
  const extendsOf = async (id: string) => (await q<{ e: unknown }>(`SELECT tag_schema->'extends' AS e FROM content_nodes WHERE id = $1`, [id])).rows[0]!.e ?? [];
  const moduleTagNodes = async () => Number((await q<{ n: string }>(
    `SELECT count(*) AS n FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND tag_schema->>'module' IS NOT NULL`, [ws])).rows[0]!.n);

  beforeEach(async () => {
    ws = context.workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('View refs', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    other = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('View refs other', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    admin = await persistActor(ws, { id: "vf-admin", name: "Admin", role: "admin", type: "human" });
  });

  it("a tag's and a note's view are the same kind of row: function = layout, instance = view id, settings in config", async () => {
    const t = await tag();
    const n = await note();
    const a = await createTagView(admin, ws, t, make({ name: "Month", layout: "calendar", layout_config: { date_field: "due" }, pin_order: 3 }));
    const b = await createNoteView(admin, ws, n, make({ name: "Month", layout: "calendar", layout_config: { date_field: "due" }, pin_order: 3 }));
    for (const [holder, id] of [[t, a!.id], [n, b!.id]] as const) {
      expect(await refsOf(holder)).toMatchObject([{ function_id: "calendar", instance: id, config: { name: "Month", pin_order: 3, layout_config: { date_field: "due" }, filters: [], sorts: [] } }]);
    }
    // Neither the holder id nor the layout is stored a second time inside the settings.
    for (const holder of [t, n]) expect(Object.keys((await refsOf(holder))[0]!.config)).not.toEqual(expect.arrayContaining(["id"]));
    expect((await refsOf(t))[0]!.config).not.toHaveProperty("layout");
  });

  it("the first view of a layout gives the tag that layout's function, the last one removed takes it away; no extends, no module tag", async () => {
    const t = await tag();
    const before = await moduleTagNodes();
    const one = await createTagView(admin, ws, t, make({ name: "A", layout: "calendar" }));
    const two = await createTagView(admin, ws, t, make({ name: "B", layout: "calendar" }));
    await createTagView(admin, ws, t, make({ name: "C", layout: "kanban", group_by: "stage" }));
    const functions = async () => [...new Set((await functionsOf(admin, { kind: "node", id: t }))!.map((use) => use.functionId))].sort();
    expect(await functions()).toEqual(["calendar", "kanban"]);
    expect((await functionIndex(admin, ws)).has(t, "calendar")).toBe(true);
    expect(await extendsOf(t)).toEqual([]);
    expect(await moduleTagNodes()).toBe(before);
    await deleteTagView(admin, ws, t, one!.id);
    expect(await functions()).toEqual(["calendar", "kanban"]);
    await deleteTagView(admin, ws, t, two!.id);
    expect(await functions()).toEqual(["kanban"]);
    expect((await functionIndex(admin, ws)).has(t, "calendar")).toBe(false);
    // Changing the only calendar to a table moves the function with the layout.
    const only = (await listTagViews(admin, ws, t) as Array<{ id: string; layout: string }>).find((v) => v.layout === "kanban")!;
    await updateTagView(admin, ws, t, only.id, { layout: "table" });
    expect(await functions()).toEqual(["table"]);
    expect(await extendsOf(t)).toEqual([]);
  });

  it("a view is not a function the person adds or configures: the function writers refuse a view's row", async () => {
    const t = await tag();
    await createTagView(admin, ws, t, make({ name: "A", layout: "table" }));
    const use = (await functionsOf(admin, { kind: "node", id: t }))!.find((u) => u.functionId === "table")!;
    // The tag's function list shows the layout, but no row to remove and none of the view's settings.
    expect(use).toMatchObject({ refId: null, config: {} });
    const refId = (await q<{ id: string }>(`SELECT id::text FROM function_refs WHERE holder_node_id = $1`, [t])).rows[0]!.id;
    await expect(removeFunction({ actor: admin, workspaceId: ws, refId })).rejects.toThrow(/not found/);
    await expect(setFunctionConfig({ actor: admin, workspaceId: ws, refId, config: { x: 1 } })).rejects.toThrow(/not found/);
    expect(await refsOf(t)).toHaveLength(1);
  });

  it("a view id that belongs to another note or tag, or to another workspace, is not found: nothing changes", async () => {
    const t1 = await tag(), t2 = await tag();
    const n1 = await note(), n2 = await note();
    const tv = await createTagView(admin, ws, t1, make({ name: "T", layout: "table" }));
    const nv = await createNoteView(admin, ws, n1, make({ name: "N", layout: "table" }));
    expect(await updateTagView(admin, ws, t2, tv!.id, { name: "Hijacked" })).toBe(false);
    expect(await deleteTagView(admin, ws, t2, tv!.id)).toBe(false);
    expect(await updateNoteView(admin, ws, n2, nv!.id, { name: "Hijacked" })).toBe(false);
    expect(await deleteNoteView(admin, ws, n2, nv!.id)).toBe(false);
    expect((await refsOf(t1))[0]!.config.name).toBe("T");
    expect((await refsOf(n1))[0]!.config.name).toBe("N");
    // Another workspace's node does not list views of this one's, nor take a write.
    const foreign = await note(other);
    expect(await listNoteViews(admin, other, n1)).toBeNull();
    await expect(createNoteView(admin, other, foreign, make({ name: "x", layout: "table" }))).rejects.toThrow(/unauthorized/);
    expect(await refsOf(foreign)).toEqual([]);
  });

  it("view names stay unique per holder, exactly as typed, for tag and note alike; a rename onto another is refused", async () => {
    const t = await tag();
    const n = await note();
    for (const make1 of [
      (name: string) => createTagView(admin, ws, t, make({ name, layout: "table" })),
      (name: string) => createNoteView(admin, ws, n, make({ name, layout: "table" })),
    ]) {
      await make1("Same");
      await expect(make1("Same")).rejects.toMatchObject({ name: "TagViewNameConflictError" });
      await make1("same"); // exact match: a different case is another name
    }
    // The same name on another holder is fine.
    expect(await createTagView(admin, ws, await tag(), make({ name: "Same", layout: "table" }))).not.toBeNull();
    const a = (await listTagViews(admin, ws, t) as Array<{ id: string; name: string }>).find((v) => v.name === "same")!;
    await expect(updateTagView(admin, ws, t, a.id, { name: "Same" })).rejects.toMatchObject({ name: "TagViewNameConflictError" });
    expect(await updateTagView(admin, ws, t, a.id, { name: "same" })).toBe(true); // keeping its own name is not a clash
  });

  it("the shape of the live site: a tag extends a view module tag (#表格) and has 2 views and 4 notes — views and notes are untouched, the extends edge stays and brings nothing", async () => {
    const { executeTagView } = await import("../services/tagViews.js");
    const { readableNodeIdSet } = await import("../services/readPolicy.js");
    const moduleTag = await tag("表格");
    await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || jsonb_build_object('module', 'table') WHERE id = $1`, [moduleTag]);
    const user = await tag();
    await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || jsonb_build_object('extends', $2::jsonb) WHERE id = $1`, [user, JSON.stringify([moduleTag])]);
    const old = [
      { id: randomUUID(), tag_id: user, name: "All", layout: "table", filters: [], sorts: [], group_by: null, visible_fields: [], layout_config: {}, pin_order: 0 },
      { id: randomUUID(), tag_id: user, name: "Sorted", layout: "list", filters: [], sorts: [{ field: "title", dir: "desc" }], group_by: null, visible_fields: [], layout_config: {}, pin_order: 1 },
    ];
    await seedQ(`UPDATE content_nodes SET collection_views = $2::jsonb WHERE id = $1`, [user, JSON.stringify(old)]);
    const noteIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await note();
      await seedQ(`UPDATE content_nodes SET title = $2 WHERE id = $1`, [id, `Note ${i}`]);
      await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, user]);
      noteIds.push(id);
    }
    const { moveViewsIntoRefs } = await import("./helpers/migration188.js");
    await moveViewsIntoRefs();

    const views = (await listTagViews(admin, ws, user)) as Array<{ id: string; name: string; layout: string }>;
    expect(views.map((v) => [v.id, v.name, v.layout]).sort()).toEqual(old.map((v) => [v.id, v.name, v.layout === "list" ? "table" : v.layout]).sort());
    for (const v of old) {
      const run = await executeTagView(admin, ws, user, v.id, { limit: 500, offset: 0 });
      expect(run!.rows.map((r) => r.title).sort(), v.name).toEqual(["Note 0", "Note 1", "Note 2", "Note 3"]);
    }
    expect(await extendsOf(user)).toEqual([moduleTag]);
    // The edge brings no function: the tag has table only because it has table views.
    const uses = (await functionsOf(admin, { kind: "node", id: user }))!;
    expect(uses.map((u) => u.functionId)).toEqual(["table", "table"]);
    expect((await functionsOf(admin, { kind: "node", id: moduleTag }))).toEqual([]);
    expect(await readableNodeIdSet(admin, ws)).toBeInstanceOf(Set);
  });

  it("a view module tag that is left is still never applied to a note nor merged", async () => {
    const { attachTagInTx } = await import("../services/tagMembershipWrites.js");
    const { withEventTransaction } = await import("../spine/eventTransaction.js");
    const moduleTag = await tag("看板");
    await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || jsonb_build_object('module', 'kanban') WHERE id = $1`, [moduleTag]);
    const n = await note();
    const applied = await withEventTransaction(ws, () => attachTagInTx({ workspaceId: ws, nodeId: n, tagId: moduleTag, actor: admin }));
    expect(applied).toBe(false);
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1`, [n])).rowCount).toBe(0);
    const { assertNotViewModuleTag, ViewModuleTagError } = await import("../services/viewModules.js");
    await expect(assertNotViewModuleTag(ws, moduleTag)).rejects.toBeInstanceOf(ViewModuleTagError);
    const plain = await tag();
    const { mergeTags } = await import("../services/tagMerge.js");
    await expect(mergeTags(admin, ws, plain, moduleTag)).rejects.toMatchObject({ status: 409 });
  });
});
