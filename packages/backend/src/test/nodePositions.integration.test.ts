// Integration test for node_positions (migration 050) and board sections
// through services/boardStore.ts — the one writer of each (W23). Direct
// service calls against a real DB (the route wiring is thin).

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q, withTransaction } from "../db.js";
import { setNodePosition, clearSurface, readSections, writeSections, readPositionsForSurface } from "../services/boardStore.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

/** A surface's rows, unfiltered (the store's reads are actor-scoped). */
async function getPositionsForSurface(workspaceId: string, surface: string) {
  const r = await q<{ node_id: string; x: number; y: number; width: number | null; height: number | null; color: string | null; folded: boolean; sub_canvas_id: string | null }>(
    `SELECT node_id, x, y, width, height, color, folded, sub_canvas_id FROM node_positions WHERE workspace_id = $1 AND surface = $2`,
    [workspaceId, surface]);
  return r.rows.map((row) => ({ nodeId: row.node_id, x: row.x, y: row.y, width: row.width, height: row.height,
    color: row.color, folded: row.folded, subCanvasId: row.sub_canvas_id }));
}

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);
// A workspace of its own per test (beforeEach): the 'graph' surface is
// workspace-wide, and the upsert test lists it exactly.
let WS = "";
const workspaces: string[] = [];

async function mkNode(slug: string): Promise<string> {
  const r = await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown)
     VALUES ($1, 'content', 'manual', $2, $2, '') RETURNING id`,
    [WS, slug],
  );
  return r.rows[0]!.id;
}

describe.skipIf(!isTestDb)("node_positions (DB)", () => {
  let a = "", b = "";

  beforeEach(async () => {
    WS = randomUUID();
    workspaces.push(WS);
    await q(`INSERT INTO workspaces (id, name, slug) VALUES ($1, 'PosTest', $2)`, [WS, `pos-test-${WS}`]);
    a = await mkNode("pos-a");
    b = await mkNode("pos-b");
  });
  afterAll(async () => {
    await q(`DELETE FROM node_positions WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = ANY($1::uuid[])`, [workspaces]);
    await pool.end();
  });

  it("setNodePosition upserts a node's position on the 'graph' surface", async () => {
    await setNodePosition(WS, a, "graph", { x: 10, y: 20 });
    let pos = await getPositionsForSurface(WS, "graph");
    expect(pos).toEqual([{ nodeId: a, x: 10, y: 20, width: null, height: null, color: null, folded: false, subCanvasId: null }]);
    // upsert (same node, same surface) overwrites, doesn't duplicate
    await setNodePosition(WS, a, "graph", { x: 99, y: 99 });
    pos = await getPositionsForSurface(WS, "graph");
    expect(pos.length).toBe(1);
    expect(pos[0]!.x).toBe(99);
  });

  it("a node has independent positions per surface", async () => {
    await setNodePosition(WS, a, "canvas-1", { x: 1, y: 1 });
    await setNodePosition(WS, a, "canvas-2", { x: 2, y: 2 });
    expect((await getPositionsForSurface(WS, "canvas-1"))[0]!.x).toBe(1);
    expect((await getPositionsForSurface(WS, "canvas-2"))[0]!.x).toBe(2);
  });

  it("writeSections stores a board's frames and an empty list removes them", async () => {
    // Sections are written inside the caller's mutate(); here a bare transaction stands in for it.
    await withTransaction(() => writeSections(WS, a, [{ id: "s1", x: 0, y: 0, width: 100, height: 50 }]));
    expect(await readSections(a)).toEqual([{ id: "s1", x: 0, y: 0, width: 100, height: 50 }]);
    await withTransaction(() => writeSections(WS, a, []));
    expect(await readSections(a)).toEqual([]);
  });

  it("writeSections refuses to run outside its caller's transaction", async () => {
    await expect(writeSections(WS, a, [{ id: "s1", x: 0, y: 0, width: 100, height: 50 }])).rejects.toThrow(/transaction/);
    expect(await readSections(a)).toEqual([]);
  });

  it("the graph positions a person gets are only those of notes they may read (bootstrap, W23)", async () => {
    let member: ActorCtx = { id: "pos-member", name: "Member", role: "editor", type: "human" };
    member = await persistActor(WS, member);
    const mine = await makeSpace(WS, `pos-mine-${Date.now()}`, [{ id: member.id, role: "editor" }]);
    const theirs = await makeSpace(WS, `pos-theirs-${Date.now()}`, []);
    const seen = await mkNode(`pos-seen-${Date.now()}`);
    const hidden = await mkNode(`pos-hidden-${Date.now()}`);
    await putInSpace(seen, mine);
    await putInSpace(hidden, theirs);
    await setNodePosition(WS, seen, "graph", { x: 1, y: 1 });
    await setNodePosition(WS, hidden, "graph", { x: 2, y: 2 });
    const ids = (await readPositionsForSurface(member, WS, "graph")).map((p) => p.nodeId);
    expect(ids).toContain(seen);
    expect(ids).not.toContain(hidden);
  });

  it("deleting the card's node cascades its placements away (FK ON DELETE CASCADE)", async () => {
    const c = await mkNode("pos-c");
    await setNodePosition(WS, c, "graph", { x: 1, y: 1 });
    await seedQ(`DELETE FROM content_nodes WHERE id = $1`, [c]);
    expect((await getPositionsForSurface(WS, "graph")).some((p) => p.nodeId === c)).toBe(false);
  });

  it("clearSurface drops a whole surface", async () => {
    await setNodePosition(WS, a, "canvas-tmp", { x: 1, y: 1 });
    await withTransaction(() => clearSurface(WS, "canvas-tmp"));
    expect(await getPositionsForSurface(WS, "canvas-tmp")).toEqual([]);
  });
});
