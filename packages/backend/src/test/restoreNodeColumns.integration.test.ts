// What undoing a NODE_UPDATED event writes to the note's row, column by column.
//
// Pins the observable result of eventRestore/restore.ts (restoreNodeUpdated) for
// every column the update's SET builder handles and for each follow-up that
// rides on it (slug, media claim, governed-value retype, visibility hook), and
// compares it with what an ordinary save (PATCH /api/nodes/:id) of the same
// values leaves. Written before the restore's apply step moved into
// services/nodeUpdate.ts (applyNodeColumns), to show the move changed nothing a
// person can see.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { registerNodeHooks } from "../spine/nodeHooks.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { seedQ } from "./helpers/seedQ.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "restore-columns-admin", name: "Restore columns", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);

const send = async (url: string, method: string, body: unknown = {}) => {
  const res = await app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status, `${method} ${url}: ${await res.clone().text()}`).toBeLessThan(300);
  return res;
};
const create = async (body: Record<string, unknown>) => ((await (await send("/nodes", "POST", body)).json()) as { id: string }).id;
const patch = (id: string, body: Record<string, unknown>) => send(`/nodes/${id}`, "PATCH", body);
type Row = { title: string; slug: string; markdown: string; parent_id: string | null; hidden: boolean; order_key: string;
  presentation: unknown; node_type: string; source_type: string; updated_at: Date };
const row = async (id: string) => (await q<Row>(
  `SELECT title, slug, markdown, parent_id, hidden, order_key, presentation, node_type, source_type, updated_at
     FROM content_nodes WHERE id = $1`, [id])).rows[0]!;
const lastEvent = async (id: string) => (await q<{ id: string }>(
  `SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_UPDATED' ORDER BY domain_events.id DESC LIMIT 1`, [id])).rows[0]!.id;
const undo = async (id: string) => expect(await restoreEvent(await lastEvent(id), { actor, workspaceId })).toMatchObject({ restored: true });
const typeOf = async (id: string, key: string) => (await q<{ value_type: string }>(
  `SELECT value_type FROM node_attributes WHERE node_id = $1 AND key = $2`, [id, key])).rows[0]?.value_type;
const newTag = async (name: string, fields: unknown[] = []) => {
  const stamp = randomUUID().slice(0, 8);
  return (await seedClassTag(workspaceId, { name: `${name}-${stamp}`, nodeSlug: `${name}-${stamp}`, fields })).tagId;
};
const visibilityCalls: string[][] = [];

describe.skipIf(!isTestDb)("undoing a NODE_UPDATED writes the same columns an ordinary save writes", () => {
  beforeAll(async () => {
    registerShippedModules();
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Restore columns',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
    registerNodeHooks("restore-columns-probe", { visibilityCommitted: async (change) => { visibilityCalls.push([...change.nodeIds]); } });
  });
  // Tests are shuffled: the pool closes once, after the last file-level test.
  afterAll(async () => { await pool.end(); });

  it("title: the title comes back and the slug follows it, as after a rename", async () => {
    const id = await create({ title: "Column Alpha", markdown: "x" });
    const original = await row(id);
    await patch(id, { title: "Column Beta" });
    expect((await row(id)).slug).toBe("column-beta");
    await undo(id);
    const restored = await row(id);
    expect(restored.title).toBe("Column Alpha");
    expect(restored.slug).toBe(original.slug);
    expect(restored.markdown).toBe("x");
    expect(restored.updated_at.getTime()).toBeGreaterThan(original.updated_at.getTime());
  });

  it("title: a slug another note took meanwhile is not shared (the restored note gets a free one)", async () => {
    const id = await create({ title: "Column Gamma" });
    await patch(id, { title: "Column Delta" });
    const taker = await create({ title: "Column Gamma" });
    const takerSlug = (await row(taker)).slug;
    await undo(id);
    const restored = await row(id);
    expect(restored.title).toBe("Column Gamma");
    expect(restored.slug).not.toBe(takerSlug);
    expect(restored.slug).toMatch(/^column-gamma/);
    // An ordinary rename to the same title lands on the same slug.
    const control = await create({ title: "Column Epsilon" });
    await patch(control, { title: "Column Gamma" });
    expect((await row(control)).slug).toMatch(/^column-gamma/);
  });

  it("body: the earlier text comes back and the row's markdown is the stored text", async () => {
    const id = await create({ title: "Column body", markdown: "first line" });
    await patch(id, { markdown: "first line\nsecond line" });
    await undo(id);
    expect((await row(id)).markdown).toBe("first line");
  });

  it("parent: a note moved under another comes back out", async () => {
    const parent = await create({ title: "Column parent" });
    const id = await create({ title: "Column child" });
    await patch(id, { parent_id: parent });
    expect((await row(id)).parent_id).toBe(parent);
    const before = await row(id);
    await undo(id);
    const restored = await row(id);
    expect(restored.parent_id).toBeNull();
    expect(restored.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it("hidden: a tag shown again is hidden again, and the visibility hook fires for it", async () => {
    const tag = await newTag("hide");
    await patch(tag, { hidden: true });
    expect((await row(tag)).hidden).toBe(true);
    visibilityCalls.length = 0;
    await undo(tag);
    expect((await row(tag)).hidden).toBe(false);
    expect(visibilityCalls.flat()).toContain(tag);
  });

  it("order_key: the position comes back; an undo, unlike the reorder itself, moves updated_at", async () => {
    const id = await create({ title: "Column order" });
    const original = (await row(id)).order_key;
    // A key the note does not already have: which key a new note gets depends on how many root notes the workspace holds, so under a
    // shuffled order it was sometimes "a7" itself, the reorder changed nothing, no event was written and the undo had nothing to undo.
    const moved = original === "a7" ? "a8" : "a7";
    await patch(id, { order_key: moved });
    const afterReorder = await row(id);
    expect(afterReorder.order_key).toBe(moved);
    await undo(id);
    const restored = await row(id);
    expect(restored.order_key).toBe(original);
    expect(restored.updated_at.getTime()).toBeGreaterThan(afterReorder.updated_at.getTime());
  });

  it("an ordinary reorder keeps updated_at (the reference the undo above differs from)", async () => {
    const id = await create({ title: "Column order control" });
    const first = await row(id);
    const moved = first.order_key === "a7" ? "a8" : "a7"; // a real reorder: see the test above
    await patch(id, { order_key: moved });
    expect((await row(id)).order_key).toBe(moved);
    expect((await row(id)).updated_at.getTime()).toBe(first.updated_at.getTime());
  });

  it("presentation: the earlier page design comes back and claims the upload no note owns", async () => {
    const file = `${randomUUID().replaceAll("-", "")}.webp`;
    await seedQ(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id) VALUES ($1,$2,$3)`, [file, workspaceId, actor.id]);
    const id = await create({ title: "Column design" });
    const design = { cover: `/api/media/${file}` };
    // Seeded with SQL: the upload stays unclaimed, as if an older write had missed it.
    await seedQ(`UPDATE content_nodes SET presentation = $2 WHERE id = $1`, [id, JSON.stringify(design)]);
    await patch(id, { presentation: { cover: "" } });
    const owner = async () => (await q<{ node_id: string | null }>(`SELECT node_id::text FROM media_uploads WHERE filename = $1`, [file])).rows[0]!.node_id;
    expect(await owner()).toBeNull();
    await undo(id);
    expect((await row(id)).presentation).toEqual(design);
    expect(await owner()).toBe(id);
  });

  it("source_type: the earlier source comes back", async () => {
    const id = await create({ title: "Column kind" });
    await seedQ(`UPDATE content_nodes SET source_type = 'ai' WHERE id = $1`, [id]);
    await patch(id, { source_type: "manual" });
    const before = await row(id);
    expect(before.source_type).toBe("manual");
    await undo(id);
    expect((await row(id)).source_type).toBe("ai");
  });

  it("a tag moved out from under its parent comes back and retypes its notes' values", async () => {
    const shelf = await newTag("shelf", [{ name: "pages", type: "number" }]);
    const child = await newTag("paperback");
    const member = await create({ title: "Column member", tag_ids: [child] });
    await send(`/nodes/${member}/attributes/pages`, "PUT", { value: "240", value_type: "text" });
    expect(await typeOf(member, "pages")).toBe("text");
    // Under the shelf without the write that retypes (as before D94), then out of it.
    await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [child, shelf]);
    await patch(child, { parent_id: null });
    expect(await typeOf(member, "pages")).toBe("text");
    await undo(child);
    expect((await row(child)).parent_id).toBe(shelf);
    expect(await typeOf(member, "pages")).toBe("number");
  });
});
