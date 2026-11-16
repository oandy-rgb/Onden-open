// Saved views of a note's children (services/noteViews.ts,
// docs/architecture/views-as-modules.md 「檢視的來源」) through the routes:
// the rows are the note's live, shown children within the reader's read set;
// changing a view needs the note's edit permission (a space viewer may look,
// not change); a note the reader cannot read is a 404 like a missing one.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { dayLens } from "../services/dayLens.js";
import { calendarDayOf } from "@onden/markdown";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));

let owner: ActorCtx = { id: "nv-owner", name: "Owner", role: "admin", type: "human" };
let editor: ActorCtx = { id: "nv-editor", name: "Editor", role: "editor", type: "human" };
let viewer: ActorCtx = { id: "nv-viewer", name: "Viewer", role: "editor", type: "human" };
let outsider: ActorCtx = { id: "nv-outsider", name: "Outsider", role: "editor", type: "human" };
let current: ActorCtx = owner;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", current); await next(); });
app.route("/api/nodes", nodesRouter);

const json = { "content-type": "application/json" };
const as = (actor: ActorCtx) => { current = actor; };
const list = (id: string) => app.request(`/api/nodes/${id}/views`);
const post = (id: string, body: unknown) => app.request(`/api/nodes/${id}/views`, { method: "POST", headers: json, body: JSON.stringify(body) });
const patch = (id: string, viewId: string, body: unknown) =>
  app.request(`/api/nodes/${id}/views/${viewId}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });
const del = (id: string, viewId: string) => app.request(`/api/nodes/${id}/views/${viewId}`, { method: "DELETE" });
const exec = (id: string, viewId: string) => app.request(`/api/nodes/${id}/views/${viewId}/exec`);

type Exec = { rows: Array<{ id: string; title: string; updated_at: string; attributes: Record<string, string | null> }>; total: number;
  view: { layout: string; field_meta: Record<string, { type: string }>; group_field_options: string[] | null } };

async function note(title: string, parentId: string | null, extra: { hidden?: boolean } = {}): Promise<string> {
  return (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, hidden)
     VALUES ($1,'manual','content',$2,$3,'',$4,$5) RETURNING id::text`,
    [workspaceId, title, `nv-${randomUUID().slice(0, 8)}`, parentId, extra.hidden ?? false])).rows[0]!.id;
}

describe.skipIf(!isTestDb)("a note's views of its children (DB)", () => {
  let tagId = "", space = "";
  // Each test gets a family of its own (a parent note, its children and an
  // unrelated note in the shared space) and, where it needs one, its own
  // Shelf view: no test reads a view, an event or an updated_at another left.
  type Family = { parent: string; first: string; second: string; hiddenChild: string; grandchild: string; unrelated: string; parentUpdatedAt: string };
  async function family(): Promise<Family> {
    const parent = await note("Reading list", null);
    const first = await note("Dune", parent);
    const second = await note("Emma", parent);
    const hiddenChild = await note("Hidden", parent, { hidden: true });
    const grandchild = await note("Chapter 1", first);
    const unrelated = await note("Elsewhere", null);
    await putInSpace(parent, space);
    await putInSpace(unrelated, space);
    for (const id of [first, second]) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, tagId]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1,$2,'stage','doing','text'), ($1,$3,'stage','done','text')`,
      [workspaceId, first, second]);
    const parentUpdatedAt = (await q<{ t: string }>(`SELECT updated_at::text AS t FROM content_nodes WHERE id = $1`, [parent])).rows[0]!.t;
    return { parent, first, second, hiddenChild, grandchild, unrelated, parentUpdatedAt };
  }
  /** The editor's Shelf view on `parent`. */
  async function shelf(parent: string): Promise<string> {
    as(editor);
    const created = await post(parent, { name: "Shelf", layout: "table", visible_fields: ["title", "stage", "updated_at"] });
    expect(created.status).toBe(201);
    return ((await created.json()) as { id: string }).id;
  }

  beforeAll(async () => {
    // The view modules (table, calendar…) must be known for the import gate.
    registerShippedModules();
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Note views',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    editor = await persistActor(workspaceId, editor);
    viewer = await persistActor(workspaceId, viewer);
    outsider = await persistActor(workspaceId, outsider);
    owner = await persistActor(workspaceId, owner); // the last human admin persisted is the owner
    space = await makeSpace(workspaceId, `nv-${randomUUID()}`, [
      { id: owner.id, role: "manager" }, { id: editor.id, role: "editor" }, { id: viewer.id, role: "viewer" },
    ]);
    tagId = (await seedClassTag(workspaceId, { name: `Book ${randomUUID().slice(0, 6)}`, nodeSlug: `nv-book-${randomUUID().slice(0, 8)}`,
      fields: [{ name: "stage", type: "select", options: ["todo", "doing", "done"] }, { name: "pages", type: "number" }] })).tagId;
  });

  it("an editor of the note adds a view; its rows are the shown children with the children's fields", async () => {
    const { parent, first, hiddenChild, grandchild, unrelated } = await family();
    const id = await shelf(parent);
    const views = ((await (await list(parent)).json()) as { views: Array<{ id: string; name: string; node_id: string }> }).views;
    expect(views).toEqual([expect.objectContaining({ id, name: "Shelf", node_id: parent })]);

    const result = (await (await exec(parent, id)).json()) as Exec;
    // Not the hidden child, not a grandchild, not an unrelated note.
    expect(result.rows.map((r) => r.title).sort()).toEqual(["Dune", "Emma"]);
    expect(result.rows.map((r) => r.id)).not.toContain(hiddenChild);
    expect(result.rows.map((r) => r.id)).not.toContain(grandchild);
    expect(result.rows.map((r) => r.id)).not.toContain(unrelated);
    expect(result.total).toBe(2);
    expect(result.rows.find((r) => r.id === first)?.attributes.stage).toBe("doing");
    expect(result.view.field_meta).toMatchObject({ stage: { type: "select" }, pages: { type: "number" } });

    // A board groups by the children's select field in its declared order.
    expect((await patch(parent, id, { layout: "kanban", group_by: "stage" })).status).toBe(200);
    const board = (await (await exec(parent, id)).json()) as Exec;
    expect(board.view.layout).toBe("kanban");
    expect(board.view.group_field_options).toEqual(["todo", "doing", "done"]);
  });

  it("a row's updated_at is an ISO instant the calendar's date rule places on its day", async () => {
    // A calendar view without a date field of its own falls back to
    // updated_at (frontend calendarGrid.pickDateField). timestamptz::text
    // ("… 03:00:00.12+00") has an hour-only zone calendarDayOf does not read,
    // so every row was "undated" and the grid stayed empty.
    const { parent, first } = await family();
    const id = await shelf(parent);
    const result = (await (await exec(parent, id)).json()) as Exec;
    const row = result.rows.find((r) => r.id === first)!;
    const db = (await q<{ ms: string; day: string }>(
      `SELECT floor(extract(epoch FROM updated_at) * 1000)::bigint::text AS ms, (updated_at AT TIME ZONE 'UTC')::date::text AS day
         FROM content_nodes WHERE id = $1`, [first])).rows[0]!;
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(row.updated_at)).toBe(Number(db.ms));
    expect(calendarDayOf(row.updated_at, "UTC")).toBe(db.day);
    // The visible updated_at column carries the same value.
    expect(row.attributes.updated_at).toBe(row.updated_at);
  });

  it("names stay unique per note; rename and delete work", async () => {
    const { parent } = await family();
    await shelf(parent);
    const a = ((await (await post(parent, { name: "A" })).json()) as { id: string }).id;
    expect((await post(parent, { name: "A" })).status).toBe(409);
    expect((await patch(parent, a, { name: "Shelf" })).status).toBe(409);
    expect((await patch(parent, a, { name: "B" })).status).toBe(200);
    expect((await del(parent, a)).status).toBe(200);
    const names = ((await (await list(parent)).json()) as { views: Array<{ name: string }> }).views.map((v) => v.name);
    expect(names).toEqual(["Shelf"]);
  });

  it("the whiteboard is stored as a tab: a canvas view with its place and a hidden flag, and tabs list by place", async () => {
    const { parent } = await family();
    as(owner);
    const table = ((await (await post(parent, { name: "Shelf", pin_order: 0 })).json()) as { id: string }).id;
    const board = await post(parent, { name: "Canvas", layout: "canvas", pin_order: 1 });
    expect(board.status).toBe(201);
    const boardId = ((await board.json()) as { id: string }).id;
    const read = async () => ((await (await list(parent)).json()) as { views: Array<{ id: string; layout: string; pin_order: number; layout_config: Record<string, unknown> }> }).views;
    expect((await read()).map((v) => [v.layout, v.pin_order])).toEqual([["table", 0], ["canvas", 1]]);
    // Moving the tabs is a pin_order patch; removing the tab keeps the record, flagged hidden.
    expect((await patch(parent, boardId, { pin_order: 0 })).status).toBe(200);
    expect((await patch(parent, table, { pin_order: 1 })).status).toBe(200);
    expect((await read()).map((v) => v.layout)).toEqual(["canvas", "table"]);
    expect((await patch(parent, boardId, { layout_config: { hidden: true } })).status).toBe(200);
    expect((await read())[0]).toMatchObject({ layout: "canvas", layout_config: { hidden: true } });
    // Nothing runs for it: its cards live on the board, and the children are untouched.
    const children = await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE parent_id = $1 AND deleted_at IS NULL`, [parent]);
    expect(Number(children.rows[0]!.n)).toBeGreaterThan(0);
  });

  it("the 「內容」 tab is a stored tab too: its place and hidden flag are written key by key, and the text is not touched", async () => {
    const { parent } = await family();
    as(owner);
    await seedQ(`UPDATE content_nodes SET markdown = 'still here' WHERE id = $1`, [parent]);
    const table = ((await (await post(parent, { name: "Shelf", pin_order: 0 })).json()) as { id: string }).id;
    const created = await post(parent, { name: "Content", layout: "content", pin_order: 1, layout_config: { hidden: true } });
    expect(created.status).toBe(201);
    const contentId = ((await created.json()) as { id: string }).id;
    const read = async () => ((await (await list(parent)).json()) as { views: Array<{ id: string; layout: string; pin_order: number; layout_config: Record<string, unknown> }> }).views;
    expect((await read()).map((v) => [v.layout, v.layout_config.hidden ?? null])).toEqual([["table", null], ["content", true]]);
    // Two devices change different keys of the one record: neither overwrites the other.
    expect((await patch(parent, contentId, { layout_config_patch: { opens_first: true } })).status).toBe(200);
    expect((await patch(parent, contentId, { layout_config_patch: { hidden: null }, pin_order: 0 } as never)).status).toBe(200);
    expect((await patch(parent, table, { pin_order: 1 })).status).toBe(200);
    const after = await read();
    expect(after.map((v) => v.layout)).toEqual(["content", "table"]);
    expect(after[0]!.layout_config).toEqual({ opens_first: true });
    expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [parent])).rows[0]!.markdown).toBe("still here");
  });

  it("a canvas tab is accepted whatever the stored module list says: the whiteboard is always on", async () => {
    const { parent } = await family();
    as(owner);
    await setModulesOn(workspaceId, ["table"]);
    try {
      const res = await post(parent, { name: "Canvas", layout: "canvas" });
      expect(res.status).toBe(201);
    } finally {
      await setModulesOn(workspaceId, null);
    }
  });

  it("the slides tab is always on: a note's view even when the workspace's stored module list lacks slides", async () => {
    const { parent } = await family();
    as(owner);
    const created = await post(parent, { name: "Slides", layout: "slides", pin_order: 2 });
    expect(created.status).toBe(201);
    const slidesId = ((await created.json()) as { id: string }).id;
    const other = ((await (await post(parent, { name: "Shelf2", layout: "table" })).json()) as { id: string }).id;
    await setModulesOn(workspaceId, ["table"]);
    try {
      const again = await post(parent, { name: "Slides again", layout: "slides" });
      expect(again.status).toBe(201);
      const changed = await patch(parent, other, { layout: "slides" });
      expect(changed.status).toBe(200);
    } finally {
      await setModulesOn(workspaceId, null);
    }
    const layouts = ((await (await list(parent)).json()) as { views: Array<{ id: string; layout: string }> }).views;
    expect(layouts.find((v) => v.id === slidesId)?.layout).toBe("slides");
    expect(layouts.find((v) => v.id === other)?.layout).toBe("slides");
  });

  it("a space viewer sees and runs the views but may not change them", async () => {
    const { parent } = await family();
    await shelf(parent);
    as(viewer);
    const views = ((await (await list(parent)).json()) as { views: Array<{ id: string }> }).views;
    expect(views.length).toBe(1);
    expect((await exec(parent, views[0]!.id)).status).toBe(200);
    expect((await post(parent, { name: "Mine" })).status).toBe(403);
    expect((await patch(parent, views[0]!.id, { name: "Renamed" })).status).toBe(403);
    expect((await del(parent, views[0]!.id)).status).toBe(403);
    as(owner);
    expect(((await (await list(parent)).json()) as { views: Array<{ name: string }> }).views.map((v) => v.name)).toEqual(["Shelf"]);
  });

  it("someone outside the note's space gets 404 everywhere", async () => {
    const { parent } = await family();
    const viewId = await shelf(parent);
    as(outsider);
    expect((await list(parent)).status).toBe(404);
    expect((await exec(parent, viewId)).status).toBe(404);
    expect((await post(parent, { name: "Sneaky" })).status).toBe(404);
    expect((await patch(parent, viewId, { name: "Sneaky" })).status).toBe(404);
    expect((await del(parent, viewId)).status).toBe(404);
  });

  it("a tag is not a note here, and a malformed id is a 404", async () => {
    as(owner);
    expect((await list(tagId)).status).toBe(404);
    expect((await post(tagId, { name: "X" })).status).toBe(404);
    expect((await list("not-a-uuid")).status).toBe(404);
  });

  it("a view layout is accepted whatever the workspace imported (views are always on)", async () => {
    const { parent } = await family();
    as(owner);
    await setModulesOn(workspaceId, []);
    try {
      expect((await post(parent, { name: "Month", layout: "calendar" })).status).toBe(201);
    } finally {
      await setModulesOn(workspaceId, null);
    }
  });

  it("changing views leaves the note's updated_at alone and logs events about the note", async () => {
    const { parent, parentUpdatedAt } = await family();
    // This test's own view changes: the events after this point.
    const since = (await q<{ id: string }>(`SELECT coalesce(max(id), 0)::text AS id FROM domain_events`)).rows[0]!.id;
    const id = await shelf(parent);
    expect((await patch(parent, id, { name: "Shelf 2" })).status).toBe(200);
    const now = (await q<{ t: string }>(`SELECT updated_at::text AS t FROM content_nodes WHERE id = $1`, [parent])).rows[0]!.t;
    expect(now).toBe(parentUpdatedAt);
    const events = (await q<{ event_type: string; target_type: string; target_id: string }>(
      `SELECT event_type, target_type, target_id FROM domain_events WHERE workspace_id = $1 AND event_type LIKE 'COLLECTION_VIEW_%' AND id > $2`,
      [workspaceId, since])).rows;
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e).toMatchObject({ target_type: "node", target_id: parent });
  });

  it("a view change does not make the note \"last modified\": not in its row meta, not in the day lens", async () => {
    // The row the client stores (GET /api/nodes/:id, the same projection as
    // the bootstrap and the sync delta): only view events so far → no meta.
    const { parent, unrelated } = await family();
    await shelf(parent);
    as(owner);
    const row = (await (await app.request(`/api/nodes/${parent}`)).json()) as { last_modified_at: string | null; last_actor: string | null; recent_actors: string[] | null };
    expect(row.last_modified_at).toBeNull();
    expect(row.last_actor).toBeNull();
    expect(row.recent_actors ?? []).toEqual([]);
    // An agent changing a view of the note is not an agent edit of it; an
    // agent edit of the sibling is.
    await q(`INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id)
             VALUES ($1,'ai_agent','agent-1','COLLECTION_VIEW_UPDATED','node',$2), ($1,'ai_agent','agent-1','NODE_UPDATED','node',$3)`,
      [workspaceId, parent, unrelated]);
    const today = (await q<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]!.d;
    const lens = await dayLens(owner, workspaceId, today);
    const agentIds = lens.buckets.agent.items.map((n: { id: string }) => n.id);
    expect(agentIds).toContain(unrelated);
    expect(agentIds).not.toContain(parent);
  });
});
