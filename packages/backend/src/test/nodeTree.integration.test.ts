// The tree and chain walks (services/nodeTree.ts, services/eventChain.ts):
// each option keeps the meaning its callers relied on, and a cycle in the data
// (which normal writes refuse, but a bad import or a hand edit can leave)
// ends the walk instead of looping until the statement dies.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q } from "../db.js";
import { subtreeIds, wouldCreateParentCycle } from "../services/nodeTree.js";
import { chainRootIds, eventChain } from "../services/eventChain.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const WS = "00000000-0000-0000-0000-0000000d25a1";
const OTHER_WS = "00000000-0000-0000-0000-0000000d25a2";
const stamp = Date.now();

async function node(label: string, parentId: string | null, extra: { trashed?: boolean; tag?: boolean; ws?: string } = {}): Promise<string> {
  const r = await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden, sort_order, parent_id, deleted_at)
     VALUES ($1,'manual',$2,$3,$4,'',false,0,$5,$6) RETURNING id::text`,
    [extra.ws ?? WS, extra.tag ? "class_tag" : "content", `d25 ${label} ${stamp}`, `d25-${label}-${stamp}`,
      parentId, extra.trashed ? new Date() : null],
  );
  return r.rows[0]!.id;
}

/** Insert events in ONE statement, so a cause may name an event inserted in
 *  the same statement (the foreign key is checked at its end). That is the
 *  only way to make a triggered_by cycle in an append-only log. */
async function events(spec: Array<{ cause: number | null; ws?: string }>): Promise<string[]> {
  const ids = (await q<{ id: string }>(
    `SELECT nextval(pg_get_serial_sequence('domain_events','id'))::text AS id FROM generate_series(1, $1)`,
    [spec.length],
  )).rows.map((r) => r.id);
  const values: string[] = [];
  const params: unknown[] = [];
  spec.forEach((s, i) => {
    params.push(ids[i], s.ws ?? WS, s.cause === null ? null : ids[s.cause]);
    const n = params.length;
    values.push(`($${n - 2}::bigint, $${n - 1}::uuid, 'system', 'd25-test', 'NODE_UPDATED', 'node', 'd25', $${n}::bigint)`);
  });
  await q(
    `INSERT INTO domain_events (id, workspace_id, actor_type, actor_id, event_type, target_type, target_id, triggered_by_event_id)
     VALUES ${values.join(", ")}`,
    params,
  );
  return ids;
}

const sorted = (ids: string[]): string[] => [...ids].sort();

describe.skipIf(!isTestDb)("subtreeIds", () => {
  // root ─┬─ a ── a1 ── a2
  //       ├─ t (trashed) ── t1
  //       └─ tag (class_tag) ── tagChild
  let root = "", a = "", a1 = "", a2 = "", t = "", t1 = "", tag = "", tagChild = "";

  beforeAll(async () => {
    for (const [id, slug] of [[WS, "d25-ws"], [OTHER_WS, "d25-ws-other"]]) {
      await q(`INSERT INTO workspaces (id, name, slug) VALUES ($1,'D25',$2) ON CONFLICT (id) DO NOTHING`, [id, slug]);
    }
    root = await node("root", null);
    a = await node("a", root);
    a1 = await node("a1", a);
    a2 = await node("a2", a1);
    t = await node("t", root, { trashed: true });
    t1 = await node("t1", t);
    tag = await node("tag", root, { tag: true });
    tagChild = await node("tagchild", tag);
  });

  it("live: skips a trashed node and everything under it", async () => {
    expect(sorted(await subtreeIds(WS, root, { lifecycle: "live" }))).toEqual(sorted([a, a1, a2, tag, tagChild]));
  });

  it("all: walks trashed nodes too; includeRoot puts the root first, then nearest first", async () => {
    const ids = await subtreeIds(WS, root, { lifecycle: "all", includeRoot: true });
    expect(ids[0]).toBe(root);
    expect(sorted(ids)).toEqual(sorted([root, a, a1, a2, t, t1, tag, tagChild]));
    expect(ids.indexOf(a2)).toBeGreaterThan(ids.indexOf(a1));
    expect(ids.indexOf(a1)).toBeGreaterThan(ids.indexOf(a));
  });

  it("skipTagDefinitions: does not enter a tag definition or its children", async () => {
    expect(sorted(await subtreeIds(WS, root, { lifecycle: "all", skipTagDefinitions: true }))).toEqual(sorted([a, a1, a2, t, t1]));
  });

  it("maxDepth: keeps nodes at most that many levels down", async () => {
    expect(sorted(await subtreeIds(WS, root, { lifecycle: "live", maxDepth: 2 }))).toEqual(sorted([a, a1, tag, tagChild]));
  });

  it("the root goes through the same filters: trashed under live, or another workspace, gives []", async () => {
    expect(await subtreeIds(WS, t, { lifecycle: "live", includeRoot: true })).toEqual([]);
    expect(await subtreeIds(WS, t, { lifecycle: "live" })).toEqual([]);
    expect(await subtreeIds(WS, t, { lifecycle: "all" })).toEqual([t1]);
    expect(await subtreeIds(OTHER_WS, root, { lifecycle: "all", includeRoot: true })).toEqual([]);
  });

  it("wouldCreateParentCycle: true for the node itself and any descendant (trashed too), false elsewhere", async () => {
    expect(await wouldCreateParentCycle(WS, root, root)).toBe(true);
    expect(await wouldCreateParentCycle(WS, root, a2)).toBe(true);
    expect(await wouldCreateParentCycle(WS, root, t1)).toBe(true);
    expect(await wouldCreateParentCycle(WS, a, root)).toBe(false);
    expect(await wouldCreateParentCycle(WS, a1, tagChild)).toBe(false);
  });

  it("a parent_id cycle in the data ends the walk, each node once", async () => {
    // x → y → z → x, plus w under z. Every node of the cycle is somebody's
    // descendant, so any of them can be the root.
    const x = await node("cx", null);
    const y = await node("cy", x);
    const z = await node("cz", y);
    const w = await node("cw", z);
    await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [x, z]);
    for (const start of [x, y, z]) {
      const ids = await subtreeIds(WS, start, { lifecycle: "all", includeRoot: true });
      expect(sorted(ids)).toEqual(sorted([x, y, z, w]));
      expect(ids[0]).toBe(start);
    }
    expect(sorted(await subtreeIds(WS, y, { lifecycle: "live" }))).toEqual(sorted([x, z, w]));
    // The upward walk ends too.
    expect(await wouldCreateParentCycle(WS, w, x)).toBe(false);
    expect(await wouldCreateParentCycle(WS, y, x)).toBe(true);
  });
});

describe.skipIf(!isTestDb)("eventChain / chainRootIds", () => {
  beforeAll(async () => {
    for (const [id, slug] of [[WS, "d25-ws"], [OTHER_WS, "d25-ws-other"]]) {
      await q(`INSERT INTO workspaces (id, name, slug) VALUES ($1,'D25',$2) ON CONFLICT (id) DO NOTHING`, [id, slug]);
    }
  });

  it("walks every descendant nearest first, with depth; includeRoot and maxDepth", async () => {
    // 0 ─┬─ 1 ── 3 ── 4
    //    └─ 2
    // 5 is another workspace's event claiming 0 as its cause (bad data).
    const [r, e1, e2, e3, e4] = await events([
      { cause: null }, { cause: 0 }, { cause: 0 }, { cause: 1 }, { cause: 3 }, { cause: 0, ws: OTHER_WS },
    ]);
    expect(await eventChain(WS, r!)).toEqual([
      { id: e1, depth: 1 }, { id: e2, depth: 1 }, { id: e3, depth: 2 }, { id: e4, depth: 3 },
    ]);
    expect((await eventChain(WS, r!, { includeRoot: true }))[0]).toEqual({ id: r, depth: 0 });
    expect((await eventChain(WS, r!, { maxDepth: 2 })).map((e) => e.id)).toEqual([e1, e2, e3]);
    expect(await eventChain(OTHER_WS, r!)).toEqual([]);
    const roots = await chainRootIds([e4!, e2!, r!], { maxDepth: 20 });
    expect(Object.fromEntries(roots)).toEqual({ [e4!]: r, [e2!]: r, [r!]: r });
    // Further than maxDepth from the root: the event is its own root.
    expect((await chainRootIds([e4!], { maxDepth: 2 })).get(e4!)).toBe(e4);
  });

  it("a triggered_by cycle in the data ends the walk, each event once", async () => {
    // 0 → 1 → 2 → 0, plus 3 under 2; and a self-caused event.
    const [c0, c1, c2, c3] = await events([{ cause: 2 }, { cause: 0 }, { cause: 1 }, { cause: 2 }]);
    expect((await eventChain(WS, c0!, { includeRoot: true })).map((e) => e.id)).toEqual([c0, c1, c2, c3]);
    // From 1: 2 at depth 1, then 0 and 3 at depth 2 (by id); 1 is not re-entered.
    expect((await eventChain(WS, c1!)).map((e) => e.id)).toEqual([c2, c0, c3]);
    const [self] = await events([{ cause: 0 }]);
    expect(await eventChain(WS, self!, { includeRoot: true })).toEqual([{ id: self, depth: 0 }]);
    // Upward: no root on a cycle, so each event maps to itself.
    expect((await chainRootIds([c3!], { maxDepth: 20 })).get(c3!)).toBe(c3);
  });
});
