// View modules (docs/architecture/views-as-modules.md): table, calendar,
// kanban and gallery are library modules; a tag's saved view may only take
// one of those layouts while the workspace has imported it. The list layout
// is gone ("list" is taken as "table"). Reading a view whose module was
// removed stays open (its data is kept). Migrations 109 and 111 add them to
// workspaces that record a list.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import tagsRouter from "../routes/tags.js";
import { registerModuleEffects } from "../modules/index.js";
import { tableViewModule } from "../modules/table/index.js";
import { calendarViewModule } from "../modules/calendar/index.js";
import { kanbanViewModule } from "../modules/kanban/index.js";
import { galleryViewModule } from "../modules/gallery/index.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// A workspace of the file's own, so switching its modules never touches the
// shared 'default' one; the routes find it through getWorkspaceId.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/tags", tagsRouter);

const owner: ActorCtx = { id: "vm-owner", name: "Owner", role: "admin", type: "human" };
const json = { "content-type": "application/json" };
const post = (tagId: string, body: unknown) =>
  app.request(`/api/tags/${tagId}/views`, { method: "POST", headers: json, body: JSON.stringify(body) });
const patch = (tagId: string, viewId: string, body: unknown) =>
  app.request(`/api/tags/${tagId}/views/${viewId}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });

describe.skipIf(!isTestDb)("view modules gate a view's layout (DB)", () => {
  let tagId = "";
  const stamp = Date.now();
  const setModules = (modules: string[] | null) =>
    setModulesOn(WS, modules);

  beforeAll(async () => {
    for (const mod of [tableViewModule, calendarViewModule, kanbanViewModule, galleryViewModule]) registerModuleEffects(mod);
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('View modules', $1) RETURNING id::text`,
      [`view-modules-${randomUUID()}`])).rows[0]!.id;
    Object.assign(owner, await persistActor(WS, owner));
    tagId = (await seedClassTag(WS, { name: `VM ${stamp}`, slug: `vm-${stamp}`, nodeSlug: `vm-tag-${stamp}`,
      fields: [{ name: "due", type: "date" }] })).tagId;
    currentActor = owner;
  });

  it("every view layout is accepted whatever the workspace imported (views are always on)", async () => {
    await setModules(["canvas"]);
    for (const layout of ["table", "calendar", "kanban", "gallery"]) {
      expect((await post(tagId, { name: `${layout} ${stamp}`, layout })).status, layout).toBe(201);
    }
    const table = await post(tagId, { name: `Table ${stamp}`, layout: "table" });
    const tableId = ((await table.json()) as { id: string }).id;
    expect((await patch(tagId, tableId, { layout: "kanban" })).status).toBe(200);
    expect((await patch(tagId, tableId, { layout: "list" })).status).toBe(200);
  });

  it("an imported module's layout is accepted; removing the module keeps the view readable", async () => {
    await setModules(["canvas", "calendar"]);
    const created = await post(tagId, { name: `Calendar ${stamp}`, layout: "calendar", visible_fields: ["title", "due"], layout_config: { date_field: "due" } });
    expect(created.status).toBe(201);
    const viewId = ((await created.json()) as { id: string }).id;
    await setModules(["canvas"]);
    const exec = await app.request(`/api/tags/${tagId}/views/${viewId}/exec`);
    expect(exec.status).toBe(200);
    expect(((await exec.json()) as { view: { layout_config: Record<string, unknown> } }).view.layout_config).toEqual({ date_field: "due" });
    // Other changes to it still go through; only taking a missing layout is refused.
    expect((await patch(tagId, viewId, { name: `Calendar renamed ${stamp}` })).status).toBe(200);
  });

  // A tag's view takes the same per-key `layout_config_patch` as a note's whiteboard tab (functionRefs.patchView).
  it("a tag view's layout_config changes per key: named keys set, null removes, the others stay; the whole-object form still replaces", async () => {
    await setModules(["canvas", "calendar"]);
    const created = await post(tagId, { name: `Per key ${stamp}`, layout: "calendar", layout_config: { date_field: "due", other: 1 } });
    const viewId = ((await created.json()) as { id: string }).id;
    const config = async () => ((await (await app.request(`/api/tags/${tagId}/views/${viewId}/exec`)).json()) as { view: { layout_config: Record<string, unknown> } }).view.layout_config;
    expect((await patch(tagId, viewId, { layout_config_patch: { extra: { a: 1 }, other: null } })).status).toBe(200);
    expect(await config()).toEqual({ date_field: "due", extra: { a: 1 } });
    expect((await patch(tagId, viewId, { layout_config: { date_field: "due" } })).status).toBe(200);
    expect(await config()).toEqual({ date_field: "due" });
    expect((await patch(tagId, viewId, { layout_config: {}, layout_config_patch: { x: 1 } })).status).toBe(400);
  });

  it("a workspace from before the library (NULL) has every layout", async () => {
    await setModules(null);
    expect((await post(tagId, { name: `Board ${stamp}`, layout: "kanban" })).status).toBe(201);
  });

  it("migration 109 adds the three to recorded lists, once, and leaves NULL alone", async () => {
    const sql = readFileSync(fileURLToPath(new URL("../../db/migrations/109_view_modules.sql", import.meta.url)), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ids = (await client.query<{ id: string }>(
        `INSERT INTO workspaces (name, slug, modules) VALUES
           ('VM a', $1, '["rss"]'::jsonb), ('VM b', $2, '["calendar"]'::jsonb), ('VM c', $3, NULL)
         RETURNING id`, [`vm-a-${stamp}`, `vm-b-${stamp}`, `vm-c-${stamp}`])).rows.map((r) => r.id);
      await client.query(sql);
      await client.query(sql); // repeatable
      const rows = (await client.query<{ id: string; modules: string[] | null }>(
        `SELECT id, modules FROM workspaces WHERE id = ANY($1::uuid[])`, [ids])).rows;
      const byId = new Map(rows.map((r) => [r.id, r.modules]));
      expect(byId.get(ids[0]!)).toEqual(["rss", "calendar", "kanban", "gallery"]);
      expect(byId.get(ids[1]!)).toEqual(["calendar", "kanban", "gallery"]);
      expect(byId.get(ids[2]!)).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("the removed list layout: a request for it gets a table; migration 111 converts stored ones in order and imports the table", async () => {
    await setModules(null);
    const created = await post(tagId, { name: `Legacy list ${stamp}`, layout: "list" });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    // Saved views are function references since migration 188; the stored layout of the new one is the table.
    const refLayout = async (viewId: string) => (await q<{ function_id: string }>(
      `SELECT function_id FROM function_refs WHERE holder_node_id = $1 AND instance = $2`, [tagId, viewId])).rows[0]?.function_id;
    expect(await refLayout(id)).toBe("table");
    // Migration 111 ran on the collection_views column, before 188 moved the views: a list view stored in that column
    // (written directly), between others.
    const stored = async () => (await q<{ views: Array<{ id: string; layout: string }> | null }>(
      `SELECT collection_views AS views FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!.views ?? [];
    await seedQ(`UPDATE content_nodes SET collection_views = COALESCE(collection_views, '[]'::jsonb) || $2::jsonb WHERE id = $1`,
      [tagId, JSON.stringify([{ id: `old-${stamp}`, tag_id: tagId, name: `Old ${stamp}`, layout: "list", filters: [], sorts: [], group_by: "due", visible_fields: ["title"], layout_config: {}, pin_order: 9 }])]);
    const before = (await stored()).map((v) => v.id);
    const sql = readFileSync(fileURLToPath(new URL("../../db/migrations/111_table_view_module.sql", import.meta.url)), "utf8");
    await seedQ(sql);
    await seedQ(sql); // repeatable
    const after = await stored();
    expect(after.map((v) => v.id)).toEqual(before);
    expect(after.every((v) => v.layout !== "list")).toBe(true);
    expect(after.find((v) => v.id === `old-${stamp}`)).toMatchObject({ layout: "table", group_by: "due" });
    // A workspace that records its modules gets the table, once; NULL stays NULL.
    // The legacy list is data the migration reads; modules_off/modules_confirmed (#634) no longer feed it.
    await q(`UPDATE workspaces SET modules = '["rss"]'::jsonb WHERE id = $1`, [WS]);
    await seedQ(sql);
    await seedQ(sql);
    expect((await q<{ modules: string[] }>(`SELECT modules FROM workspaces WHERE id = $1`, [WS])).rows[0]!.modules).toEqual(["rss", "table"]);
  });
});
