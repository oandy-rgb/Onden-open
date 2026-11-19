// The relations BETWEEN units of a row (or between a row and another row) that the merge core does not know about, checked after EVERY merge step of the pure
// simulator (helpers/stampedSim/world.ts: StampedWorld, its faulty network, spine/stampedMerge's mergeStore). The table of relations and the proposal:
// docs/architecture/proposals/merge-cross-field-invariants-2026-11-19.md. Pure memory; no database.
//
// The notes here have the units the database has for this (content_nodes.parent, .space, .sort, the trash) and spaces have .deleted; every local change is made
// the way the product's write paths make it, each checked against what that node holds when it writes (the product refuses the rest):
//   new      under a live note (taking its space, content_nodes_derive_space) or at the top of a live space
//   reparent within the note's own space, never under itself or its descendants (services/nodeTree.ts assertReparent), parent + sort in ONE write (migration 209)
//   to space the note detached at the top of another live space, the whole subtree it knows stamped with the new space in ONE write (services/spaces.ts moveToSpace)
//   trash    the note and its live subtree (services/nodeTrash.ts)
//   delete space   only a space that holds no note at all (services/spaces.ts deleteSpace)
// Relations checked after every merge step, on the node that merged (the "view" relations after the view rule that exists for them is applied):
//   R1 parent × space      a note is in its parent's space (db/schema.sql content_nodes_check_space: at COMMIT, so a red here is a stalled bundle on a database)
//   R2 space × spaces.deleted   no live note in a deleted space (services/spaces.ts deleteSpace refuses it locally; nothing at merge)
//   R3 parent (cycles)     no loop after the 4.10 view (rules/moveCycle.ts resolveMoveCycles)
//   R4 trash × parent      no live note under a trashed one after the 4.9 view (rules/trash.ts trashOrphanedChildren)
//
//   MERGE_INVARIANT_SEED   pins the seed of the random run (default: a fresh one each run, printed on failure)
//   MERGE_INVARIANT_RUNS   seeds per random run (default 12), MERGE_INVARIANT_STEPS steps per seed (default 160)
// A relation in KNOWN_OPEN is red today: the random run counts it and does not fail on it; its seed is pinned below as a fixed `it.fails` (with a test beside it
// that says exactly what breaks with that seed, so the `it.fails` cannot pass for another reason). When the fix lands the `it.fails` turns: take the relation off the list.
import { describe, expect, it } from "vitest";
import { makeRng, type Rng } from "./helpers/distSim/rng.js";
import { StampedWorld, type SimNode } from "./helpers/stampedSim/world.js";
import { type Store, createRow, effectiveUnit, rowKeys, rowOf, seenOfRow, writeField } from "../spine/stampedMerge/store.js";
import { type Json, type Stamp, type Unit, compareStamps } from "../spine/stampedMerge/unit.js";
import { resolveMoveCycles, type ParentLink } from "../spine/stampedMerge/rules/moveCycle.js";
import { trashOrphanedChildren, type Deletion, type TreeNote } from "../spine/stampedMerge/rules/trash.js";

const NOTE = "note", SPACE = "space";
type Relation = "R1 parent × space" | "R2 live note in a deleted space" | "R3 a loop after the 4.10 view" | "R4 live note under a trashed one after the 4.9 view";
/** Red today; each has a pinned seed below. // ratchet:list merge-cross-field-known-open */
const KNOWN_OPEN: readonly Relation[] = ["R1 parent × space", "R2 live note in a deleted space", "R4 live note under a trashed one after the 4.9 view"];

// ── the model ───────────────────────────────────────────────────────────────────────────────────────────
const winner = (s: Store, table: string, row: string, field: string): Json | undefined => {
  const u = effectiveUnit(s, { table, row, field });
  return u && !u[0]!.deleted ? u[0]!.value : undefined;
};
const notes = (s: Store) => rowKeys(s, NOTE).map((r) => r.row).filter((id) => rowOf(s, NOTE, id).exists);
const spaces = (s: Store) => rowKeys(s, SPACE).map((r) => r.row).filter((id) => rowOf(s, SPACE, id).exists);
const parentOf = (s: Store, id: string) => (winner(s, NOTE, id, "parent") ?? null) as string | null;
const spaceOf = (s: Store, id: string) => (winner(s, NOTE, id, "space") ?? null) as string | null;
const isTrashed = (s: Store, id: string) => !!effectiveUnit(s, { table: NOTE, row: id, field: "trashed" })?.[0]?.deleted;
const spaceDeleted = (s: Store, id: string) => winner(s, SPACE, id, "deleted") === true;
/** `id` and every note whose parent chain reaches it, as this store has them. */
function subtree(s: Store, id: string): string[] {
  const all = notes(s), out = [id];
  for (let grew = true; grew;) { grew = false; for (const n of all) if (!out.includes(n) && out.includes(parentOf(s, n) ?? "")) { out.push(n); grew = true; } }
  return out;
}
const at = <T,>(xs: readonly T[], f: number): T => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))]!;

type Kind = "new" | "reparent" | "toSpace" | "trash" | "deleteSpace";
const MIX: readonly [Kind, number][] = [["new", 5], ["reparent", 5], ["toSpace", 4], ["trash", 2], ["deleteSpace", 1]];
type Step = { t: "op"; node: number; kind: Kind; p: [number, number, number] } | { t: "deliver"; n: number } | { t: "gossip"; a: number; b: number };

let uniq = 0;
function apply(w: StampedWorld, n: SimNode, kind: Kind, [p, q, r]: [number, number, number]): void {
  const s = n.store;
  const liveNotes = notes(s).filter((id) => !isTrashed(s, id));
  const liveSpaces = spaces(s).filter((id) => !spaceDeleted(s, id));
  const L = (change: (st: Store, sp: Stamp) => Store) => w.local(n, kind, change);
  switch (kind) {
    case "new": {
      const parent = liveNotes.length && q < 0.6 ? at(liveNotes, p) : null;
      const space = parent ? spaceOf(s, parent) : liveSpaces.length ? at(liveSpaces, r) : null;
      if (!space) return;
      const id = `n${++uniq}`;
      L((st, sp) => createRow(st, { table: NOTE, row: id }, sp, { parent, space, sort: `k${uniq}` }));
      return;
    }
    case "reparent": {
      if (liveNotes.length < 2) return;
      const id = at(liveNotes, p), sp0 = spaceOf(s, id);
      const to = r < 0.2 ? null : at(liveNotes.filter((x) => spaceOf(s, x) === sp0 && !subtree(s, id).includes(x)), q) ?? null;
      const from = parentOf(s, id);
      if (to === from) return;
      L((st, sp) => writeField(writeField(st, { table: NOTE, row: id, field: "parent" }, sp, { value: to, meta: { from } }), { table: NOTE, row: id, field: "sort" }, sp, { value: `k${++uniq}` }));
      return;
    }
    case "toSpace": {
      if (!liveNotes.length) return;
      const id = at(liveNotes, p), targets = liveSpaces.filter((x) => x !== spaceOf(s, id));
      if (!targets.length) return;
      const to = at(targets, q), from = parentOf(s, id), moving = subtree(s, id);
      L((st, sp) => {
        let out = from === null ? st : writeField(st, { table: NOTE, row: id, field: "parent" }, sp, { value: null, meta: { from } });
        for (const m of moving) out = writeField(out, { table: NOTE, row: m, field: "space" }, sp, { value: to });
        return out;
      });
      return;
    }
    case "trash": {
      if (!liveNotes.length) return;
      const id = at(liveNotes, p), taking = subtree(s, id).filter((x) => !isTrashed(s, x));
      L((st, sp) => { let out = st; for (const m of taking) out = writeField(out, { table: NOTE, row: m, field: "trashed" }, sp, { deleted: true, meta: { seen: seenOfRow(st, NOTE, m) } }); return out; });
      return;
    }
    case "deleteSpace": {
      const empty = liveSpaces.filter((x) => !notes(s).some((id) => spaceOf(s, id) === x));
      if (liveSpaces.length < 2 || !empty.length) return;
      const id = at(empty, p);
      L((st, sp) => writeField(st, { table: SPACE, row: id, field: "deleted" }, sp, { value: true }));
      return;
    }
  }
}

// ── the relations ───────────────────────────────────────────────────────────────────────────────────────
const deletionOf = (u: Unit | undefined): Deletion | null => {
  const c = u?.[0];
  return c?.deleted ? { stamp: c.stamp, seen: ((c.meta as { seen?: Record<string, number> } | undefined)?.seen) ?? {} } : null;
};
const createdOf = (s: Store, id: string): Stamp => [...(rowOf(s, NOTE, id).star ?? [])].map((c) => c.stamp).sort(compareStamps)[0]!;
function hasLoop(parents: ReadonlyMap<string, string | null>): boolean {
  for (const start of parents.keys()) {
    const seen = new Set<string>();
    for (let x: string | null | undefined = start; x; x = parents.get(x)) { if (seen.has(x)) return true; seen.add(x); }
  }
  return false;
}
/** Every relation broken in `s`, each as "<relation>: <what>". */
function brokenRelations(s: Store): { relation: Relation; what: string }[] {
  const out: { relation: Relation; what: string }[] = [];
  const all = notes(s);
  for (const id of all) {
    const p = parentOf(s, id);
    if (p !== null && all.includes(p) && spaceOf(s, p) !== spaceOf(s, id)) out.push({ relation: "R1 parent × space", what: `${id} in ${spaceOf(s, id)} under ${p} in ${spaceOf(s, p)}` });
    const sp = spaceOf(s, id);
    if (!isTrashed(s, id) && sp && spaceDeleted(s, sp)) out.push({ relation: "R2 live note in a deleted space", what: `${id} in ${sp}` });
  }
  const links: ParentLink[] = all.map((id) => {
    const win = effectiveUnit(s, { table: NOTE, row: id, field: "parent" })![0]!;
    const from = (win.meta as { from?: string | null } | undefined)?.from;
    return { note: id, parent: (win.value ?? null) as string | null, ...(from === undefined ? {} : { from }), stamp: win.stamp };
  });
  if (hasLoop(resolveMoveCycles(links).parents)) out.push({ relation: "R3 a loop after the 4.10 view", what: "" });
  const tree: TreeNote[] = all.map((id) => ({ id, parent: parentOf(s, id), created: createdOf(s, id), deleted: deletionOf(effectiveUnit(s, { table: NOTE, row: id, field: "trashed" })) }));
  const fixed = new Set(trashOrphanedChildren(tree).fixes.map((f) => f.note));
  const trashed = new Set(tree.filter((t) => t.deleted || fixed.has(t.id)).map((t) => t.id));
  for (const t of tree) if (!trashed.has(t.id) && t.parent && trashed.has(t.parent)) out.push({ relation: "R4 live note under a trashed one after the 4.9 view", what: `${t.id} under ${t.parent}` });
  return out;
}

/** The world, with every merge step (a delivered message, a gossip, the final retransmission) followed by a check on the node that merged. */
class CheckedWorld extends StampedWorld {
  readonly broken: { step: number; node: string; relation: Relation; what: string }[] = [];
  step = 0;
  override ingest(n: SimNode, items: Parameters<StampedWorld["ingest"]>[1]): void {
    super.ingest(n, items);
    for (const b of brokenRelations(n.store)) this.broken.push({ step: this.step, node: n.id, ...b });
  }
}

function steps(rng: Rng, count: number, nodes: number): Step[] {
  const total = MIX.reduce((a, [, x]) => a + x, 0);
  const kind = (): Kind => { let x = rng.next() * total; for (const [k, wgt] of MIX) if ((x -= wgt) < 0) return k; return "new"; };
  const out: Step[] = [];
  // every node starts with three notes in S1, one under another (made on n0 and delivered to all)
  for (let i = 0; i < 3; i++) out.push({ t: "op", node: 0, kind: "new", p: [i / 3, i === 2 ? 0 : 0.9, 0] });
  out.push({ t: "deliver", n: 9999 });
  while (out.length < count) {
    const node = rng.int(nodes);
    for (let i = 0, k = 1 + rng.int(4); i < k; i++) out.push({ t: "op", node, kind: kind(), p: [rng.next(), rng.next(), rng.next()] });
    const turn = rng.next();
    if (turn < 0.2) out.push({ t: "deliver", n: 1 + rng.int(6) });
    else if (turn < 0.35) { const a = rng.int(nodes); out.push({ t: "gossip", a, b: (a + 1 + rng.int(nodes - 1)) % nodes }); }
  }
  return out;
}

function runSeed(seed: number, count: number, nodes = 3): CheckedWorld {
  uniq = 0;
  const rng = makeRng(seed);
  const w = new CheckedWorld(nodes, makeRng(seed ^ 0x5bd1e995));
  // three spaces every node holds from the start (made on n0 and delivered with the first notes)
  w.local(w.nodes[0]!, "spaces", (st, sp) => ["S1", "S2", "S3"].reduce((acc, id) => createRow(acc, { table: SPACE, row: id }, sp, { deleted: false }), st));
  for (const s of steps(rng, count, nodes)) {
    w.step++;
    if (s.t === "op") apply(w, w.nodes[s.node]!, s.kind, s.p);
    else if (s.t === "deliver") w.deliver(s.n);
    else if (s.a !== s.b) { const a = w.nodes[s.a]!, b = w.nodes[s.b]!; w.ingest(b, [...a.store]); w.ingest(a, [...b.store]); }
  }
  w.settle();
  return w;
}
const firstOf = (w: CheckedWorld, r: Relation) => w.broken.find((b) => b.relation === r);

describe("relations between units hold after every merge step (pure simulator)", () => {
  const RUNS = Number(process.env.MERGE_INVARIANT_RUNS ?? 12), STEPS = Number(process.env.MERGE_INVARIANT_STEPS ?? 160);
  const base = process.env.MERGE_INVARIANT_SEED !== undefined ? Number(process.env.MERGE_INVARIANT_SEED) : (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;

  it(`random seeds (MERGE_INVARIANT_SEED=${base}): no relation outside KNOWN_OPEN breaks; the known ones are counted`, () => {
    const seen = new Map<Relation, number>();
    for (let i = 0; i < RUNS; i++) {
      const seed = (base + i) >>> 0;
      const w = runSeed(seed, STEPS);
      for (const b of w.broken) seen.set(b.relation, (seen.get(b.relation) ?? 0) + 1);
      const fresh = w.broken.find((b) => !KNOWN_OPEN.includes(b.relation));
      if (fresh) throw new Error(`seed ${seed} (replay: MERGE_INVARIANT_SEED=${seed} MERGE_INVARIANT_RUNS=1): ${fresh.relation} broken on ${fresh.node} at step ${fresh.step}: ${fresh.what}. A finding: pin it as a fixed it.fails case, do not retry.`);
    }
    console.info(`[mergeCrossFieldSim] seeds ${base}..${base + RUNS - 1}, ${STEPS} steps: ${[...seen].map(([r, n]) => `${r}: ${n} merge steps`).join("; ") || "nothing broken"}`);
  }, 120_000);

  // Pinned from the random run above (seed and step printed by it). Each pair: what breaks with that seed today, exactly; and the relation holding, `it.fails`.
  const PINNED: readonly { relation: Relation; seed: number; why: string }[] = [
    { relation: "R1 parent × space", seed: 1, why: "parent and space are separate units: a reparent on one node and a space move of the same subtree on another give a note under a parent in another space (on a database: the bundle fails at COMMIT, 23514)" },
    { relation: "R2 live note in a deleted space", seed: 2, why: "spaces.deleted and content_nodes.space are units of two rows: a space emptied and deleted on one node while another moved a note into it" },
    { relation: "R4 live note under a trashed one after the 4.9 view", seed: 2, why: "the 4.9 view (trashOrphanedChildren) asks whether the deleter had seen the note's CREATION; a note made earlier and MOVED under the parent the other node trashed stays live under it" },
  ];
  for (const pin of PINNED) {
    it(`seed ${pin.seed}, today: ${pin.relation} breaks`, () => {
      const hit = firstOf(runSeed(pin.seed, 160), pin.relation);
      expect(hit, `seed ${pin.seed} no longer breaks ${pin.relation}: if a fix landed, take it off KNOWN_OPEN and turn the it.fails below`).toBeDefined();
    });
    it.fails(`seed ${pin.seed}, desired: ${pin.relation} holds after every merge step (fails: ${pin.why})`, () => {
      expect(firstOf(runSeed(pin.seed, 160), pin.relation)).toBeUndefined();
    });
  }
  it("the relation not on KNOWN_OPEN (R3) is reached at all (the model makes trash under moves and loops to resolve)", () => {
    // not vacuous: across fixed seeds the model closes loops that the 4.10 view has to cut, and makes notes the 4.9 view has to put in the trash
    let loops = 0, orphans = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const w = runSeed(seed, 160), s = w.nodes[0]!.store, all = notes(s);
      const links: ParentLink[] = all.map((id) => { const win = effectiveUnit(s, { table: NOTE, row: id, field: "parent" })![0]!; const from = (win.meta as { from?: string | null } | undefined)?.from; return { note: id, parent: (win.value ?? null) as string | null, ...(from === undefined ? {} : { from }), stamp: win.stamp }; });
      loops += resolveMoveCycles(links).fixes.length;
      orphans += trashOrphanedChildren(all.map((id) => ({ id, parent: parentOf(s, id), created: createdOf(s, id), deleted: deletionOf(effectiveUnit(s, { table: NOTE, row: id, field: "trashed" })) }))).fixes.length;
    }
    console.info(`[mergeCrossFieldSim] seeds 1..40: ${loops} loops the 4.10 view cut, ${orphans} notes the 4.9 view put in the trash`);
    expect(loops, "R3 is only evidence if the 4.10 view had loops to cut").toBeGreaterThan(0);
    expect(orphans).toBeGreaterThan(0);
  }, 120_000);
});
