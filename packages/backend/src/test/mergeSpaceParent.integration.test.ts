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
import { seedQ } from "./helpers/seedQ.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, makeCaller, openNode, type SourceWorld } from "./helpers/stampedWorld.js";
import { admit, bundleFor, expectSame, nodeIdOf, peerOf, resendAll, take, type Peer } from "./helpers/stampedBundleWorld.js";
import { readHave } from "../spine/stampedBundle.js";

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
  /** after the exchange went quiet: what one more exchange stored, and what sending everything again with an empty `have` stored, both directions (I3), and what refused */
  again: { stored: number; refusals: string[] };
  /** `space` stamps either node holds after the exchange that neither held before it: a merge or a derivation that stamped (migration 218: none) */
  newSpaceStamps: string[];
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
/** PATCH the parent, as the tree's drag does; returns the write (a detach to the top also writes the space the note is in: migration 218). */
async function reparent(p: Peer, what: string, node: string, parent: string | null): Promise<Written[]> {
  await p.call("PATCH", `/api/nodes/${node}`, { parent_id: parent });
  return [await stampOf(p, what, node, "parent"), ...(parent === null ? [await stampOf(p, `${what} (space)`, node, "space")] : [])];
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
  // the move writes the space of its root; the notes under it are in that space because of where they are (migration 218: no stamp of theirs)
  out.push(await stampOf(p, `${what} (space of the root)`, node, "space"));
  expect(subtree).toContain(node);
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

/** Every `space` stamp of content_nodes a node holds (the shown one and the other heads), as "row origin:seq". */
const spaceStampsOn = (p: Peer) => onNode(p.node, async () => new Set((await q<{ k: string }>(
  `SELECT row_key || ' ' || origin || ':' || seq AS k FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND field = 'space'
   UNION SELECT row_key || ' ' || origin || ':' || seq FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'content_nodes' AND field = 'space'`, [p.ws])).rows.map((r) => r.k)));
/** One more exchange, then everything sent again with an empty `have`, both directions: what was stored, and what was refused. */
async function onceMore(x: Peer, y: Peer): Promise<OrderResult["again"]> {
  const out: OrderResult["again"] = { stored: 0, refusals: [] };
  for (const step of [(f: Peer, t: Peer) => bundleFor(f, t).then((b) => take(t, b)), resendAll]) {
    for (const [f, t] of [[x, y], [y, x]] as const) {
      try { out.stored += (await step(f, t)).stored; } catch (e) { out.refusals.push(`${f.name}→${t.name} ${(e as { code?: string }).code}`); }
    }
  }
  return out;
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
    const spaceStampsBefore = new Set([...await spaceStampsOn(a), ...await spaceStampsOn(b)]);
    const orders: OrderResult[] = [];
    for (const [order, x, y] of [["A first", a, b], ["B first", b2, a2]] as const) {
      const s = await settle(x, y);
      const again = await onceMore(x, y);
      const newSpaceStamps = [...new Set([...await spaceStampsOn(x), ...await spaceStampsOn(y)])].filter((k) => !spaceStampsBefore.has(k)).sort();
      const differ = await expectSame(x, y, order).then(() => null, (e: Error) => e.message.slice(0, 4000));
      const [pa, pb] = x.name === "A" ? [x, y] : [y, x];
      orders.push({
        order, refusals: s.refusals, rounds: s.rounds, differ, lateEdits: s.lateEdits, again, newSpaceStamps,
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
    // I3: quiet means quiet: one more exchange and a full re-send with an empty `have` store nothing and are never refused
    expect(r.again, `${r.order}: one more exchange and a full re-send change nothing`).toEqual({ stored: 0, refusals: [] });
    // a merge never makes a stamp, and the space a note is in is never one (migration 218)
    expect(r.newSpaceStamps, `${r.order}: no space stamp made by the exchange`).toEqual([]);
    expect(r.differ, `${r.order}: both nodes identical`).toBeNull();
    expect(r.broken, `${r.order}: every note in its parent's space`).toEqual({ A: [], B: [] });
    expect(r.inDeletedSpace, `${r.order}: no live note in a deleted space`).toEqual({ A: [], B: [] });
    // nothing a person wrote disappears silently: still held (shown or a conflict head), or handed back as a late edit of a row that is gone
    if (!r.lateEdits.length) expect(r.lost, `${r.order}: every write still held`).toEqual({ A: [], B: [] });
  }
  expect(o.sameAcrossOrders, "the same end state in both arrival orders").toBeNull();
}
/** Every round of both arrival orders ended with both nodes showing `rows`, nothing refused (before migration 218 these scenarios stalled: both directions refused
 *  at COMMIT with the raw 23514 of content_nodes_check_space, every round, for good). */
function expectRows(o: Outcome, rows: Record<string, string>): void {
  for (const r of o.orders) {
    expect(r.refusals, `${r.order}: nothing refused`).toEqual([]);
    expect(r.rows, `${r.order}: what both nodes show`).toEqual({ A: rows, B: rows });
  }
}
/** The write `what` (one that lost: the row shows another value) is still held on both nodes, so it is a conflict head beside the winner, which its author can see. */
async function expectConflictHead(o: Outcome, what: string): Promise<void> {
  const w = o.written.find((x) => x.what === what);
  expect(w, what).toBeDefined();
  for (const r of o.orders) expect(r.lost, `${r.order}: ${what} is still held`).toEqual({ A: [], B: [] });
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
    it("now: A's parent X wins the parent unit, so N is under X and in X's space (S1) on both; B's move (its detach and the space it wrote) stays held, the detach as a conflict head", async () => {
      const o = await outcome();
      expectRows(o, { r: "under - in S1", x: "under - in S1", n: "under x in S1" });
      await expectConflictHead(o, "B: N to S2 (parent)");
    }, 300_000);
    it("desired: both nodes the same, the constraint holds, the losing move kept as a conflict head", async () => {
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
    it("now: C is under P, so it is in P's space: the whole tree is in S2 on both (no unit had two writes; C follows where its parent went)", async () => {
      expectRows(await outcome(), { p: "under - in S2", q: "under p in S2", c: "under p in S2" });
    }, 300_000);
    it("now: nothing is held hostage: an unrelated later edit on A reaches B in the same exchange", async () => {
      const { a: pa, b: pb, ids, world, nodes } = await pair(async (p) => { const pp = await note(p, "P"); return { p: pp, c: await note(p, "C"), u: await note(p, "Unrelated") }; });
      try {
        await onNode(pa.node, () => reparent(pa, "A: C under P", ids.c!, ids.p!));
        await onNode(pb.node, () => moveToSpace(pb, "B: P to S2", ids.p!, world.spaceB));
        await onNode(pa.node, () => pa.call("PATCH", `/api/nodes/${ids.u}`, { title: "edited later on A" }));
        const refused = await take(pb, await bundleFor(pa, pb)).then(() => null, (e: { code?: string; message?: string }) => e);
        expect(refused).toBeNull();
        expect(await onNode(pb.node, async () => (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [ids.u])).rows[0]!.title)).toBe("edited later on A");
      } finally { for (const n of nodes) await n.close().catch(() => undefined); }
    }, 300_000);
    it("desired: both nodes the same, every note in its parent's space", async () => {
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
    it("now: K reaches A under P and is in P's space (S2) on both, though B made it in S1 (it was written under P, not in a space)", async () => {
      expectRows(await outcome(), { p: "under - in S2", q: "under p in S2", k: "under p in S2" });
    }, 300_000);
    it("desired: K is in P's subtree on both, in P's space", async () => {
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
      it(`today: converges: each move wrote the space of the root only; the later one wins it and the notes under P follow; the other is a conflict head of the root's space`, async () => {
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
    it("now: B's deletion reaches A, and because B had not seen N come into S3, S3 is shown on both with N in it; the deletion stays written (a head B can see)", async () => {
      const o = await outcome();
      for (const r of o.orders) {
        expect(r.refusals).toEqual([]);
        expect(r.rows).toEqual({ A: { n: "under - in S3", S3: "live" }, B: { n: "under - in S3", S3: "live" } });
      }
    }, 300_000);
    it("desired: both nodes the same, and no live note ends in a deleted space", async () => {
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
    it("now: the deletion of a space travels: S3 is deleted on both (the bundle carries the deleted spaces its reader is a member of)", async () => {
      const o = await outcome();
      for (const r of o.orders) {
        expect(r.refusals).toEqual([]);
        expect(r.rows).toEqual({ A: { n: "under - in S1", S3: "deleted" }, B: { n: "under - in S1", S3: "deleted" } });
      }
    }, 300_000);
    it("desired: both nodes the same", async () => {
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

// Migration 218 and the merge's derivation (spine/stampedMerge/dbRows.ts deriveNoteSpaces): the cases the brief of PR "fix/merge-space-follows-parent" names, each from the product's
// routes (moveToSpace, PATCH parent_id, POST /api/nodes) except where no route makes the state (the genesis stamp; the commit-time error, see each).
describe.skipIf(!isTestDb)("a note's space follows its tree (migration 218)", () => {
  const shows = (p: Peer, ids: Ids, world: SourceWorld) => rowsOn(p, ids, world);
  const headsOf = (p: Peer, row: string) => onNode(p.node, async () => (await q<{ f: string }>(
    `SELECT field AS f FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 ORDER BY field`, [p.ws, row])).rows.map((r) => r.f));
  const written = (p: Peer, row: string) => onNode(p.node, async () => (await q<{ w: string | null; s: string | null }>(`SELECT written_space_id::text AS w, space_id::text AS s FROM content_nodes WHERE id = $1`, [row])).rows[0]!);

  it("the same `space` stamp on two nodes whose parents differ: no clash, both orders, and a full re-send changes nothing (what a stamp said is the written space, never the derived one)", async () => {
    // N is made at the top of S1 (its `space` unit follows its creation: one stamp, the same on both nodes); A puts N under P; B moves P to S2
    const o = await run({
      last: "B",
      setup: async (p) => ({ p: await note(p, "P"), n: await note(p, "N") }),
      onA: (p, ids) => reparent(p, "A: N under P", ids.n!, ids.p!),
      onB: (p, ids, w) => moveToSpace(p, "B: P to S2", ids.p!, w.spaceB),
    });
    expectDesired(o);
    for (const r of o.orders) expect(r.rows.A).toEqual({ p: "under - in S2", n: "under p in S2" });
  }, 300_000);

  it("a detach to the top keeps the space the note is in, on both nodes (the detach stamps `space` with it: the head written when the note was made says S1)", async () => {
    const { a, b, ids, world, nodes } = await pair(async (p) => { const pp = await note(p, "P"); return { p: pp, n: await note(p, "N", { parent_id: pp }) }; });
    try {
      await onNode(a.node, () => moveToSpace(a, "A: P to S2", ids.p!, world.spaceB));
      expect(await onNode(a.node, () => written(a, ids.n!))).toEqual({ w: world.spaceA, s: world.spaceB }); // N is in S2 and nobody wrote that for it
      await onNode(a.node, () => reparent(a, "A: N to the top", ids.n!, null));
      expect(await onNode(a.node, () => written(a, ids.n!))).toEqual({ w: world.spaceB, s: world.spaceB });
      expect((await settle(a, b)).refusals).toEqual([]);
      for (const p of [a, b]) expect(await shows(p, ids, world)).toEqual({ p: "under - in S2", n: "under - in S2" });
      await expectSame(a, b);
    } finally { for (const n of nodes) await n.close().catch(() => undefined); }
  }, 300_000);

  // N under P in S1. A drags N to the top (in S1: the space it is in is the one written when it was made, so the space column does not change); B moves N to S2.
  // Both are detaches; they differ in the space. The detach stamps `space` though the value did not change (sync_stamp_space_with_root), so the two meet in that
  // unit: the later wins and the other is a conflict head. (Without that stamp A's write said nothing about the space, and A's later "at the top of S1" was lost.)
  for (const last of ["A", "B"] as const) {
    it(`a detach to the top in S1 and a move to S2 made without seeing each other (${last}'s later): the later wins the space, the other is held`, async () => {
      const o = await run({
        last,
        setup: async (p) => { const pp = await note(p, "P"); return { p: pp, n: await note(p, "N", { parent_id: pp }) }; },
        onA: (p, ids) => reparent(p, "A: N to the top", ids.n!, null),
        onB: (p, ids, w) => moveToSpace(p, "B: N to S2", ids.n!, w.spaceB),
      });
      expectDesired(o);
      const want = { p: "under - in S1", n: `under - in ${last === "A" ? "S1" : "S2"}` };
      for (const r of o.orders) expect(r.rows, r.order).toEqual({ A: want, B: want });
    }, 300_000);
  }

  // Review of PR #1907, round 1, point 1. F (top, S1) has C under it; Y (top, S1) has K under it. A drags Y under C; B, later, drags C under Y: both nodes store the
  // loop C↔Y, and the cut puts C back under F. Then A moves F to S2: C, Y and K are under F as the space follows the tree, so they go with it, on A and on every node
  // that takes the move. Before, both the move and the merge walked the stored parent_id: C, Y, K stayed in S1 on both, and B's next edit of K was refused for good.
  it("round 1, point 1: notes a cut puts under a moved note go with it, on the writer and on every node; both arrival orders, a full re-send, and a third node joined by snapshot agree", async () => {
    const { a, b, ids, world, nodes } = await pair(async (p) => {
      const f = await note(p, "F"), y = await note(p, "Y");
      return { f, c: await note(p, "C", { parent_id: f }), y, k: await note(p, "K", { parent_id: y }) };
    });
    const opened = [...nodes];
    try {
      // a third node, joined by snapshot now (a node that holds another node's stamps cannot be a snapshot's source yet: README 接上傳輸前必須完成), takes the rest
      // from A by bundles only: it must end where A and B end
      const cn = await openNode("c");
      opened.push(cn);
      await fillFrom(cn, world, await capture(a.node, world, 12_000));
      const c = peerOf("C", cn, world);
      await admit(a, c);
      await onNode(a.node, () => reparent(a, "A: Y under C", ids.y!, ids.c!));
      await new Promise((r) => setTimeout(r, 5));
      await onNode(b.node, () => reparent(b, "B: C under Y", ids.c!, ids.y!));
      expect((await settle(a, b)).refusals).toEqual([]);
      const loop = { f: "under - in S1", c: "under y in S1", y: "under c in S1", k: "under y in S1" };
      for (const p of [a, b]) expect(await shows(p, ids, world), `${p.name}: the loop as stored, in S1`).toEqual(loop);
      await onNode(a.node, () => moveToSpace(a, "A: F to S2", ids.f!, world.spaceB));
      const moved = { f: "under - in S2", c: "under y in S2", y: "under c in S2", k: "under y in S2" };
      expect(await shows(a, ids, world), "the move takes the notes under F as the space follows the tree").toEqual(moved);
      await onNode(b.node, () => b.call("PATCH", `/api/nodes/${ids.k}`, { markdown: "K, edited on B" }));
      const [a2n, b2n] = [await RealNode.open("a2", a.node!), await RealNode.open("b2", b.node!)];
      opened.push(a2n, b2n);
      const a2 = { ...a, node: a2n } as Peer, b2 = { ...b, node: b2n } as Peer;
      for (const [order, x, y] of [["A first", a, b], ["B first", b2, a2]] as const) {
        expect((await settle(x, y)).refusals, order).toEqual([]);
        expect(await onceMore(x, y), `${order}: one more exchange and everything again change nothing`).toEqual({ stored: 0, refusals: [] });
        for (const p of [x, y]) expect(await shows(p, ids, world), `${order}, ${p.name}`).toEqual(moved);
        await expectSame(x, y, order);
      }
      await expectSame(a, a2, "the order of arrival");
      expect((await settle(a, c)).refusals).toEqual([]);
      expect(await shows(c, ids, world)).toEqual(moved);
      await expectSame(a, c, "joined by snapshot before the loop, the rest by bundles");
      expect((await resendAll(a, c)).stored).toBe(0);
    } finally { for (const n of opened) await n.close().catch(() => undefined); }
  }, 600_000);

  it("round 1, point 2: three notes dragged into one loop by two nodes: the cut is the same on both, nothing refused, every note in its parent's space", async () => {
    const o = await run({
      last: "B",
      setup: async (p) => ({ x: await note(p, "X"), y: await note(p, "Y"), z: await note(p, "Z") }),
      onA: (p, ids) => reparent(p, "A: X under Y", ids.x!, ids.y!),
      onB: async (p, ids) => [...await reparent(p, "B: Y under Z", ids.y!, ids.z!), ...await reparent(p, "B: Z under X", ids.z!, ids.x!)],
    });
    expectDesired(o);
  }, 300_000);

  // Review of PR #1907, round 2, point 1. A loop two nodes made, cut back at the note whose move was later; then a person moves ANOTHER note of the loop to S2 on
  // the node that holds it. The move detaches that note, which opens the loop: the notes stored under it are under it after the move and go with it. Before, the
  // notes to move were counted in the tree as it was BEFORE the detach (the cut note's parent was its former one), and COMMIT refused the move (23514) for good.
  for (const shape of ["two", "three"] as const) {
    it(`round 2, point 1: moving a note of a ${shape}-note loop that is not the cut one takes the notes stored under it; both nodes agree, a full re-send changes nothing`, async () => {
      const { a, b, ids, world, nodes } = await pair(async (p) => {
        const w = await note(p, "W");
        const x = await note(p, "X", { parent_id: w }), y = await note(p, "Y");
        return { w, x, y, k: await note(p, "K", { parent_id: y }), ...(shape === "three" ? { z: await note(p, "Z") } : {}) };
      });
      try {
        // two: A drags Y under X; B, later, drags X under Y (from W): X↔Y, X's move undone (back under W).
        // three: A drags Y under X; B, later, drags Z under Y and X under Z (from W): X→Z→Y→X, X's move undone (back under W).
        await onNode(a.node, () => reparent(a, "A: Y under X", ids.y!, ids.x!));
        await new Promise((r) => setTimeout(r, 5));
        await onNode(b.node, async () => {
          if (shape === "three") await reparent(b, "B: Z under Y", ids.z!, ids.y!);
          await reparent(b, shape === "three" ? "B: X under Z" : "B: X under Y", ids.x!, shape === "three" ? ids.z! : ids.y!);
        });
        expect((await settle(a, b)).refusals).toEqual([]);
        // the person moves Y (on the loop, not the cut note) to S2, on each node in turn
        for (const p of [a, b]) {
          const target = p === a ? world.spaceB : world.spaceA;
          const preview = await onNode(p.node, () => p.call("GET", `/api/spaces/move-preview?node=${ids.y}&to=${target}`));
          const want = shape === "three" ? 4 : 3; // Y, X, K (and Z): the notes stored under Y once Y is detached
          expect(preview.notes, `${p.name}: the preview counts the notes the move takes`).toBe(want);
          const r = await onNode(p.node, () => p.call("POST", "/api/spaces/move", { node_id: ids.y, to_space_id: target, membership_epoch: preview.membership_epoch }));
          expect(r.moved, `${p.name}: the move is taken (no 23514 at COMMIT)`).toBe(want);
          expect((await settle(a, b)).refusals).toEqual([]);
          const sp = (await shows(p, ids, world));
          for (const n of ["y", "x", "k", ...(shape === "three" ? ["z"] : [])]) expect(sp[n], `${p.name}: ${n}`).toMatch(new RegExp(` in ${p === a ? "S2" : "S1"}$`));
          expect(sp.w).toBe("under - in S1");
          await expectSame(a, b, `after ${p.name}'s move`);
        }
        for (const [x, y] of [[a, b], [b, a]] as const) expect((await resendAll(x, y)).stored).toBe(0);
        await expectSame(a, b);
      } finally { for (const n of nodes) await n.close().catch(() => undefined); }
    }, 300_000);
  }

  // Review of PR #1907, round 2, point 2. A drags N under Y (A,5); B, later, drags N under Z and back to the top (B,7): the winner is B's, A's drag a head. Then a person moves
  // N to S2 and back to S1. The second move's `saw` counts the first move's origin up to it, so it covers that origin's older heads: every node that takes it
  // drops them, and the writer must drop the same ones (sync_stamp_put_beside), or a full re-send is not quiet. A head of the OTHER origin stays.
  for (const mover of ["A", "B"] as const) {
    it(`round 2, point 2: a note moved to S2 and back by ${mover}: writer and receiver hold the same heads, a full re-send stores nothing, ${mover === "A" ? "A's own lost drag counts as seen" : "A's drag stays a head"}`, async () => {
      const { a, b, ids, world, nodes } = await pair(async (p) => ({ n: await note(p, "N"), y: await note(p, "Y"), z: await note(p, "Z") }));
      try {
        const [drag] = await onNode(a.node, () => reparent(a, "A: N under Y", ids.n!, ids.y!));
        await new Promise((r) => setTimeout(r, 5));
        await onNode(b.node, async () => { await reparent(b, "B: N under Z", ids.n!, ids.z!); await reparent(b, "B: N to the top", ids.n!, null); });
        expect((await settle(a, b)).refusals).toEqual([]);
        const dragHead = (p: Peer) => onNode(p.node, async () => (await q(`SELECT 1 FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = 'parent' AND origin = $3 AND seq = $4`,
          [p.ws, ids.n, drag!.origin, drag!.seq])).rows.length);
        expect([await dragHead(a), await dragHead(b)]).toEqual([1, 1]);
        const m = mover === "A" ? a : b;
        for (const to of [world.spaceB, world.spaceA]) {
          await onNode(m.node, () => moveToSpace(m, `${mover}: N to another space`, ids.n!, to));
          expect((await settle(a, b)).refusals).toEqual([]);
          await expectSame(a, b, `after a move by ${mover}`);
        }
        for (const [x, y] of [[a, b], [b, a]] as const) expect((await resendAll(x, y)).stored, `${x.name} → ${y.name}`).toBe(0);
        await expectSame(a, b);
        expect([await dragHead(a), await dragHead(b)], mover === "A" ? "A's own older drag is covered by A's move" : "a head of another origin stays").toEqual(mover === "A" ? [0, 0] : [1, 1]);
        for (const p of [a, b]) expect((await shows(p, ids, world)).n).toBe("under - in S1");
      } finally { for (const n of nodes) await n.close().catch(() => undefined); }
    }, 300_000);
  }

  // Review of PR #1907, rounds 2 and 3, point 3 / point 1. The state of round 1, point 1, moved to S2 (F, C, Y, K all there). Then F, the note the cut puts C
  // back under, is purged (trash, then delete for good). After the cut C is at the top, and it stays in the space it was in: the space F was shown in when it went
  // (F's tombstone, migration 218 section 8), not the one once written for C (S1, where C was made: an ancestor's move never rewrote it). The purge of another
  // note moves nobody to a space they were not in; the purging node and the node that takes the purge agree; a later edit of K is not refused.
  for (const purger of ["A", "B"] as const) {
    it(`round 3, point 1: the note a cut puts others back under is purged on ${purger}: they stay in the space they were in, on both nodes, and a full re-send changes nothing`, async () => {
      const { a, b, ids, world, nodes } = await pair(async (p) => {
        const f = await note(p, "F"), y = await note(p, "Y");
        return { f, c: await note(p, "C", { parent_id: f }), y, k: await note(p, "K", { parent_id: y }) };
      });
      try {
        await onNode(a.node, () => reparent(a, "A: Y under C", ids.y!, ids.c!));
        await new Promise((r) => setTimeout(r, 5));
        await onNode(b.node, () => reparent(b, "B: C under Y", ids.c!, ids.y!));
        expect((await settle(a, b)).refusals).toEqual([]);
        await onNode(a.node, () => moveToSpace(a, "A: F to S2", ids.f!, world.spaceB));
        expect((await settle(a, b)).refusals).toEqual([]);
        for (const p of [a, b]) expect((await shows(p, ids, world)).c, p.name).toBe("under y in S2");
        const p = purger === "A" ? a : b;
        await onNode(p.node, async () => {
          await p.call("DELETE", `/api/nodes/${ids.f}`);
          const preview = await p.call("GET", `/api/nodes/${ids.f}/purge-preview`);
          await p.call("POST", `/api/nodes/${ids.f}/purge`, { expected_ids: preview.ids ?? [ids.f] });
        });
        const after = { f: "gone", c: "under y in S2", y: "under c in S2", k: "under y in S2" };
        expect(await shows(p, ids, world), `${purger}: nothing moves on the purging node`).toEqual(after);
        expect((await settle(a, b)).refusals).toEqual([]);
        for (const x of [a, b]) expect(await shows(x, ids, world), x.name).toEqual(after);
        await expectSame(a, b);
        await onNode(a.node, () => a.call("PATCH", `/api/nodes/${ids.k}`, { markdown: "K, edited on A" }));
        expect((await settle(a, b)).refusals).toEqual([]);
        for (const [x, y] of [[a, b], [b, a]] as const) expect((await resendAll(x, y)).stored, `${x.name} → ${y.name}`).toBe(0);
        await expectSame(a, b);
      } finally { for (const n of nodes) await n.close().catch(() => undefined); }
    }, 300_000);
  }

  // Review of PR #1907, round 3, point 1 (the late child). F at the top of S1. A moves F to S2, trashes it and deletes it for good; B, offline, made K under F
  // (on B, F is still in S1). K's parent is gone on both nodes once they exchange: K is at the top, in the space F was shown in when it went (S2: K was under F,
  // and F was moved there), on both nodes, whichever bundle arrives first.
  for (const order of ["A first", "B first"] as const) {
    it(`round 3, point 1: a note made under a note another node moved and deleted for good is in the space that note was shown in (${order})`, async () => {
      const { a, b, ids, world, nodes } = await pair(async (p) => ({ f: await note(p, "F") }));
      try {
        await onNode(a.node, async () => {
          await moveToSpace(a, "A: F to S2", ids.f!, world.spaceB);
          await a.call("DELETE", `/api/nodes/${ids.f}`);
          const preview = await a.call("GET", `/api/nodes/${ids.f}/purge-preview`);
          await a.call("POST", `/api/nodes/${ids.f}/purge`, { expected_ids: preview.ids ?? [ids.f] });
        });
        ids.k = await onNode(b.node, () => note(b, "K", { parent_id: ids.f }));
        const [first, second] = order === "A first" ? [a, b] : [b, a];
        expect((await settle(first, second)).refusals).toEqual([]);
        for (const p of [a, b]) expect((await shows(p, ids, world)).k, p.name).toBe("under - in S2");
        await expectSame(a, b);
        for (const [x, y] of [[a, b], [b, a]] as const) expect((await resendAll(x, y)).stored, `${x.name} → ${y.name}`).toBe(0);
        await expectSame(a, b);
      } finally { for (const n of nodes) await n.close().catch(() => undefined); }
    }, 300_000);
  }

  // Review of PR #1907, after round 3: a note left without its parent, which a person then places again, is where the person put it. K is made under F on B
  // while A moves F to S2 and deletes it for good: K is at the top, in S2 (F's tombstone). Then on A a person (i) moves K to S3, or (ii) drags K under X and back
  // to the top. Their write is the place, not F's tombstone: both nodes show it, and a full re-send stores nothing.
  for (const then of ["moved to S3", "dragged under X and back"] as const) {
    it(`after round 3: a note left without its parent and then ${then} by a person is where the person put it, on both nodes`, async () => {
      const { a, b, ids, world, nodes } = await pair(async (p, w) => ({ f: await note(p, "F"), x: await note(p, "X", { space_id: w.spaceB }), S3: await newSpace(p, "S3") }));
      try {
        await onNode(a.node, async () => {
          await moveToSpace(a, "A: F to S2", ids.f!, world.spaceB);
          await a.call("DELETE", `/api/nodes/${ids.f}`);
          const preview = await a.call("GET", `/api/nodes/${ids.f}/purge-preview`);
          await a.call("POST", `/api/nodes/${ids.f}/purge`, { expected_ids: preview.ids ?? [ids.f] });
        });
        ids.k = await onNode(b.node, () => note(b, "K", { parent_id: ids.f }));
        expect((await settle(a, b)).refusals).toEqual([]);
        for (const p of [a, b]) expect((await shows(p, ids, world)).k, p.name).toBe("under - in S2");
        const name = (v: string) => (v === ids.S3 ? "S3" : v);
        if (then === "moved to S3") {
          await onNode(a.node, () => moveToSpace(a, "A: K to S3", ids.k!, ids.S3!));
        } else {
          await onNode(a.node, async () => { await reparent(a, "A: K under X", ids.k!, ids.x!); await reparent(a, "A: K to the top", ids.k!, null); });
        }
        // (ii): X is in S2 (a parent in another space is refused): K under X, then at the top, in S2 by its own write now, not by F's tombstone
        const want = then === "moved to S3" ? "under - in S3" : "under - in S2";
        expect(name((await shows(a, ids, world)).k), "A, where the person put it").toBe(want);
        expect((await settle(a, b)).refusals).toEqual([]);
        for (const p of [a, b]) expect(name((await shows(p, ids, world)).k), p.name).toBe(want);
        await expectSame(a, b);
        for (const [x, y] of [[a, b], [b, a]] as const) expect((await resendAll(x, y)).stored, `${x.name} → ${y.name}`).toBe(0);
        // and a later bundle about K (an edit on B) changes nothing of its place
        await onNode(b.node, () => b.call("PATCH", `/api/nodes/${ids.k}`, { markdown: "K, edited on B" }));
        expect((await settle(a, b)).refusals).toEqual([]);
        for (const p of [a, b]) expect((await shows(p, ids, world)).k, `${p.name}, after a later edit`).toBe(want);
        await expectSame(a, b);
      } finally { for (const n of nodes) await n.close().catch(() => undefined); }
    }, 300_000);
  }

  // Review of PR #1907, round 3, point 2. One node, no sync: a note many notes were moved out of is deleted for good. No other note is written by it (the purge
  // re-derives nothing locally: the space a note left without its parent is in is the space it was in).
  it("round 3, point 2: deleting for good a note many notes were moved out of writes no other note", async () => {
    const { a, nodes } = await pair(async () => ({}));
    try {
      await onNode(a.node, async () => {
        const mk = (title: string, extra: Record<string, unknown> = {}) => note(a, title, extra);
        const inbox = await mk("Inbox"), done = await mk("Done");
        for (let i = 0; i < 20; i++) { const n = await mk(`n${i}`, { parent_id: inbox }); await a.call("PATCH", `/api/nodes/${n}`, { parent_id: done }); }
        const versions = async () => (await q<{ id: string; v: string }>(`SELECT id::text, xmin::text AS v FROM content_nodes WHERE workspace_id = $1 AND id <> $2 ORDER BY id`, [a.ws, inbox])).rows;
        await a.call("DELETE", `/api/nodes/${inbox}`);
        const before = await versions();
        const preview = await a.call("GET", `/api/nodes/${inbox}/purge-preview`);
        await a.call("POST", `/api/nodes/${inbox}/purge`, { expected_ids: preview.ids ?? [inbox] });
        expect(await versions(), "no other row of content_nodes has a new version").toEqual(before);
      });
    } finally { for (const n of nodes) await n.close().catch(() => undefined); }
  }, 300_000);

  // Review of PR #1907, round 3, point 6. Mixed origins: A drags N under Y (A,5); B, later, puts it back at the top (B,7); A moves N to S2 (A,9, its saw counts
  // B up to 7); B moves N to S1 (its saw counts A up to 9): that covers A's older drag (A,5), which goes on both nodes, as README says the cost is.
  it("round 3, point 6: a move by B over A's move covers A's older drag: it goes on both nodes, and a full re-send stores nothing", async () => {
    const { a, b, ids, world, nodes } = await pair(async (p) => ({ n: await note(p, "N"), y: await note(p, "Y"), z: await note(p, "Z") }));
    try {
      const [drag] = await onNode(a.node, () => reparent(a, "A: N under Y", ids.n!, ids.y!));
      await new Promise((r) => setTimeout(r, 5));
      await onNode(b.node, async () => { await reparent(b, "B: N under Z", ids.n!, ids.z!); await reparent(b, "B: N to the top", ids.n!, null); });
      expect((await settle(a, b)).refusals).toEqual([]);
      const dragHead = (p: Peer) => onNode(p.node, async () => (await q(`SELECT 1 FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = 'parent' AND origin = $3 AND seq = $4`,
        [p.ws, ids.n, drag!.origin, drag!.seq])).rows.length);
      await onNode(a.node, () => moveToSpace(a, "A: N to S2", ids.n!, world.spaceB));
      expect((await settle(a, b)).refusals).toEqual([]);
      expect([await dragHead(a), await dragHead(b)], "A's own move counts B up to 7, not A's drag: it stays").toEqual([1, 1]);
      await onNode(b.node, () => moveToSpace(b, "B: N to S1", ids.n!, world.spaceA));
      expect((await settle(a, b)).refusals).toEqual([]);
      expect([await dragHead(a), await dragHead(b)], "B's move counts A up to 9: A's drag goes, on both").toEqual([0, 0]);
      await expectSame(a, b);
      for (const [x, y] of [[a, b], [b, a]] as const) expect((await resendAll(x, y)).stored).toBe(0);
    } finally { for (const n of nodes) await n.close().catch(() => undefined); }
  }, 300_000);

  // Review of PR #1907, round 1, point 3. N at the top of S1. A drags N under X; B, later, drags N under Z and back to the top: N is at the top, A's drag a conflict
  // head of `parent`. Then B moves N to S2. That move makes no choice between the places: A's head must stay, on both nodes.
  it("round 1, point 3: moving a note at the top to another space keeps a conflict head of its place that nobody has looked at, on both nodes", async () => {
    const { a, b, ids, world, nodes } = await pair(async (p) => ({ n: await note(p, "N"), x: await note(p, "X"), z: await note(p, "Z") }));
    try {
      const [drag] = await onNode(a.node, () => reparent(a, "A: N under X", ids.n!, ids.x!));
      await new Promise((r) => setTimeout(r, 5));
      await onNode(b.node, async () => { await reparent(b, "B: N under Z", ids.n!, ids.z!); await reparent(b, "B: N to the top", ids.n!, null); });
      expect((await settle(a, b)).refusals).toEqual([]);
      const aHead = (p: Peer) => onNode(p.node, async () => (await q(`SELECT 1 FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = 'parent' AND origin = $3 AND seq = $4`,
        [p.ws, ids.n, drag!.origin, drag!.seq])).rows.length);
      expect([await aHead(a), await aHead(b)], "A's drag is a conflict head on both").toEqual([1, 1]);
      await onNode(b.node, () => moveToSpace(b, "B: N to S2", ids.n!, world.spaceB));
      expect(await aHead(b), "the move kept it").toBe(1);
      expect((await settle(a, b)).refusals).toEqual([]);
      expect([await aHead(a), await aHead(b)], "and so did the node that took the move").toEqual([1, 1]);
      for (const p of [a, b]) expect((await shows(p, ids, world)).n).toBe("under - in S2");
      await expectSame(a, b);
      for (const [x, y] of [[a, b], [b, a]] as const) expect((await resendAll(x, y)).stored).toBe(0);
      await expectSame(a, b);
    } finally { for (const n of nodes) await n.close().catch(() => undefined); }
  }, 300_000);

  // Review of PR #1907, round 1, point 4. N at the top of S1 with its order key k0. A drags N under Y (a new key under Y); B, later, moves N to S2. B's move wins N's
  // place: N is at the top, so its order key is the one it had at the top (B's write stamps `sort` with it), not the one A chose under Y.
  it("round 1, point 4: a space move that wins the place over a concurrent drag shows the order key it had at the top, not the drag's", async () => {
    const { a, b, ids, world, nodes } = await pair(async (p) => ({ n: await note(p, "N"), y: await note(p, "Y") }));
    try {
      const keyOf = (p: Peer) => onNode(p.node, async () => (await q<{ k: string }>(`SELECT order_key AS k FROM content_nodes WHERE id = $1`, [ids.n])).rows[0]!.k);
      const k0 = await keyOf(a);
      await onNode(a.node, () => reparent(a, "A: N under Y", ids.n!, ids.y!));
      const kY = await keyOf(a);
      await new Promise((r) => setTimeout(r, 5));
      await onNode(b.node, () => moveToSpace(b, "B: N to S2", ids.n!, world.spaceB));
      expect((await settle(a, b)).refusals).toEqual([]);
      for (const p of [a, b]) {
        expect((await shows(p, ids, world)).n, p.name).toBe("under - in S2");
        expect(await keyOf(p), `${p.name}: the key N had at the top (A chose ${kY} under Y)`).toBe(k0);
      }
      await expectSame(a, b);
    } finally { for (const n of nodes) await n.close().catch(() => undefined); }
  }, 300_000);

  // Review of PR #1907, round 1, point 5. A note under a TAG is at the top (rules/space.ts: the walk ends at a tag). No route puts a note under a tag
  // (services/parentKind.ts), so the note is put there by SQL; its space changes through a route that changes the space and not the parent: deleting a space and
  // moving its deleted notes to one's personal space. That write places the note, so `parent` is stamped with it, as for a note with no parent.
  it("round 1, point 5: a note under a tag is a note at the top: a write of its space stamps its place too", async () => {
    const { a, ids, nodes } = await pair(async (p) => {
      const s3 = await newSpace(p, "S3");
      const tag = (await p.call("POST", "/api/tags", { name: `t-${randomUUID().slice(0, 6)}` })).id as string;
      const n = await note(p, "N", { space_id: s3 });
      await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [n, tag]);
      return { n, S3: s3, tag };
    });
    try {
      await onNode(a.node, async () => {
        await a.call("DELETE", `/api/nodes/${ids.n}`);
        await a.call("DELETE", `/api/spaces/${ids.S3}`, { deleted_notes: "move" });
        const st = async (field: string) => (await q<{ seq: string }>(`SELECT seq::text FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = $3`,
          [a.ws, ids.n, field])).rows[0]?.seq;
        const space = await st("space");
        expect(space, "the move of the deleted note wrote its space").toBeDefined();
        expect(await st("parent"), "and its place, with the same write").toBe(space);
        expect((await q<{ p: string }>(`SELECT parent_id::text AS p FROM content_nodes WHERE id = $1`, [ids.n])).rows[0]!.p, "still under the tag").toBe(ids.tag);
      });
    } finally { for (const n of nodes) await n.close().catch(() => undefined); }
  }, 300_000);

  it("a local move over a genesis `space` (and `parent`) leaves no conflict head on either node", async () => {
    // A row older than stamps carries only genesis stamps (migration 202). No route makes one: the note's stamps are made genesis here, before B joins
    const { a, b, ids, world, nodes } = await pair(async (p) => {
      const g = await note(p, "G");
      await q(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field <> '*'`, [p.ws, g]);
      await q(`UPDATE sync_stamps SET origin = 'genesis', seq = 0, hlc_wall = 0, hlc_counter = 0, author = NULL, device = NULL, saw = '{}'::jsonb, meta = NULL
                WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2`, [p.ws, g]);
      return { g };
    });
    try {
      await onNode(b.node, () => moveToSpace(b, "B: G to S2", ids.g!, world.spaceB));
      expect((await settle(a, b)).refusals).toEqual([]);
      for (const p of [a, b]) {
        expect(await shows(p, ids, world)).toEqual({ g: "under - in S2" });
        expect(await headsOf(p, ids.g!), `${p.name}: no other head`).toEqual([]);
      }
      await expectSame(a, b);
    } finally { for (const n of nodes) await n.close().catch(() => undefined); }
  }, 300_000);

  // X and Y at the top of S1. A puts X under Y; B puts Y under X and moves X (at the top on B) to S2: the parents make a loop, which the 4.10 cut breaks the
  // same way on both nodes, and the space follows the top the cut leaves.
  for (const last of ["A", "B"] as const) {
    it(`a loop of two moves plus a space move (${last}'s write later): both nodes the same, no refusal, every note in its parent's space, nothing lost`, async () => {
      const o = await run({
        last,
        setup: async (p) => ({ x: await note(p, "X"), y: await note(p, "Y") }),
        onA: (p, ids) => reparent(p, "A: X under Y", ids.x!, ids.y!),
        onB: async (p, ids, w) => [...await reparent(p, "B: Y under X", ids.y!, ids.x!), ...await moveToSpace(p, "B: X to S2", ids.x!, w.spaceB)],
      });
      expectDesired(o);
      // the parents as merged stay a loop when A's move is later (the cut is a view; parent_id is never repaired), and the notes are in the space of the top the cut leaves
      const want = last === "A" ? { x: "under y in S2", y: "under x in S2" } : { x: "under - in S2", y: "under x in S2" };
      for (const r of o.orders) expect(r.rows, r.order).toEqual({ A: want, B: want });
    }, 300_000);
  }

  it("a note under the moved one that is not in the bundle changes space with it: its structure-log line, and the membership epoch moves, on the node that takes the move", async () => {
    const { a, b, ids, world, nodes } = await pair(async (p) => {
      const pp = await note(p, "P"), qq = await note(p, "Q", { parent_id: pp });
      return { p: pp, q: qq, r: await note(p, "R", { parent_id: qq }) };
    });
    try {
      const epoch = () => onNode(a.node, async () => Number((await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [a.ws])).rows[0]!.e));
      const before = await epoch();
      await onNode(b.node, () => moveToSpace(b, "B: P to S2", ids.p!, world.spaceB));
      const bundle = await bundleFor(b, a);
      const carried = new Set(bundle.items.flatMap((i) => (i.kind === "row" ? i.stamps.map((s) => s.rowKey) : [i.stamp.rowKey])));
      expect(carried.has(ids.p!)).toBe(true);
      expect([carried.has(ids.q!), carried.has(ids.r!)], "Q and R are not in the bundle: nobody wrote them").toEqual([false, false]);
      const report = await take(a, bundle);
      expect(report.followedSpaces.map((f) => f.note).sort()).toEqual([ids.q!, ids.r!].sort());
      expect(await shows(a, ids, world)).toEqual({ p: "under - in S2", q: "under p in S2", r: "under q in S2" });
      expect(await epoch()).toBeGreaterThan(before);
      const lines = await onNode(a.node, async () => (await q<{ row_key: string; old_value: string | null; new_value: string | null; origin: string }>(
        `SELECT row_key, old_value, new_value, origin FROM structure_log WHERE workspace_id = $1 AND table_name = 'content_nodes' AND field = 'space' AND row_key = ANY($2::text[]) AND new_value = $3 ORDER BY row_key`,
        [a.ws, [ids.q!, ids.r!], world.spaceB])).rows);
      const bOrigin = await onNode(b.node, async () => (await q<{ node_id: string }>(`SELECT node_id FROM sync_node WHERE singleton`)).rows[0]!.node_id);
      expect(lines.map((l) => [l.row_key, l.old_value, l.origin]).sort()).toEqual([[ids.q!, world.spaceA, bOrigin], [ids.r!, world.spaceA, bOrigin]].sort());
      await expectSame(a, b);
    } finally { for (const n of nodes) await n.close().catch(() => undefined); }
  }, 300_000);

  it("scenario (b) on three nodes: A and B write, C hears both only through A; every node ends the same, one more exchange and a full re-send change nothing", async () => {
    const { a, b, ids, world, nodes } = await pair(async (p) => { const pp = await note(p, "P"); return { p: pp, q: await note(p, "Q", { parent_id: pp }), c: await note(p, "C") }; });
    const opened = [...nodes];
    try {
      const cap = await capture(a.node, world, 12_000);
      const cn = await openNode("c");
      opened.push(cn);
      await fillFrom(cn, world, cap);
      const c = peerOf("C", cn, world);
      await admit(a, c);
      await onNode(a.node, () => reparent(a, "A: C under P", ids.c!, ids.p!));
      await onNode(b.node, () => moveToSpace(b, "B: P to S2", ids.p!, world.spaceB));
      for (let round = 0; round < 4; round++) for (const [x, y] of [[a, b], [a, c]] as const) expect((await settle(x, y)).refusals).toEqual([]);
      const want = { p: "under - in S2", q: "under p in S2", c: "under p in S2" };
      for (const p of [a, b, c]) expect(await shows(p, ids, world), p.name).toEqual(want);
      await expectSame(a, b); await expectSame(a, c);
      for (const [x, y] of [[a, b], [b, a], [a, c], [c, a]] as const) {
        expect((await take(y, await bundleFor(x, y))).stored, `${x.name}→${y.name} once more`).toBe(0);
        expect((await resendAll(x, y)).stored, `${x.name}→${y.name} everything again`).toBe(0);
      }
      await expectSame(a, b); await expectSame(a, c);
    } finally { for (const n of opened) await n.close().catch(() => undefined); }
  }, 600_000);

  it("(e1) and after: the space B deleted is kept while N is in it; once A moves N out, the deletion takes effect on A and, by the exchange, on B (no one deletes it again)", async () => {
    const { a, b, ids, world, nodes } = await pair(async (p) => ({ n: await note(p, "N"), S3: await newSpace(p, "S3") }));
    try {
      await onNode(a.node, () => moveToSpace(a, "A: N to S3", ids.n!, ids.S3!));
      await onNode(b.node, () => b.call("DELETE", `/api/spaces/${ids.S3}`));
      expect((await settle(a, b)).refusals).toEqual([]);
      const kept = { n: "under - in S3", S3: "live" };
      for (const p of [a, b]) expect(await shows(p, ids, world), p.name).toEqual(kept);
      const written = (p: Peer) => onNode(p.node, async () => (await q<{ w: boolean }>(`SELECT written_deleted_at IS NOT NULL AS w FROM spaces WHERE id = $1`, [ids.S3])).rows[0]!.w);
      expect([await written(a), await written(b)], "the deletion stays written on both").toEqual([true, true]);
      // on A, N leaves S3 (a local move): the view takes the deletion up again at once, on A
      await onNode(a.node, () => moveToSpace(a, "A: N back to S1", ids.n!, world.spaceA));
      expect(await shows(a, ids, world)).toEqual({ n: "under - in S1", S3: "deleted" });
      expect((await settle(a, b)).refusals).toEqual([]);
      expect(await shows(b, ids, world)).toEqual({ n: "under - in S1", S3: "deleted" });
      await expectSame(a, b);
      for (const [x, y] of [[a, b], [b, a]] as const) expect((await resendAll(x, y)).stored).toBe(0);
    } finally { for (const n of nodes) await n.close().catch(() => undefined); }
  }, 300_000);

  it("I5: a write a bundle withholds (its row is outside the reader's scope) is not passed by the receiver's `have`, and is delivered once the reader may read it", async () => {
    const { a, b, world, nodes } = await pair(async () => ({}));
    try {
      // on A, after B joined: the owner makes a space, gives it to the friend and leaves it; the friend writes a note in it. The owner's bundles may carry neither
      const asFriend = makeCaller(world.friend);
      const s4 = await onNode(a.node, async () => {
        const id = (await a.call("POST", "/api/spaces", { name: `Friend's ${randomUUID().slice(0, 4)}` })).id as string;
        await a.call("PUT", `/api/spaces/${id}/members/${world.friend.id}`, { permission: "edit" });
        await a.call("DELETE", `/api/spaces/${id}/members/${world.owner.id}`);
        return id;
      });
      const f = await onNode(a.node, async () => (await asFriend("POST", "/api/nodes", { id: randomUUID(), title: "Friend's note", markdown: "friend's words", space_id: s4 })).id as string);
      const seqOf = (row: string) => onNode(a.node, async () => Number((await q<{ seq: string }>(
        `SELECT seq::text FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = '*'`, [a.ws, row])).rows[0]!.seq));
      const [fSeq, aOrigin] = [await seqOf(f), await nodeIdOf(a)];
      const first = await bundleFor(a, b);
      const carried = (bundle: typeof first) => new Set(bundle.items.flatMap((i) => (i.kind === "row" ? i.stamps.map((x) => x.rowKey) : [i.stamp.rowKey])));
      expect([carried(first).has(f), carried(first).has(s4)], "the friend's space and note are not in the owner's bundle").toEqual([false, false]);
      expect(first.holds[aOrigin]).toBeGreaterThanOrEqual(fSeq);
      expect(first.upTo[aOrigin], "the receiver will hold A's writes only up to before the first one withheld").toBeLessThan(fSeq);
      await take(b, first);
      const haveOfA = () => onNode(b.node, async () => (await readHave(b.ws))[aOrigin]!);
      expect(await haveOfA()).toBeLessThan(fSeq);
      expect((await take(b, await bundleFor(a, b))).stored, "the next bundle sends again what A wrote after it, and that stores nothing").toBe(0);
      // the owner joins the friend's space (a shared space is managed by the workspace's owner): the next bundle carries the space and the note
      await onNode(a.node, () => a.call("PUT", `/api/spaces/${s4}/members/${world.owner.id}`, { permission: "view" }));
      expect((await settle(a, b)).refusals).toEqual([]);
      expect(await onNode(b.node, async () => (await q<{ title: string; markdown: string; space: string }>(`SELECT title, markdown, space_id::text AS space FROM content_nodes WHERE id = $1`, [f])).rows[0]))
        .toEqual({ title: "Friend's note", markdown: "friend's words", space: s4 });
      expect(await haveOfA()).toBeGreaterThanOrEqual(fSeq);
      await expectSame(a, b);
    } finally { for (const n of nodes) await n.close().catch(() => undefined); }
  }, 300_000);

  it("a check the database runs at COMMIT that a bundle would break is a coded refusal with a plain reason, and nothing of the bundle is written", async () => {
    // After 218 no route makes a bundle that breaks content_nodes_check_space (that is the fix). The receiver is given a second DEFERRED check here that refuses
    // any note row a bundle writes (23514), to stand for one: what reaches the caller is what any such check would give.
    const { a, b, ids, nodes } = await pair(async (p) => ({ n: await note(p, "N") }));
    try {
      await onNode(a.node, () => a.call("PATCH", `/api/nodes/${ids.n}`, { title: "edited on A" }));
      await onNode(b.node, async () => {
        await q(`CREATE FUNCTION test_refuse_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
                   RAISE EXCEPTION 'refused at commit' USING ERRCODE = 'check_violation', CONSTRAINT = 'test_refuse_at_commit'; END $$`);
        await q(`CREATE CONSTRAINT TRIGGER test_refuse_at_commit AFTER UPDATE ON content_nodes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_refuse_at_commit()`);
      });
      const have = await onNode(b.node, async () => (await q<{ have: unknown }>(`SELECT have FROM sync_origins WHERE workspace_id = $1 ORDER BY origin`, [b.ws])).rows);
      const refused = await take(b, await bundleFor(a, b)).then(() => null, (e: { code?: string; status?: number; message?: string }) => e);
      expect(refused).toMatchObject({ code: "bundle_malformed", status: 422 });
      expect(refused!.message).toBe("taking the bundle would leave rows that do not hold together (test_refuse_at_commit): nothing was taken");
      expect(await onNode(b.node, async () => (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [ids.n])).rows[0]!.title)).toBe("N");
      expect(await onNode(b.node, async () => (await q<{ have: unknown }>(`SELECT have FROM sync_origins WHERE workspace_id = $1 ORDER BY origin`, [b.ws])).rows)).toEqual(have);
    } finally { for (const n of nodes) await n.close().catch(() => undefined); }
  }, 300_000);
});
