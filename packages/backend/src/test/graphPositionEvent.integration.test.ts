// A hand-placed position on the global graph is shared data, so it is a written event (like a board card's position),
// one per burst of moves (services/boardWrites.ts moveGraphPosition); every move is still stamped.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import { countWritesWithoutStamp } from "../spine/stamps.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { moveGraphPosition } from "../services/boardWrites.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("graph position events", () => {
  let ws = "";
  let owner!: ActorCtx;
  let viewer!: ActorCtx;
  let agent!: ActorCtx;
  let current!: ActorCtx;
  let space = "";
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", current); await next(); });
  app.route("/api/nodes", nodeRouter);

  const move = (id: string, x: number, y: number) => app.request(`/api/nodes/${id}/position`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ surface: "graph", x, y }),
  });
  const note = async () => {
    current = owner;
    const res = await app.request("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: randomUUID(), title: `graph ${randomUUID().slice(0, 6)}`, markdown: "x", space_id: space }) });
    expect(res.status).toBeLessThan(300);
    return ((await res.json()) as { id: string }).id;
  };
  const events = async (id: string) => (await q<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM domain_events WHERE target_id = $1 AND event_type = 'GRAPH_POSITION_UPDATED' ORDER BY domain_events.id`, [id])).rows;
  const stored = async (id: string) => (await q<{ x: number; y: number }>(`SELECT x, y FROM node_positions WHERE node_id = $1 AND surface = 'graph'`, [id])).rows[0];

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: "Graph Owner", role: "admin", type: "human" });
    viewer = await persistActor(ws, { id: "", name: "Graph Viewer", role: "viewer", type: "human" });
    agent = await persistActor(ws, {
      id: "", name: "Graph Agent", role: "editor", type: "agent",
      tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
    });
    await seedQ(`UPDATE actors SET write_mode = 'suggest' WHERE id = $1::uuid`, [agent.id]);
    space = await makeSpace(ws, `graph ${Date.now()}`, [{ id: owner.id, permission: "edit" }, { id: viewer.id, permission: "view" }, { id: agent.id, permission: "edit" }]);
  });
  afterAll(async () => { await pool.end(); });

  it("the first move is an event; the moves of the same drag after it are not, but are all stored and stamped", async () => {
    const id = await note();
    const seq = async () => Number((await q<{ n: string }>(`SELECT next_seq::text AS n FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0]?.n ?? "1");
    const [seq0, bypass] = [await seq(), await countWritesWithoutStamp(ws)];
    current = owner;
    expect((await move(id, 10, 20)).status).toBe(200);
    expect(await events(id)).toEqual([{ payload: { fields: ["graph_position"], x: 10, y: 20 } }]);
    for (let i = 1; i <= 30; i++) expect((await move(id, 10 + i, 20 + i)).status).toBe(200);
    expect(await events(id)).toHaveLength(1); // 31 moves, one history entry
    expect(await stored(id)).toMatchObject({ x: 40, y: 50 });
    // every one of the 31 moves went through the write entry: one stamp each (the position table's own trigger arrives with S2)
    expect([await seq() - seq0, await countWritesWithoutStamp(ws) - bypass]).toEqual([31, 0]);
  });

  it("a move after the burst has ended is a new event", async () => {
    const id = await note();
    current = owner;
    await move(id, 1, 1);
    await seedQ(`UPDATE node_positions SET updated_at = now() - interval '10 seconds' WHERE node_id = $1 AND surface = 'graph'`, [id]);
    await move(id, 2, 2);
    expect(await events(id)).toHaveLength(2);
  });

  it("someone who may not edit the note cannot place it, and nothing is recorded", async () => {
    const id = await note();
    current = viewer;
    expect((await move(id, 5, 5)).status).toBe(403);
    expect(await events(id)).toHaveLength(0);
    expect(await stored(id)).toBeUndefined();
  });

  it("right after someone else moved the card (inside the 5 seconds), a person who may not edit and an agent in suggest mode are still refused", async () => {
    const id = await note();
    current = owner;
    expect((await move(id, 10, 10)).status).toBe(200);
    const before = (await events(id)).length;
    // no edit permission: the same refusal as for the first move, position unchanged
    current = viewer;
    expect((await move(id, 99, 99)).status).toBe(403);
    // suggest mode: an agent may not write the position directly, first move or burst move
    await expect(moveGraphPosition(agent, ws, id, { surface: "graph", x: 77, y: 77 })).rejects.toMatchObject({ code: "suggest_only" });
    expect(await stored(id)).toMatchObject({ x: 10, y: 10 });
    expect((await events(id)).length).toBe(before);
    // and on a card nobody has moved yet
    const fresh = await note();
    await expect(moveGraphPosition(agent, ws, fresh, { surface: "graph", x: 1, y: 1 })).rejects.toMatchObject({ code: "suggest_only" });
    expect(await stored(fresh)).toBeUndefined();
  });
});
