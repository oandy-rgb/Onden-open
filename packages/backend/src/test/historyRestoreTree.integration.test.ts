// D111 + the trash's removal: History is the one way back for a deleted note,
// and it keeps the tree whole. A live note never has a deleted parent — before
// this, an event restore of NODE_DELETED revived the root alone (its subtree
// stayed deleted unless "cascade" was ticked, and the preview defaulted it
// off), and could revive a child under a still-deleted parent.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import eventsRouter from "../routes/events.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/events", eventsRouter);

const json = (method: string, body: unknown = {}) =>
  ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const stamp = Date.now();
const create = async (label: string, parentId: string | null = null): Promise<string> => {
  const res = await app.request("/api/nodes", json("POST", { title: `hr ${label} ${stamp}`, parent_id: parentId }));
  expect(res.status, label).toBe(201);
  return ((await res.json()) as { id: string }).id;
};
const del = async (id: string) => expect((await app.request(`/api/nodes/${id}`, { method: "DELETE" })).status).toBe(200);
const restore = (eventId: string, body: Record<string, unknown> = {}) =>
  app.request(`/api/events/${eventId}/restore`, json("POST", body));
const preview = async (eventId: string) =>
  (await (await app.request(`/api/events/${eventId}/preview`)).json()) as { preview: Record<string, unknown> };
const deletedAt = async (id: string): Promise<string | null> =>
  (await q<{ d: string | null }>(`SELECT deleted_at AS d FROM content_nodes WHERE id = $1`, [id])).rows[0]!.d;
const isLive = async (id: string) => (await deletedAt(id)) === null;
/** The event currently holding a deleted note deleted. */
const deleteEventOf = async (id: string): Promise<string> =>
  (await q<{ e: string }>(`SELECT deleted_by_event_id::text AS e FROM content_nodes WHERE id = $1`, [id])).rows[0]!.e;
const createEventOf = async (id: string): Promise<string> =>
  (await q<{ id: string }>(
    `SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_CREATED' ORDER BY domain_events.id LIMIT 1`, [id],
  )).rows[0]!.id;
const deletedView = async (): Promise<Array<{ id: number | string; target_id: string; restorable: boolean }>> => {
  const res = await app.request("/api/events?deleted=1&limit=500");
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: Array<{ id: number | string; target_id: string; restorable: boolean }> }).events;
};

describe.skipIf(!isTestDb)("History restore keeps the tree whole (D111)", () => {
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const ws = await getWorkspaceId();
    currentActor = await persistActor(ws, { id: "hr-owner", name: "Owner", role: "admin", type: "human" });
  });

  it("restoring a deleted parent brings back its children, without ticking cascade", async () => {
    const p = await create("parent");
    const c = await create("child", p);
    const g = await create("grand", c);
    await del(p);
    expect(await isLive(c)).toBe(false);
    const deleteEvent = await deleteEventOf(p);

    const shown = await preview(deleteEvent);
    expect(shown.preview).toMatchObject({ kind: "node_undelete", currently_deleted: true, ancestor_count: 0, subtree_count: 2 });

    const res = await restore(deleteEvent, { cascade: false });
    expect(res.status).toBe(200);
    const restored = (await res.json()) as { restore_event_id: string };
    expect([await isLive(p), await isLive(c), await isLive(g)]).toEqual([true, true, true]);
    // Each child's way back is its own event, chained to the restore.
    const chained = await q<{ target_id: string }>(
      `SELECT target_id FROM domain_events WHERE event_type = 'NODE_UNDELETED' AND triggered_by_event_id = $1`,
      [restored.restore_event_id],
    );
    expect(chained.rows.map((r) => r.target_id).sort()).toEqual([c, g].sort());
  });

  it("restoring a child whose parent is deleted brings the parent back first", async () => {
    const p = await create("p2");
    const c = await create("c2", p);
    const sibling = await create("s2", p);
    await del(c);              // the child, on its own
    const childDelete = await deleteEventOf(c);
    await del(p);              // then its parent (with the sibling)
    expect(await isLive(sibling)).toBe(false);

    const shown = await preview(childDelete);
    expect(shown.preview).toMatchObject({ ancestor_count: 1, subtree_count: 0 });
    expect((shown.preview.ancestors as Array<{ id: string }>).map((a) => a.id)).toEqual([p]);

    expect((await restore(childDelete)).status).toBe(200);
    expect(await isLive(c)).toBe(true);
    expect(await isLive(p)).toBe(true);
    // Only the path comes back: the sibling was not part of this restore.
    expect(await isLive(sibling)).toBe(false);
    const parent = await q<{ parent_id: string }>(`SELECT parent_id FROM content_nodes WHERE id = $1`, [c]);
    expect(parent.rows[0]!.parent_id).toBe(p);
  });

  it("undoing 'created P' deletes P with its live child; undoing that brings both back", async () => {
    const p = await create("p3");
    const c = await create("c3", p);

    const shown = await preview(await createEventOf(p));
    expect(shown.preview).toMatchObject({ kind: "node_delete", currently_deleted: false, subtree_count: 1 });

    const res = await restore(await createEventOf(p));
    expect(res.status).toBe(200);
    const undo = (await res.json()) as { restore_event_id: string };
    expect(await isLive(p)).toBe(false);
    expect(await isLive(c), "the child is not left under a deleted parent").toBe(false);
    // The child's delete is chained to the undo, so it comes back with P.
    expect(await deleteEventOf(p)).toBe(undo.restore_event_id);
    const childCause = await q<{ t: string }>(
      `SELECT triggered_by_event_id::text AS t FROM domain_events WHERE id = $1`, [await deleteEventOf(c)]);
    expect(childCause.rows[0]!.t).toBe(undo.restore_event_id);

    expect((await restore(undo.restore_event_id)).status).toBe(200);
    expect([await isLive(p), await isLive(c)]).toEqual([true, true]);
  });

  it("History's Deleted view lists each delete to restore once, and drops it once restored", async () => {
    const p = await create("p4");
    const c = await create("c4", p);
    await del(p);
    const rows = await deletedView();
    const pRow = rows.find((r) => r.target_id === p);
    expect(pRow?.restorable).toBe(true);
    // The child comes back with its parent: not listed on its own.
    expect(rows.some((r) => r.target_id === c)).toBe(false);
    // A live note's old delete is not listed either.
    expect((await restore(String(pRow!.id))).status).toBe(200);
    const after = await deletedView();
    expect(after.some((r) => r.target_id === p || r.target_id === c)).toBe(false);
  });

  it("a deleted tag is listed in the Deleted view and comes back from it", async () => {
    const ws = await getWorkspaceId();
    const tagId = (await seedClassTag(ws, { name: `HR coll ${stamp}`, slug: `hr-coll-${stamp}`, nodeSlug: `tag-hr-coll-${stamp}` })).tagId;
    expect((await app.request(`/api/nodes/${tagId}`, { method: "DELETE" })).status).toBe(200);
    const row = (await deletedView()).find((r) => r.target_id === tagId);
    expect(row?.restorable).toBe(true);
    expect((await restore(String(row!.id))).status).toBe(200);
    expect(await isLive(tagId)).toBe(true);
  });

  it("the trash routes are gone", async () => {
    expect((await app.request("/api/nodes/trash")).status).toBe(404);
    expect((await app.request("/api/nodes/trash/empty", json("POST", { node_ids: [] }))).status).toBe(404);
  });
});
