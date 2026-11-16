// The algebra the merge claims (spine/stampedMerge/README.md: commutative, associative, idempotent), tested directly on random histories rather than case by case (review of PR #1758, note-cf D).
// A history: several nodes write one unit, some after merging another node's state (their `saw` covers it), some without ever hearing (concurrent), one with a genesis value, one with a clock far ahead.
// For the set of writes it produced: (a) EVERY order of merging them in (all permutations; 6 writes → 720) gives the same unit, element for element, and the same conflicts; (b) merging any write twice changes nothing;
// (c) merging two groups separately and then the two results gives the same as merging all (associativity). The row level (rows.ts) gets the same: every order of three nodes' states, a state merged with itself, and
// the grouping, compared by what the row shows and by what is stored of it. No database.
import { describe, expect, it } from "vitest";
import { type Cell, type Stamp, type Unit, canonical, conflictsOf, mergeUnit, writeUnit, GENESIS_STAMP_ORIGIN } from "../spine/stampedMerge/unit.js";
import { type Store, createRow, deleteRow, effectiveUnit, fieldsOf, mergeStore, rowOf, seenOfRow, storeText, writeField, STAR, addressKey } from "../spine/stampedMerge/store.js";
import { mergeRow, type RowState } from "../spine/stampedMerge/rows.js";
import { makeRng } from "./helpers/distSim/rng.js";

const T0 = 1_700_000_000_000;
const st = (origin: string, seq: number, wall: number): Stamp => ({ origin, seq, wall, counter: 0, author: origin, device: null });
const fold = (cells: readonly Cell[]): Unit | undefined => cells.reduce<Unit | undefined>((acc, c) => (acc ? mergeUnit(acc, [c]).unit : [c]), undefined);
const text = (u: Unit | undefined) => (u ? canonical(u) : "none");
const permutations = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));

/** The writes of a random history of `nodes` nodes over one unit. */
function history(seed: number): Cell[] {
  const rng = makeRng(seed);
  const local = new Map<string, Unit | undefined>();
  const seq = new Map<string, number>();
  const all: Cell[] = [];
  const nodes = ["a", "b", "c"];
  if (rng.chance(0.4)) for (const n of nodes) local.set(n, [{ stamp: { origin: GENESIS_STAMP_ORIGIN, seq: 0, wall: 0, counter: 0, author: null, device: null }, saw: {}, deleted: false, value: rng.chance(0.3) ? "other genesis" : "genesis" }]);
  let clock = T0;
  for (let i = 0; i < 6; i++) {
    const n = rng.pick(nodes);
    if (rng.chance(0.4)) { // hears from another node first
      const other = rng.pick(nodes.filter((x) => x !== n));
      const theirs = local.get(other);
      if (theirs) local.set(n, local.get(n) ? mergeUnit(local.get(n)!, theirs).unit : theirs);
    }
    const s = seq.get(n) ?? 0; seq.set(n, s + 1);
    clock += 1 + rng.int(4);
    const ahead = n === "c" && rng.chance(0.3) ? 30 * 60_000 : 0; // a clock far ahead
    const unit = writeUnit(local.get(n), st(n, s + 1, clock + ahead), rng.chance(0.15) ? { deleted: true } : { value: `${n}${i}` });
    local.set(n, unit);
    all.push(unit[0]!);
  }
  return all;
}

describe("the unit merge: commutative, associative, idempotent (direct)", () => {
  it("every order, a repeat, and any grouping give the same unit and the same conflicts", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const cells = history(seed);
      const reference = fold(cells);
      for (const order of permutations(cells.slice(0, 6))) {
        const u = fold(order);
        expect(text(u), `seed ${seed}: an order`).toBe(text(reference));
        expect(canonical(conflictsOf(u!)), `seed ${seed}: conflicts`).toBe(canonical(conflictsOf(reference!)));
      }
      for (const c of cells) expect(text(fold([...cells, c, c])), `seed ${seed}: a write twice`).toBe(text(reference));
      for (let cut = 1; cut < cells.length; cut++) {
        const left = fold(cells.slice(0, cut))!, right = fold(cells.slice(cut))!;
        expect(text(mergeUnit(left, right).unit), `seed ${seed}: grouping at ${cut}`).toBe(text(reference));
        expect(text(mergeUnit(right, left).unit), `seed ${seed}: grouping at ${cut}, swapped`).toBe(text(reference));
      }
    }
  });
});

describe("the row merge (rows.ts): the same on every order, with itself, and grouped", () => {
  const row = { table: "note", row: "n" };
  const stateOf = (store: Store): RowState => {
    const star = store.get(addressKey({ ...row, field: STAR }));
    const own = new Map<string, Unit>(), creation = new Map<string, string | null>();
    for (const f of fieldsOf(store, row.table, row.row)) {
      const unit = store.get(addressKey({ ...row, field: f }));
      if (unit) { const eff = effectiveUnit(store, { ...row, field: f })!; const stars = new Set((star ?? []).map((c) => `${c.stamp.origin}:${c.stamp.seq}`)); own.set(f, [...unit, ...eff.filter((c) => Object.keys(c.saw).length === 0 && stars.has(`${c.stamp.origin}:${c.stamp.seq}`) && canonical(c.value) !== canonical(eff[0]!.value) && !unit.some((u) => u.stamp.origin === c.stamp.origin && u.stamp.seq === c.stamp.seq))]); }
      else { const d = effectiveUnit(store, { ...row, field: f }); if (d) creation.set(f, d[0]!.value as string); }
    }
    return { star: star?.map((c): Cell => ({ ...c, value: c.deleted ? null : {} })), own, creation };
  };
  const shown = (r: ReturnType<typeof mergeRow>): string => ("rejected" in r ? `rejected ${r.rejected}` : `${r.exists}|${canonical(r.star)}|${[...r.fields].sort(([x], [y]) => (x < y ? -1 : 1)).map(([f, u]) => `${f}=${canonical(u)}`).join(";")}`);

  function states(seed: number): Store[] {
    const rng = makeRng(seed);
    const base = createRow(new Map(), row, st("s", 1, T0), { title: "t", body: "b" });
    const out: Store[] = [];
    for (const who of ["a", "b", "c"]) {
      let s = base, seq = 0, clock = T0 + 10;
      for (let i = 0; i < 3; i++) {
        seq++; clock += 1 + rng.int(5);
        const op = rng.int(10), stamp = st(who, seq, clock);
        const exists = rowOf(s, "note", "n").exists;
        s = !exists ? (op < 5 ? createRow(new Map([...s].filter(([k]) => k.endsWith("*"))), row, stamp, { title: `${who}new`, body: "x" }) : s)
          : op < 4 ? writeField(s, { ...row, field: "title" }, stamp, { value: `${who}${i}` })
          : op < 7 ? writeField(s, { ...row, field: "body" }, stamp, { value: `${who}b${i}` })
          : op < 9 ? deleteRow(s, row, stamp, { seen: seenOfRow(s, "note", "n") }) : s;
      }
      out.push(s);
    }
    return out;
  }

  it("any order of two states, a state with itself, and the store the same writes make", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const [a, b, c] = states(seed).map(stateOf) as [RowState, RowState, RowState];
      for (const [x, y] of [[a, b], [a, c], [b, c]] as const) expect(shown(mergeRow(x, y)), `seed ${seed}: commutative`).toBe(shown(mergeRow(y, x)));
      for (const x of [a, b, c]) expect(shown(mergeRow(x, x)), `seed ${seed}: idempotent`).toBe(shown(mergeRow(undefined, x)));
      // the merge of all three, in the store (where grouping is checked by storeText, bit for bit) in every order and grouping
      const [sa, sb, sc] = states(seed) as [Store, Store, Store];
      const all = [sa, sb, sc];
      const reference = storeText(mergeStore(mergeStore(sa, sb).store, sc).store);
      for (const order of permutations(all)) expect(storeText(order.reduce((acc, s) => mergeStore(acc, s).store)), `seed ${seed}: an order of three`).toBe(reference);
      expect(storeText(mergeStore(sa, mergeStore(sb, sc).store).store), `seed ${seed}: grouping`).toBe(reference);
    }
  });
});
