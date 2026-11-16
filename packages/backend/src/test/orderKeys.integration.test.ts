// Same-level order through the real routes (migration 200): a new note goes last, a move writes one row with a key between
// its neighbours, the answer carries the key and no integer, undo puts the earlier key back (or a fresh one between its old
// neighbours when it was taken), an older client's integer is translated, a key that grew too long respaces its group.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { sortChildren } from "@onden/markdown";
import { compareOrdered, keyBetween, ORDER_KEY_RESPACE_LENGTH } from "@onden/markdown/contract";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import pointersRouter from "../routes/pointers.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { buildSyncDelta } from "../services/sync/delta.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const admin: ActorCtx = { id: "ok-admin", name: "Admin", role: "admin", type: "human" };
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", admin); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/pointers", pointersRouter);

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe.skipIf(!isTestDb)("order keys through the routes (DB)", () => {
  let ws = "";
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    ws = await getWorkspaceId();
    Object.assign(admin, await persistActor(ws, admin));
  });

  const make = async (title: string, parent: string | null = null, body: Record<string, unknown> = {}) => {
    const res = await send("POST", "/api/nodes", { title, parent_id: parent, ...body });
    expect(res.status).toBe(201);
    return await res.json() as { id: string; order_key: string; order_stamp: string } & Record<string, unknown>;
  };
  const parentOf = async (title: string) => (await make(`${title} ${randomUUID()}`)).id;
  const keysOf = async (parent: string) => (await q<{ id: string; order_key: string }>(
    `SELECT id::text, order_key FROM content_nodes WHERE workspace_id = $1 AND parent_id = $2 AND deleted_at IS NULL ORDER BY order_key COLLATE "C", order_stamp COLLATE "C", id`, [ws, parent])).rows;
  const lastEvent = async (id: string) => (await q<{ id: string; tx_meta: { prev_field_values?: Record<string, unknown> } }>(
    `SELECT e.id::text AS id, e.tx_meta FROM domain_events e WHERE e.workspace_id = $1 AND e.target_id = $2 AND e.event_type = 'NODE_UPDATED' ORDER BY e.id::bigint DESC LIMIT 1`, [ws, id])).rows[0]!;

  it("a new note goes last among its siblings, and the answer carries a key and no integer", async () => {
    const parent = await parentOf("append");
    const a = await make("a", parent), b = await make("b", parent), c = await make("c", parent);
    expect([a, b, c].map((n) => n.order_key)).toEqual([...[a, b, c].map((n) => n.order_key)].sort());
    expect(new Set([a, b, c].map((n) => n.order_key)).size).toBe(3);
    expect(a).not.toHaveProperty("sort_order");
    expect(a.order_stamp).toMatch(/^\d{21}$/);
    expect((await keysOf(parent)).map((r) => r.id)).toEqual([a.id, b.id, c.id]);
  });

  it("moving one note writes one row, with a key between its new neighbours", async () => {
    const parent = await parentOf("move");
    const [a, b, c, d] = [await make("a", parent), await make("b", parent), await make("c", parent), await make("d", parent)];
    const before = new Map((await keysOf(parent)).map((r) => [r.id, r.order_key]));
    const key = keyBetween(a.order_key, b.order_key);
    const res = await send("PATCH", `/api/nodes/${d.id}`, { order_key: key });
    expect(res.status).toBe(200);
    const answer = await res.json() as Record<string, unknown>;
    expect(answer.order_key).toBe(key);
    expect(answer).not.toHaveProperty("sort_order");
    const after = await keysOf(parent);
    expect(after.map((r) => r.id)).toEqual([a.id, d.id, b.id, c.id]);
    const changed = after.filter((r) => before.get(r.id) !== r.order_key).map((r) => r.id);
    expect(changed).toEqual([d.id]);
    // The move is not an edit of the note: no body, and the event can undo it.
    expect((await lastEvent(d.id)).tx_meta.prev_field_values).toEqual({ order_key: d.order_key });
  });

  it("undo puts the earlier key back; when another note took it, a fresh key goes just before that note", async () => {
    const parent = await parentOf("undo");
    const [a, b, c] = [await make("a", parent), await make("b", parent), await make("c", parent)];
    await send("PATCH", `/api/nodes/${c.id}`, { order_key: keyBetween(null, a.order_key) });
    let event = await lastEvent(c.id);
    expect(await restoreEvent(event.id, { actor: admin, workspaceId: ws })).toMatchObject({ restored: true });
    expect((await keysOf(parent)).find((r) => r.id === c.id)!.order_key).toBe(c.order_key);
    expect((await keysOf(parent)).map((r) => r.id)).toEqual([a.id, b.id, c.id]);
    // c moves to the front; then b is dropped on c's old key; undoing c's move must not give two notes one key.
    await send("PATCH", `/api/nodes/${c.id}`, { order_key: keyBetween(null, a.order_key) });
    event = await lastEvent(c.id);
    await send("PATCH", `/api/nodes/${b.id}`, { order_key: c.order_key });
    const restored = await restoreEvent(event.id, { actor: admin, workspaceId: ws, force: true });
    expect(restored).toMatchObject({ restored: true });
    const rows = await keysOf(parent);
    expect(new Set(rows.map((r) => r.order_key)).size).toBe(3);
    const key = rows.find((r) => r.id === c.id)!.order_key;
    expect(key < c.order_key).toBe(true);
    expect(key > a.order_key).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([a.id, c.id, b.id]);
  });

  it("an integer from an older client (a queued offline write) is translated, not lost", async () => {
    const parent = await parentOf("legacy");
    // Rows as migration 200 left them: each carries the integer it had.
    const ids: string[] = [];
    for (const [i, sort] of [10, 20, 30].entries()) {
      const n = await make(`l${i}`, parent);
      await seedQ(`UPDATE content_nodes SET sort_order = $2 WHERE id = $1`, [n.id, sort]);
      ids.push(n.id);
    }
    const mover = await make("mover", parent);
    const res = await send("PATCH", `/api/nodes/${mover.id}`, { sort_order: 25 });
    expect(res.status).toBe(200);
    expect((await keysOf(parent)).map((r) => r.id)).toEqual([ids[0], ids[1], mover.id, ids[2]]);
    const second = await make("second", parent);
    expect((await send("PATCH", `/api/nodes/${second.id}`, { sort_order: -5 })).status).toBe(200);
    expect((await keysOf(parent))[0]!.id).toBe(second.id);
    // A create that still names an integer is placed the same way.
    const created = await make("created", parent, { sort_order: 15 });
    expect((await keysOf(parent)).map((r) => r.id).indexOf(created.id)).toBe(2);
  });

  it("refuses a key that is not a key, and keeps the note where it was", async () => {
    const parent = await parentOf("bad");
    const a = await make("a", parent);
    for (const order_key of ["", "a10", "a-", "A" + "0".repeat(26), "a0".repeat(200)]) {
      expect((await send("PATCH", `/api/nodes/${a.id}`, { order_key })).status, order_key).toBeGreaterThanOrEqual(400);
    }
    expect((await keysOf(parent))[0]!.order_key).toBe(a.order_key);
  });

  it("moving under another parent without saying where puts the note last there", async () => {
    const [one, two] = [await parentOf("one"), await parentOf("two")];
    const [x, y] = [await make("x", two), await make("y", two)];
    const mover = await make("m", one);
    expect((await send("PATCH", `/api/nodes/${mover.id}`, { parent_id: two })).status).toBe(200);
    expect((await keysOf(two)).map((r) => r.id)).toEqual([x.id, y.id, mover.id]);
  });

  it("a key that grew too long respaces its group in the same save, one row each, in the same order", async () => {
    const parent = await parentOf("respace");
    const rows = [] as Array<{ id: string; order_key: string }>;
    for (let i = 0; i < 6; i++) rows.push(await make(`r${i}`, parent));
    // Always drop into the same gap: the key grows by about a character per six moves.
    let low = rows[0]!.order_key;
    const high = rows[1]!.order_key;
    const mover = rows[5]!;
    let respaced = false;
    for (let i = 0; i < 400 && !respaced; i++) {
      const key = keyBetween(low, high);
      const answer = await (await send("PATCH", `/api/nodes/${mover.id}`, { order_key: key })).json() as { order_key: string };
      if (answer.order_key !== key) respaced = true;
      else low = key;
    }
    expect(respaced).toBe(true);
    const after = await keysOf(parent);
    expect(after.map((r) => r.id)).toEqual([rows[0]!.id, mover.id, rows[1]!.id, rows[2]!.id, rows[3]!.id, rows[4]!.id]);
    expect(Math.max(...after.map((r) => r.order_key.length))).toBeLessThanOrEqual(ORDER_KEY_RESPACE_LENGTH);
  });

  /** Six notes under a fresh parent, then moves into one gap until the group is respaced; returns what happened. */
  async function respaceGroup() {
    const parent = await parentOf("respace-sync");
    const rows = [] as Array<{ id: string; order_key: string; order_stamp: string }>;
    for (let i = 0; i < 6; i++) rows.push(await make(`r${i}`, parent));
    const cursor = Number((await q<{ max: string }>(`SELECT max(id)::text AS max FROM domain_events WHERE workspace_id = $1`, [ws])).rows[0]!.max);
    const copyOfB = rows.map((r) => ({ ...r }));  // a device that held the group before and has not synced since
    let low = rows[0]!.order_key;
    const mover = rows[5]!;
    let answer: { id: string; order_key: string; order_stamp: string } | null = null;
    for (let i = 0; i < 400 && answer === null; i++) {
      const key = keyBetween(low, rows[1]!.order_key);
      const body = await (await send("PATCH", `/api/nodes/${mover.id}`, { order_key: key })).json() as { id: string; order_key: string; order_stamp: string };
      if (body.order_key !== key) answer = body; else low = key;
    }
    expect(answer).not.toBeNull();
    return { parent, cursor, copyOfB, mover, answer: answer! };
  }
  const applyDelta = async (copy: Array<{ id: string; order_key: string; order_stamp: string }>, cursor: number) => {
    const delta = await buildSyncDelta(admin, ws, { since: cursor, known: [] });
    for (const row of delta.nodes.upsert as Array<{ id: string; order_key: string; order_stamp: string }>) {
      const held = copy.find((r) => r.id === row.id);
      if (held) { held.order_key = row.order_key; held.order_stamp = row.order_stamp; }
    }
    return copy;
  };

  it("after a respace another device's ordinary incremental sync ends in the server's order, with no re-bootstrap", async () => {
    const { parent, cursor, copyOfB } = await respaceGroup();
    const synced = sortChildren(await applyDelta(copyOfB, cursor));
    expect(synced.map((r) => r.id)).toEqual((await keysOf(parent)).map((r) => r.id));
    const server = new Map((await keysOf(parent)).map((r) => [r.id, r.order_key]));
    expect(synced.every((r) => server.get(r.id) === r.order_key)).toBe(true);
  });

  it("after a respace the device that sent the write, holding only the answer for the moved note, gets the other keys from its next sync", async () => {
    const { parent, cursor, copyOfB, mover, answer } = await respaceGroup();
    const copyOfA = copyOfB.map((r) => (r.id === mover.id ? { ...r, order_key: answer.order_key, order_stamp: answer.order_stamp } : r));
    const synced = await applyDelta(copyOfA, cursor);
    expect([...synced].sort(compareOrdered).map((r) => r.id)).toEqual((await keysOf(parent)).map((r) => r.id));
  });

  it("undoing a move made before a respace is not restored to a key of the old numbering: a later edit already took it back", async () => {
    const parent = await parentOf("respace-undo");
    const rows = [] as Array<{ id: string; order_key: string }>;
    for (let i = 0; i < 6; i++) rows.push(await make(`u${i}`, parent));
    // An early move: the last note to the front. Its event records the old key.
    const early = rows[5]!;
    expect((await send("PATCH", `/api/nodes/${early.id}`, { order_key: keyBetween(null, rows[0]!.order_key) })).status).toBe(200);
    const earlyEvent = await lastEvent(early.id);
    // Then enough moves into one gap that the group is respaced.
    const mover = rows[4]!;
    let low = rows[1]!.order_key, respaced = false;
    for (let i = 0; i < 400 && !respaced; i++) {
      const key = keyBetween(low, rows[2]!.order_key);
      const answer = await (await send("PATCH", `/api/nodes/${mover.id}`, { order_key: key })).json() as { order_key: string };
      if (answer.order_key !== key) respaced = true; else low = key;
    }
    expect(respaced).toBe(true);
    const before = await keysOf(parent);
    const result = await restoreEvent(earlyEvent.id, { actor: admin, workspaceId: ws, force: true });
    expect(result).toMatchObject({ code: "already_in_state", status: 409 });
    expect(await keysOf(parent)).toEqual(before);
  });

  it("a pointer goes last among its parent's pointers; a key or an integer can place it", async () => {
    const parent = await parentOf("pointers");
    const targets = [await make("t1"), await make("t2"), await make("t3")];
    const ids: string[] = [];
    for (const target of targets.slice(0, 2)) {
      const res = await send("POST", "/api/pointers", { target_id: target.id, parent_id: parent });
      expect(res.status).toBe(201);
      ids.push((await res.json() as { id: string }).id);
    }
    const first = (await q<{ order_key: string }>(`SELECT order_key FROM note_pointers WHERE id = $1`, [ids[0]])).rows[0]!.order_key;
    const res = await send("POST", "/api/pointers", { target_id: targets[2]!.id, parent_id: parent, order_key: keyBetween(null, first) });
    ids.unshift((await res.json() as { id: string }).id);
    const ordered = (await q<{ id: string }>(`SELECT id::text FROM note_pointers WHERE parent_id = $1 ORDER BY order_key COLLATE "C", order_stamp COLLATE "C", id`, [parent])).rows.map((r) => r.id);
    expect(ordered).toEqual(ids);
    expect((await send("POST", "/api/pointers", { target_id: targets[0]!.id, parent_id: null, order_key: "a10" })).status).toBeGreaterThanOrEqual(400);
  });
});
