// A note's parent and its space are two units (spine/stampedMerge/dbUnits.ts UNIT_SOURCES: content_nodes.parent, content_nodes.space) that the merge core merges
// one at a time; the database holds them together with a DEFERRED constraint trigger (db/schema.sql content_nodes_check_space: a note is in the space of its parent
// and of its children, checked at COMMIT). This file finds out what two nodes end with when each scenario of the brief is made through the PRODUCT's own routes
// (PATCH /api/nodes/:id, POST /api/spaces/move, POST /api/nodes, DELETE /api/spaces/:id, DELETE /api/nodes/:id and its purge), never with hand-written stamps.
// Proposal and the table of every such relation: docs/architecture/proposals/merge-cross-field-invariants-2026-11-19.md.
//
// Each scenario: A holds the world and the scenario's notes, B joins by snapshot (helpers/stampedWorld.ts), each writes on its own, then both are copied so that the
// exchange runs in both arrival orders (A's bundle first; B's first), each until nothing more is stored (at most 4 rounds). Per scenario two tests:
//   "today: …"   what happens now, asserted exactly (the refusal and its text, or the state both end in), so a change of behaviour is seen;
//   "desired"    both nodes identical, no bundle refused, the constraint holds on both, every write a person made is still held (its stamp is in sync_stamps or
//                sync_stamp_heads on both nodes: shown, or kept as a conflict head), and the end state does not depend on the order of arrival.
//                `it.fails` where that does not hold today, with the reason. NOT fixed here. The two share one run: if the run itself throws, `it.fails` would pass
//                for the wrong reason, so the "today" test of the same scenario (which asserts exactly how it fails) is what says the run happened.
// SAFETY: databases made from the migrated template (PGlite, or new databases on a `_test` server); nothing shared is touched.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode, type SourceWorld } from "./helpers/stampedWorld.js";
import { admit, bundleFor, expectSame, peerOf, peerStateOf, take, type Peer } from "./helpers/stampedBundleWorld.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? ""); // both engines: a node is a PGlite, or a database of the real server (helpers/distSim/postgresNodes.ts)

type Ids = Record<string, string>;
/** One write a person made, by the stamp the trigger gave it: (origin, seq) of one unit of content_nodes. */
type Written = { what: string; row: string; field: string; origin: string; seq: number };
type Refusal = { direction: string; code: string | undefined; status: number | undefined; message: string };
type OrderResult = {
  order: "A first" | "B first";
  refusals: Refusal[];
  rounds: number;
  /** null: the two nodes hold the same rows, stamps and heads (expectSame) */
  differ: string | null;
  /** per node: notes in a different space than their parent (the relation content_nodes_check_space holds at COMMIT) */
  broken: Record<string, string[]>;
  /** per node: live notes in a space that is deleted */
  inDeletedSpace: Record<string, string[]>;
  /** per node: writes of the scenario whose stamp neither node's units hold any more */
  lost: Record<string, string[]>;
  /** writes the receiver could not store because their row is gone (rules/trash.ts recoverLateEdits): handed back to their authors, not silent */
  lateEdits: string[];
  /** per node and note: parent / space / trashed, by the scenario's names */
  rows: Record<string, Record<string, string>>;
};
type Outcome = { orders: OrderResult[]; sameAcrossOrders: string | null; written: Written[] };

type Scenario = {
  setup: (a: Peer, world: SourceWorld) => Promise<Ids>;
  onA: (a: Peer, ids: Ids, world: SourceWorld) => Promise<Written[]>;
  onB: (b: Peer, ids: Ids, world: SourceWorld) => Promise<Written[]>;
  /** who writes second (a larger stamp: the per-unit winner where both wrote the same unit) */
  last: "A" | "B";
};

const note = (p: Peer, title: string, extra: Record<string, unknown> = {}): Promise<string> =>
  p.call("POST", "/api/nodes", { id: randomUUID(), title, markdown: title, space_id: p.space, ...extra }).then((r: { id: string }) => r.id);
const newSpace = (p: Peer, name: string): Promise<string> => p.call("POST", "/api/spaces", { name: `${name} ${randomUUID().slice(0, 4)}` }).then((r: { id: string }) => r.id);

/** The stamp the trigger gave to (row, field) of content_nodes on `p` just now. */
async function stampOf(p: Peer, what: string, row: string, field: string): Promise<Written> {
  const s = (await q<{ origin: string; seq: string }>(`SELECT origin, seq::text FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = $3`,
    [p.ws, row, field])).rows[0];
  if (!s) throw new Error(`${what}: no stamp on ${field}`);
  return { what, row, field, origin: s.origin, seq: Number(s.seq) };
}
/** PATCH the parent, as the tree's drag does; returns the write. */
async function reparent(p: Peer, what: string, node: string, parent: string | null): Promise<Written[]> {
  await p.call("PATCH", `/api/nodes/${node}`, { parent_id: parent });
  return [await stampOf(p, what, node, "parent")];
}
/** The move dialog: preview, then move with the epoch it showed (services/spaces.ts moveToSpace: the root is detached, the whole subtree changes space). */
async function moveToSpace(p: Peer, what: string, node: string, to: string): Promise<Written[]> {
  const detached = (await q<{ parent: string | null }>(`SELECT parent_id::text AS parent FROM content_nodes WHERE id = $1`, [node])).rows[0]?.parent != null;
  const preview = await p.call("GET", `/api/spaces/move-preview?node=${node}&to=${to}`);
  await p.call("POST", "/api/spaces/move", { node_id: node, to_space_id: to, membership_epoch: preview.membership_epoch });
  const subtree = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND space_id = $2 ORDER BY id`, [p.ws, to])).rows.map((r) => r.id);
  // a root that was already at the top keeps its parent (null → null writes no stamp): only a detach is a write of the parent
  const out = (await q(`SELECT 1 FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = 'parent'`, [p.ws, node])).rows.length && detached
    ? [await stampOf(p, `${what} (parent)`, node, "parent")] : [];
  for (const id of subtree) out.push(await stampOf(p, `${what} (space of ${id === node ? "root" : "subtree"})`, id, "space"));
  return out;
}

async function pair(setup: Scenario["setup"]) {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  const ids = await onNode(na, () => setup(a, world));
  const cap = await capture(na, world, 12_000);
  await fillFrom(nb, world, cap);
  const b = peerOf("B", nb, world);
  await admit(a, b);
  return { a, b, ids, world, nodes: [na, nb] };
}

/** Exchange until neither direction stores anything (or 4 rounds), `first` sending first. A refusal is recorded, not thrown. */
async function settle(first: Peer, second: Peer): Promise<{ refusals: Refusal[]; rounds: number; lateEdits: string[] }> {
  const refusals: Refusal[] = [], lateEdits: string[] = [];
  let rounds = 0;
  for (; rounds < 4; rounds++) {
    let stored = 0;
    for (const [from, to] of [[first, second], [second, first]] as const) {
      try {
        const r = await take(to, await bundleFor(from, to));
        stored += r.stored;
        for (const e of r.lateEdits ?? []) lateEdits.push(`${to.name} got a late edit of ${JSON.stringify(e).slice(0, 80)}`);
      } catch (e) {
        const err = e as { code?: string; status?: number; message?: string };
        refusals.push({ direction: `${from.name}→${to.name}`, code: err.code, status: err.status, message: String(err.message) });
      }
    }
    if (stored === 0) break;
  }
  return { refusals, rounds, lateEdits };
}

const brokenOn = (p: Peer) => onNode(p.node, async () => (await q<{ id: string }>(
  `SELECT c.id::text FROM content_nodes c JOIN content_nodes par ON par.id = c.parent_id
    WHERE c.workspace_id = $1 AND c.node_type <> 'class_tag' AND par.node_type <> 'class_tag' AND c.space_id IS DISTINCT FROM par.space_id ORDER BY c.id`, [p.ws])).rows.map((r) => r.id));
const inDeletedSpaceOn = (p: Peer) => onNode(p.node, async () => (await q<{ id: string }>(
  `SELECT c.id::text FROM content_nodes c JOIN spaces s ON s.id = c.space_id WHERE c.workspace_id = $1 AND c.deleted_at IS NULL AND s.deleted_at IS NOT NULL ORDER BY c.id`, [p.ws])).rows.map((r) => r.id));
/** The writes whose stamp this node no longer holds for that unit, as the shown value or another head. */
const lostOn = (p: Peer, written: Written[]) => onNode(p.node, async () => {
  const out: string[] = [];
  for (const w of written) {
    const held = await q(`SELECT 1 FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = $3 AND origin = $4 AND seq = $5
                          UNION ALL SELECT 1 FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = $3 AND origin = $4 AND seq = $5`,
      [p.ws, w.row, w.field, w.origin, w.seq]);
    if (!held.rows.length) out.push(w.what);
  }
  return out;
});
async function rowsOn(p: Peer, ids: Ids, world: SourceWorld): Promise<Record<string, string>> {
  const name = (v: string | null): string => v === null ? "-" : v === world.spaceA ? "S1" : v === world.spaceB ? "S2" : Object.entries(ids).find(([, id]) => id === v)?.[0] ?? "?";
  return onNode(p.node, async () => {
    const out: Record<string, string> = {};
    for (const [k, id] of Object.entries(ids)) {
      if (k.startsWith("S")) {
        const sp = (await q<{ deleted: boolean }>(`SELECT deleted_at IS NOT NULL AS deleted FROM spaces WHERE id = $1`, [id])).rows[0];
        out[k] = !sp ? "gone" : sp.deleted ? "deleted" : "live";
        continue;
      }
      const r = (await q<{ parent: string | null; space: string | null; trashed: boolean }>(`SELECT parent_id::text AS parent, space_id::text AS space, deleted_at IS NOT NULL AS trashed FROM content_nodes WHERE id = $1`, [id])).rows[0];
      // and whether the owner can open it (GET /api/nodes/:id; a trashed note is not opened there)
      const opens = r && !r.trashed ? await p.call("GET", `/api/nodes/${id}`).then(() => true, () => false) : true;
      out[k] = r ? `under ${name(r.parent)} in ${name(r.space)}${r.trashed ? ", trashed" : ""}${opens ? "" : ", cannot be opened"}` : "gone";
    }
    return out;
  });
}

/** Run one scenario: write on both, copy both, exchange in both orders; every node is closed before it returns (the result is plain data). */
async function run(sc: Scenario): Promise<Outcome> {
  const { a, b, ids, world, nodes } = await pair(sc.setup);
  const opened: RealNode[] = [...nodes];
  try {
    const written: Written[] = [];
    const A = async () => written.push(...await onNode(a.node, () => sc.onA(a, ids, world)));
    const B = async () => written.push(...await onNode(b.node, () => sc.onB(b, ids, world)));
    if (sc.last === "A") { await B(); await new Promise((r) => setTimeout(r, 5)); await A(); } else { await A(); await new Promise((r) => setTimeout(r, 5)); await B(); }
    const [a2n, b2n] = [await RealNode.open("a2", a.node!), await RealNode.open("b2", b.node!)];
    opened.push(a2n, b2n);
    const a2 = { ...a, node: a2n } as Peer, b2 = { ...b, node: b2n } as Peer;
    const orders: OrderResult[] = [];
    for (const [order, x, y] of [["A first", a, b], ["B first", b2, a2]] as const) {
      const s = await settle(x, y);
      const differ = await expectSame(x, y, order).then(() => null, (e: Error) => e.message.slice(0, 4000));
      const [pa, pb] = x.name === "A" ? [x, y] : [y, x];
      orders.push({
        order, refusals: s.refusals, rounds: s.rounds, differ, lateEdits: s.lateEdits,
        broken: { A: await brokenOn(pa), B: await brokenOn(pb) },
        inDeletedSpace: { A: await inDeletedSpaceOn(pa), B: await inDeletedSpaceOn(pb) },
        lost: { A: await lostOn(pa, written), B: await lostOn(pb, written) },
        rows: { A: await rowsOn(pa, ids, world), B: await rowsOn(pb, ids, world) },
      });
    }
    // the end state does not depend on the order of arrival (meaningful only where both orders converged)
    const sameAcrossOrders = orders.every((o) => o.differ === null && o.refusals.length === 0)
      ? await expectSame(a, a2, "the order of arrival").then(() => null, (e: Error) => e.message.slice(0, 400)) : "not converged";
    console.info(`[mergeSpaceParent] ${JSON.stringify(orders.map((o) => ({ order: o.order, refusals: o.refusals.map((r) => `${r.direction} ${r.code}`), rows: o.rows, lost: o.lost, lateEdits: o.lateEdits.length })))}`);
    return { orders, sameAcrossOrders, written };
  } finally {
    for (const n of opened) await n.close().catch(() => undefined);
  }
}
const once = (sc: Scenario) => { let p: Promise<Outcome> | null = null; return () => (p ??= run(sc)); };

/** What the brief asks of every scenario after the exchange. */
function expectDesired(o: Outcome): void {
  for (const r of o.orders) {
    expect(r.refusals, `${r.order}: no bundle refused`).toEqual([]);
    expect(r.differ, `${r.order}: both nodes identical`).toBeNull();
    expect(r.broken, `${r.order}: every note in its parent's space`).toEqual({ A: [], B: [] });
    expect(r.inDeletedSpace, `${r.order}: no live note in a deleted space`).toEqual({ A: [], B: [] });
    // nothing a person wrote disappears silently: still held (shown or a conflict head), or handed back as a late edit of a row that is gone
    if (!r.lateEdits.length) expect(r.lost, `${r.order}: every write still held`).toEqual({ A: [], B: [] });
  }
  expect(o.sameAcrossOrders, "the same end state in both arrival orders").toBeNull();
}
/** Today's stall: every round, both directions refused with the raw check_violation of content_nodes_check_space (SQLSTATE 23514, no refusal code of the bundle). */
function expectStall(o: Outcome): void {
  for (const r of o.orders) {
    expect(r.refusals.length).toBeGreaterThanOrEqual(2);
    for (const x of r.refusals) {
      expect(x.code).toBe("23514");
      expect(x.status).toBeUndefined();
      expect(x.message).toMatch(/^node [0-9a-f-]{36} is in a different space than its parent [0-9a-f-]{36}$/);
    }
    expect(new Set(r.refusals.map((x) => x.direction))).toEqual(new Set(["A→B", "B→A"]));
    expect(r.differ).not.toBeNull(); // the two nodes keep what each wrote: they never meet
  }
}

describe.skipIf(!isTestDb)("a note's parent and its space, merged as two units", () => {
  // (a) A reparents N under X inside S1 (parent only); B moves N to the top of S2 (parent + space)
  const a = (last: "A" | "B"): Scenario => ({
    last,
    setup: async (p) => { const r = await note(p, "R"); return { r, x: await note(p, "X"), n: await note(p, "N", { parent_id: r }) }; },
    onA: (p, ids) => reparent(p, "A: N under X", ids.n!, ids.x!),
    onB: (p, ids, w) => moveToSpace(p, "B: N to S2", ids.n!, w.spaceB),
  });
  describe("(a) A reparents N under X in S1, B moves N to S2 — A's write is later", () => {
    const outcome = once(a("A"));
    it("today: a permanent stall: A's parent X wins the parent unit, B's S2 the space unit, N would be in S2 under X in S1; COMMIT fails with check_violation in both directions, every round", async () => {
      expectStall(await outcome());
    }, 300_000);
    it.fails("desired: both nodes the same, the constraint holds, the losing move kept as a conflict head (fails: the bundle is refused at COMMIT, 23514)", async () => {
      expectDesired(await outcome());
    }, 300_000);
  });
  describe("(a) A reparents N under X in S1, B moves N to S2 — B's write is later", () => {
    const outcome = once(a("B"));
    it("today: converges: B's detach wins the parent unit, N is at the top of S2 on both, A's 'under X' is kept as a conflict head", async () => {
      const o = await outcome();
      for (const r of o.orders) expect(r.rows).toEqual({ A: { r: "under - in S1", x: "under - in S1", n: "under - in S2" }, B: { r: "under - in S1", x: "under - in S1", n: "under - in S2" } });
    }, 300_000);
    it("desired holds", async () => { expectDesired(await outcome()); }, 300_000);
  });

  // (b) no concurrent write to the same row: A moves C under P (both in S1); B moves P, with the subtree B knows, to S2
  describe("(b) A moves C under P in S1, B moves P (and its subtree as B knows it) to S2", () => {
    const outcome = once({
      last: "A",
      setup: async (p) => { const pp = await note(p, "P"); return { p: pp, q: await note(p, "Q", { parent_id: pp }), c: await note(p, "C") }; },
      onA: (p, ids) => reparent(p, "A: C under P", ids.c!, ids.p!),
      onB: (p, ids, w) => moveToSpace(p, "B: P to S2", ids.p!, w.spaceB),
    });
    it("today: a permanent stall: C comes out under P (S2) while C's space is still S1 — no unit had two writes, and still the bundle fails at COMMIT in both directions", async () => {
      const o = await outcome();
      expectStall(o);
      // each node keeps its own picture: A has C under P in S1; B has P and Q in S2 and C at the top of S1
      expect(o.orders[0]!.rows).toEqual({ A: { p: "under - in S1", q: "under p in S1", c: "under p in S1" }, B: { p: "under - in S2", q: "under p in S2", c: "under - in S1" } });
    }, 300_000);
    it("today: the stall takes everything after it hostage: an unrelated later edit on A does not reach B either", async () => {
      const { a: pa, b: pb, ids, world, nodes } = await pair(async (p) => { const pp = await note(p, "P"); return { p: pp, c: await note(p, "C"), u: await note(p, "Unrelated") }; });
      try {
        await onNode(pa.node, () => reparent(pa, "A: C under P", ids.c!, ids.p!));
        await onNode(pb.node, () => moveToSpace(pb, "B: P to S2", ids.p!, world.spaceB));
        const before = JSON.stringify(await peerStateOf(pb));
        await onNode(pa.node, () => pa.call("PATCH", `/api/nodes/${ids.u}`, { title: "edited later on A" }));
        const refused = await take(pb, await bundleFor(pa, pb)).then(() => null, (e: { code?: string; message?: string }) => e);
        expect(refused).toMatchObject({ code: "23514" });
        expect(JSON.stringify(await peerStateOf(pb))).toBe(before); // nothing written
        expect(await onNode(pb.node, async () => (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [ids.u])).rows[0]!.title)).toBe("Unrelated");
      } finally { for (const n of nodes) await n.close().catch(() => undefined); }
    }, 300_000);
    it.fails("desired: both nodes the same, every note in its parent's space (fails: the bundle is refused at COMMIT, 23514)", async () => {
      expectDesired(await outcome());
    }, 300_000);
  });

  // (c) A moves a subtree to S2 while B creates a new child inside it (still S1 on B)
  describe("(c) A moves P's subtree to S2, B creates K under P (in S1 on B)", () => {
    const k = randomUUID();
    const outcome = once({
      last: "B",
      setup: async (p) => { const pp = await note(p, "P"); return { p: pp, q: await note(p, "Q", { parent_id: pp }), k }; },
      onA: (p, ids, w) => moveToSpace(p, "A: P to S2", ids.p!, w.spaceB),
      onB: async (p, ids) => { await p.call("POST", "/api/nodes", { id: ids.k, title: "K", markdown: "K", parent_id: ids.p }); return [await stampOf(p, "B: K made under P", ids.k!, "*")]; },
    });
    it("today: a permanent stall: K arrives under P with the space it was made in (S1) while P is in S2; COMMIT fails in both directions, and K never reaches A", async () => {
      const o = await outcome();
      expectStall(o);
      expect(o.orders[0]!.rows.A.k).toBe("gone");
      expect(o.orders[0]!.rows.B.k).toBe("under p in S1");
    }, 300_000);
    it.fails("desired: K is in P's subtree on both, in P's space (fails: the bundle is refused at COMMIT, 23514)", async () => {
      expectDesired(await outcome());
    }, 300_000);
  });

  // (d) two space moves of one subtree: B moves P to S2, A moves P to S3; every row of the subtree is stamped by each move
  const d = (last: "A" | "B"): Scenario => ({
    last,
    setup: async (p) => { const pp = await note(p, "P"); return { p: pp, q: await note(p, "Q", { parent_id: pp }), S3: await newSpace(p, "S3") }; },
    onA: (p, ids) => moveToSpace(p, "A: P to S3", ids.p!, ids.S3!),
    onB: (p, ids, w) => moveToSpace(p, "B: P to S2", ids.p!, w.spaceB),
  });
  for (const last of ["A", "B"] as const) {
    describe(`(d) B moves P to S2, A moves P to S3 — ${last}'s move is later`, () => {
      const outcome = once(d(last));
      it(`today: converges: every row of the subtree was stamped by the same two moves, so the later move wins every row; the other move is a conflict head on each`, async () => {
        const o = await outcome();
        const to = last === "A" ? "S3" : "S2";
        for (const r of o.orders) for (const side of ["A", "B"]) expect(r.rows[side]).toEqual({ p: `under - in ${to}`, q: `under p in ${to}`, S3: "live" });
      }, 300_000);
      it("desired holds", async () => { expectDesired(await outcome()); }, 300_000);
    });
  }

  // (e1) a note moved into a space that the other node deleted
  describe("(e1) A moves N into S3, B deletes S3 (empty on B)", () => {
    const outcome = once({
      last: "B",
      setup: async (p) => ({ n: await note(p, "N"), S3: await newSpace(p, "S3") }),
      onA: (p, ids) => moveToSpace(p, "A: N to S3", ids.n!, ids.S3!),
      onB: async (p, ids) => { await p.call("DELETE", `/api/spaces/${ids.S3}`); return []; },
    });
    it("today: no refusal, and the two nodes silently disagree: B's deletion of S3 never reaches A (A: S3 live, N in it; B: S3 deleted, N in it and the owner cannot open it)", async () => {
      const o = await outcome();
      for (const r of o.orders) {
        expect(r.refusals).toEqual([]);
        expect(r.rows).toEqual({ A: { n: "under - in S3", S3: "live" }, B: { n: "under - in S3, cannot be opened", S3: "deleted" } });
        expect(r.differ).not.toBeNull(); // the digests differ (spaces, space_members, content_nodes): nothing said so
      }
    }, 300_000);
    it.fails("desired: both nodes the same, and no live note ends in a deleted space (fails: the deletion of a space is not carried at all — see the control below — and nothing joins spaces.deleted with the notes' space)", async () => {
      expectDesired(await outcome());
    }, 300_000);
  });
  describe("(e1, control) B deletes the empty S3, nobody else writes", () => {
    const outcome = once({
      last: "B",
      setup: async (p) => ({ n: await note(p, "N"), S3: await newSpace(p, "S3") }),
      onA: async () => [],
      onB: async (p, ids) => { await p.call("DELETE", `/api/spaces/${ids.S3}`); return []; },
    });
    it("today: the deletion of a space does not travel: B's bundle stores nothing on A, A keeps S3 live (a deleted space is outside the reader's scope, so neither its row nor its stamps are sent)", async () => {
      const o = await outcome();
      for (const r of o.orders) {
        expect(r.refusals).toEqual([]);
        expect(r.rows).toEqual({ A: { n: "under - in S1", S3: "live" }, B: { n: "under - in S1", S3: "deleted" } });
        expect(r.differ).not.toBeNull();
      }
    }, 300_000);
    it.fails("desired: both nodes the same (fails: the space's deletion is never sent)", async () => {
      expectDesired(await outcome());
    }, 300_000);
  });

  // (e2) a parent trashed on one side while the other moves a child across spaces; and the same with the parent purged
  describe("(e2) A trashes P (the trash takes C with it), B moves C to S2", () => {
    const outcome = once({
      last: "B",
      setup: async (p) => { const pp = await note(p, "P"); return { p: pp, c: await note(p, "C", { parent_id: pp }) }; },
      onA: async (p, ids) => { await p.call("DELETE", `/api/nodes/${ids.p}`); return [await stampOf(p, "A: P trashed", ids.p!, "deleted"), await stampOf(p, "A: C trashed with P", ids.c!, "deleted")]; },
      onB: (p, ids, w) => moveToSpace(p, "B: C to S2", ids.c!, w.spaceB),
    });
    it("today: converges: C ends at the top of S2 AND in the trash (A's cascade reached it as a separate unit), P trashed in S1", async () => {
      const o = await outcome();
      for (const r of o.orders) expect(r.rows.A).toEqual({ p: "under - in S1, trashed", c: "under - in S2, trashed" });
    }, 300_000);
    it("desired holds (the constraint holds; C is in the trash where its owner can restore it — see the proposal for whether a cascade should follow a note that moved out)", async () => {
      expectDesired(await outcome());
    }, 300_000);
  });
  describe("(e2) A trashes and purges P with C, B moves C to S2", () => {
    const outcome = once({
      last: "B",
      setup: async (p) => { const pp = await note(p, "P"); return { p: pp, c: await note(p, "C", { parent_id: pp }) }; },
      onA: async (p, ids) => {
        await p.call("DELETE", `/api/nodes/${ids.p}`);
        const preview = await p.call("GET", `/api/nodes/${ids.p}/purge-preview`);
        await p.call("POST", `/api/nodes/${ids.p}/purge`, { expected_ids: preview.ids });
        return [];
      },
      onB: (p, ids, w) => moveToSpace(p, "B: C to S2", ids.c!, w.spaceB),
    });
    it("today: converges: both rows are gone on both nodes; B's move had not seen the purge and is handed back as a late edit (rules/trash.ts), not stored", async () => {
      const o = await outcome();
      for (const r of o.orders) {
        expect(r.refusals).toEqual([]);
        expect(r.rows).toEqual({ A: { p: "gone", c: "gone" }, B: { p: "gone", c: "gone" } });
      }
    }, 300_000);
    it("desired holds", async () => { expectDesired(await outcome()); }, 300_000);
  });
});

// Two rows of the proposal's table that were 【推論】 "only the database holds it → a stall" (review of #1902). One is reachable and tested here; the other is not reachable:
//   one live personal space per owner (spaces_one_personal_idx): NOT reachable. A personal space's id is derived from (workspace, person) (migration 201, actors_sync_spaces:
//   onden_space_id('personal-space/<workspace>/<actor>'); 201 also gave the live ones made before it that id), so two nodes making it make ONE row; `owner` only ever goes to
//   NULL (services/spaces.ts orphanPersonalSpace) and `kind` only from personal to shared; no route deletes or restores a personal space (spaces.ts deletableSpace: shared only).
//   Two live personal rows for one owner need two ids, which nothing makes.
describe.skipIf(!isTestDb)("the same manual link made on two nodes under two ids (node_edges_unique_origin_idx)", () => {
  it("converges: the row is the key (source, target, type), so it is ONE row on both, its id the winning creation's; nothing is refused, in both arrival orders", async () => {
    const { a, b, ids, nodes } = await pair(async (p) => ({ s: await note(p, "S"), t: await note(p, "T") }));
    const opened = [...nodes];
    try {
      for (const p of [a, b]) await onNode(p.node, () => p.call("POST", "/api/edges", { source_node_id: ids.s, target_node_id: ids.t, edge_type: "related" }));
      const idOn = (p: Peer) => onNode(p.node, async () => (await q<{ id: string }>(`SELECT id::text FROM node_edges WHERE source_node_id = $1 AND target_node_id = $2`, [ids.s, ids.t])).rows.map((r) => r.id));
      const [madeA, madeB] = [await idOn(a), await idOn(b)];
      expect(madeA[0]).not.toBe(madeB[0]); // two ids for one link: the case the unique index would refuse
      const [a2n, b2n] = [await RealNode.open("a2", a.node!), await RealNode.open("b2", b.node!)];
      opened.push(a2n, b2n);
      const a2 = { ...a, node: a2n } as Peer, b2 = { ...b, node: b2n } as Peer;
      for (const [x, y] of [[a, b], [b2, a2]] as const) {
        expect((await settle(x, y)).refusals).toEqual([]);
        await expectSame(x, y);
        expect(await idOn(x)).toHaveLength(1);
      }
      await expectSame(a, a2, "the order of arrival");
    } finally { for (const n of opened) await n.close().catch(() => undefined); }
  }, 300_000);
});
