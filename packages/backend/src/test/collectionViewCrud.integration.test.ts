// Saved-view CRUD through the routes after P4.1 batch 2 (views live in the
// class_tag node's collection_views jsonb array, not a table). Drives the full
// write-flip: create → list (ordered) → name-collision 409 (create and
// rename) → patch → exec → delete.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import tagsRouter from "../routes/tags.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

// View layouts come from the view modules, which the real app registers on start.
registerShippedModules();

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/tags", tagsRouter);

const editor: ActorCtx = { id: "cvc-editor", name: "Editor", role: "editor", type: "human" };
// Saved views are part of the global tag definition: the owner's to change.
const owner: ActorCtx = { id: "cvc-owner", name: "Owner", role: "admin", type: "human" };

const post = (tagId: string, body: unknown) =>
  app.request(`/api/tags/${tagId}/views`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const list = async (tagId: string) =>
  (await (await app.request(`/api/tags/${tagId}/views`)).json()) as { views: Array<{ id: string; name: string; pin_order: number; filters: unknown[] }> };
const patch = (tagId: string, viewId: string, body: unknown) =>
  app.request(`/api/tags/${tagId}/views/${viewId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const del = (tagId: string, viewId: string) => app.request(`/api/tags/${tagId}/views/${viewId}`, { method: "DELETE" });

describe.skipIf(!isTestDb)("saved-view CRUD via routes (DB)", () => {
  let WS = "", tagId = "";
  const stamp = Date.now();
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(editor, await persistActor(WS, editor));
    Object.assign(owner, await persistActor(WS, owner));
  });
  // A tag of its own per test: the list test compares the tag's whole view
  // list, so another test's views must not be on it.
  let seq = 0;
  beforeEach(async () => {
    const n = `${stamp}-${++seq}`;
    tagId = (await seedClassTag(WS, { name: `CVC ${n}`, slug: `cvc-${n}`, nodeSlug: `cvc-tag-${n}`,
      fields: [{ name: "stage", type: "text" }] })).tagId;
    currentActor = owner;
  });

  it("a member who is not the owner cannot add a view to a tag", async () => {
    currentActor = editor;
    expect((await post(tagId, { name: "Mine" })).status).toBe(403);
    currentActor = owner;
    expect((await list(tagId)).views.map((v) => v.name)).not.toContain("Mine");
  });

  it("create → list (ordered by pin_order) → name collision 409 → patch → delete", async () => {
    // Create two views with distinct pin_order (insert out of order).
    const r2 = await post(tagId, { name: "Second", layout: "table", pin_order: 2 });
    expect(r2.status).toBe(201);
    const r1 = await post(tagId, { name: "First", layout: "list", pin_order: 1 });
    expect(r1.status).toBe(201);
    const firstId = ((await r1.json()) as { id: string }).id;

    // List is ordered by pin_order then name (writes append out of order).
    let views = (await list(tagId)).views;
    expect(views.map((v) => v.name)).toEqual(["First", "Second"]);

    // Duplicate name on the same tag → 409, no second element.
    expect((await post(tagId, { name: "First" })).status).toBe(409);
    expect((await list(tagId)).views.filter((v) => v.name === "First").length).toBe(1);

    // Patch the first view's filters → reflected in the array element.
    expect((await patch(tagId, firstId, { filters: [{ field: "stage", op: "eq", value: "open" }] })).status).toBe(200);
    views = (await list(tagId)).views;
    expect(views.find((v) => v.id === firstId)?.filters).toEqual([{ field: "stage", op: "eq", value: "open" }]);

    // Delete the first view → gone from the list, the other survives.
    expect((await del(tagId, firstId)).status).toBe(200);
    const after = (await list(tagId)).views;
    expect(after.map((v) => v.name)).toEqual(["Second"]);

    // Patching a now-missing view → 404.
    expect((await patch(tagId, firstId, { name: "X" })).status).toBe(404);
  });

  it("a rename keeps the tag's view names unique, like create (409, nothing changed)", async () => {
    const a = ((await (await post(tagId, { name: `Alpha ${stamp}` })).json()) as { id: string }).id;
    const b = ((await (await post(tagId, { name: `Beta ${stamp}` })).json()) as { id: string }).id;

    // Renaming onto another view's name answers exactly like a duplicate create.
    const clash = await patch(tagId, b, { name: `Alpha ${stamp}`, layout: "kanban" });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ error: "name_collision" });
    const after = (await list(tagId)).views;
    expect(after.filter((v) => v.name === `Alpha ${stamp}`).map((v) => v.id)).toEqual([a]);
    // The whole PATCH was refused: the other key did not land either.
    expect(after.find((v) => v.id === b)).toMatchObject({ name: `Beta ${stamp}`, layout: "table" });

    // Keeping its own name (or changing only other keys) is not a collision.
    expect((await patch(tagId, b, { name: `Beta ${stamp}`, layout: "table" })).status).toBe(200);
    expect((await patch(tagId, a, { layout: "table" })).status).toBe(200);

    // Two concurrent renames onto one free name: the row lock lets one through.
    const statuses = (await Promise.all([
      patch(tagId, a, { name: `Gamma ${stamp}` }),
      patch(tagId, b, { name: `Gamma ${stamp}` }),
    ])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect((await list(tagId)).views.filter((v) => v.name === `Gamma ${stamp}`).length).toBe(1);

    await del(tagId, a);
    await del(tagId, b);
  });

  it("partial updates preserve the layout, filters and other saved settings", async () => {
    const config = {
      name: `Preserve ${stamp}`, layout: "gallery", sorts: [{ field: "title", dir: "desc" }],
      group_by: "stage", visible_fields: ["title", "stage"],
      layout_config: { cover: "image" }, pin_order: 7,
    };
    const created = await post(tagId, config);
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    const filters = [{ field: "title", op: "contains", value: "課程" }];
    expect((await patch(tagId, id, { filters })).status).toBe(200);
    expect((await list(tagId)).views.find((v) => v.id === id)).toMatchObject({ ...config, filters });

    expect((await patch(tagId, id, { layout: "table" })).status).toBe(200);
    expect((await list(tagId)).views.find((v) => v.id === id)).toMatchObject({ ...config, filters, layout: "table" });
    await del(tagId, id);
  });

  it("a date column filter with a value that is not a date is saved and runs as matching nothing, not a 500", async () => {
    // The view builder autosaves while a date is being typed ("2026-1").
    const typing = [{ field: "updated_at", op: "gt", value: "2026-1" }];
    const bad = [{ field: "updated_at", op: "gt", value: "2026-13-01" }];
    const created = await post(tagId, { name: `Typing ${stamp}`, filters: typing });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    expect((await patch(tagId, id, { filters: bad })).status).toBe(200);
    const run = await app.request(`/api/tags/${tagId}/views/${id}/exec`);
    expect(run.status).toBe(200);
    expect(((await run.json()) as { rows: unknown[] }).rows).toEqual([]);
    expect((await patch(tagId, id, { filters: [{ field: "sort_order", op: "lt", value: "ten" }] })).status).toBe(200);
    expect((await app.request(`/api/tags/${tagId}/views/${id}/exec`)).status).toBe(200);
  });

  it("a tag takes no slides view (the 「簡報」 tab is a note's), refused 422 on create and on changing a view's layout", async () => {
    const refused = await post(tagId, { name: "Slides", layout: "slides" });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: "view_layout_not_for_tags" });
    expect((await list(tagId)).views.map((v) => v.name)).not.toContain("Slides");

    const created = await post(tagId, { name: `Plain ${stamp}`, layout: "table" });
    const id = ((await created.json()) as { id: string }).id;
    const patched = await patch(tagId, id, { layout: "slides" });
    expect(patched.status).toBe(422);
    expect(await patched.json()).toMatchObject({ error: "view_layout_not_for_tags" });
    expect((await list(tagId)).views.find((v) => v.id === id)).toMatchObject({ layout: "table" });
    // Other layouts, the whiteboard included, are unchanged.
    expect((await patch(tagId, id, { layout: "kanban" })).status).toBe(200);
  });
});
