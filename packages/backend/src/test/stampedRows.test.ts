// The database form of a row's merge (spine/stampedMerge/rows.ts mergeRow) gives what the pure store gives (store.ts mergeStore) for the same writes: the same fields with the same heads, and the same
// answer to "does the row exist", for the cases of the merge tests (a row made again after a delete, what the deleter had seen, concurrent edits, a delete against an edit) and for random histories.
// No database.
import { describe, expect, it } from "vitest";
import { type Store, createRow, deleteRow, effectiveUnit, fieldsOf, mergeStore, rowOf, seenOfRow, writeField, STAR, addressKey } from "../spine/stampedMerge/store.js";
import { type Cell, type Stamp, type Unit, canonical, conflictsOf, rejectReason } from "../spine/stampedMerge/unit.js";
import { mergeRow, type RowState } from "../spine/stampedMerge/rows.js";
import { makeRng } from "./helpers/distSim/rng.js";

const T0 = 1_700_000_000_000;
const row = { table: "note", row: "n" };
const st = (origin: string, seq: number, wall: number, author = origin): Stamp => ({ origin, seq, wall, counter: 0, author, device: null });

/** What the database keeps of a row, from a store: `*` as `{}` or a tombstone; the fields' own units; the creation's value for each field that has none. */
function peerStateOf(store: Store): RowState {
  const star = store.get(addressKey({ ...row, field: STAR }));
  const own = new Map<string, Unit>();
  const creation = new Map<string, string | null>();
  for (const f of fieldsOf(store, row.table, row.row)) {
    const unit = store.get(addressKey({ ...row, field: f }));
    if (unit) {
      // a creation value that lost to an own write is kept as a head with its value (dbUnits.ts storeUnit): it is the only place it lives
      const eff = effectiveUnit(store, { ...row, field: f })!;
      const creations = new Set((star ?? []).map((c) => `${c.stamp.origin}:${c.stamp.seq}`));
      const lost = eff.filter((c) => Object.keys(c.saw).length === 0 && creations.has(`${c.stamp.origin}:${c.stamp.seq}`) && canonical(c.value) !== canonical(eff[0]!.value) && !unit.some((u) => u.stamp.origin === c.stamp.origin && u.stamp.seq === c.stamp.seq));
      own.set(f, [...unit, ...lost]);
    } else {
      const derived = effectiveUnit(store, { ...row, field: f });
      if (derived) creation.set(f, derived[0]!.value as string);
    }
  }
  return { star: star?.map((c): Cell => ({ ...c, value: c.deleted ? null : {} })), own, creation };
}
/** The same for each field's shown unit, as text. */
const shown = (units: Map<string, Unit>) => [...units].sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, u]) => `${f}=${u.map((c) => `${c.stamp.origin}:${c.stamp.seq}:${canonical(c.value)}`).join("|")}`).join("\n");

function sameAs(a: Store, b: Store, label: string): void {
  const store = mergeStore(a, b).store;
  const view = rowOf(store, row.table, row.row);
  const merged = mergeRow(peerStateOf(a), peerStateOf(b));
  if ("rejected" in merged) throw new Error(`${label}: rejected ${merged.rejected}`);
  expect(merged.exists, `${label}: exists`).toBe(view.exists);
  if (view.exists) expect(shown(merged.fields), `${label}: fields`).toBe(shown(view.fields));
  // the other order gives the same
  const other = mergeRow(peerStateOf(b), peerStateOf(a));
  if ("rejected" in other) throw new Error(`${label}: rejected ${other.rejected}`);
  expect(shown(other.fields), `${label}: other order`).toBe(shown(merged.fields));
}

describe("a row's merge on a database equals the pure store's", () => {
  const made = (): Store => createRow(new Map(), row, st("s", 1, T0), { title: "t", body: "b" });
  it("two edits of different fields, and of one field", () => {
    const base = made();
    sameAs(writeField(base, { ...row, field: "title" }, st("a", 1, T0 + 1), { value: "A" }), writeField(base, { ...row, field: "body" }, st("b", 1, T0 + 2), { value: "B" }), "different fields");
    sameAs(writeField(base, { ...row, field: "title" }, st("a", 1, T0 + 1), { value: "A" }), writeField(base, { ...row, field: "title" }, st("b", 1, T0 + 2), { value: "B" }), "one field");
  });
  it("a delete against an edit, and a row made again after a delete (what the deleter had seen, what it had not)", () => {
    const base = made();
    const edited = writeField(base, { ...row, field: "title" }, st("a", 1, T0 + 5), { value: "edit before the delete" });
    const purged = deleteRow(edited, row, st("b", 1, T0 + 6), { seen: seenOfRow(edited, "note", "n") });
    const again = createRow(new Map([...purged].filter(([k]) => k.endsWith("*"))), row, st("b", 2, T0 + 9), { title: "again", body: "b2" });
    sameAs(again, edited, "made again, the edit was seen");
    const unseen = writeField(base, { ...row, field: "title" }, st("c", 1, T0 + 5), { value: "unseen" });
    sameAs(again, unseen, "made again, an edit the deleter had not seen");
    sameAs(deleteRow(base, row, st("b", 1, T0 + 6)), writeField(base, { ...row, field: "body" }, st("a", 1, T0 + 7), { value: "late" }), "delete against an edit");
  });
  it("random histories of two nodes agree with the store", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = makeRng(seed);
      let a = made(), b = made(), clock = T0;
      const seq = { a: 0, b: 0 };
      for (let i = 0; i < 6; i++) {
        for (const who of ["a", "b"] as const) {
          const s = st(who, ++seq[who], clock += 1 + rng.int(3));
          const target = who === "a" ? a : b;
          const op = rowOf(target, "note", "n").exists || rng.chance(0.5) ? rng.int(10) : 9; // a database writes a field only of a row it holds
          const exists = rowOf(target, "note", "n").exists;
          const next = !exists && op < 8 ? target : op < 4 ? writeField(target, { ...row, field: "title" }, s, { value: `${who}${i}` })
            : op < 7 ? writeField(target, { ...row, field: "body" }, s, { value: `${who}b${i}` })
            : op < 8 ? deleteRow(target, row, s, { seen: seenOfRow(target, "note", "n") })
            : op < 9 && rowOf(target, "note", "n").exists === false ? createRow(new Map([...target].filter(([k]) => k.endsWith("*"))), row, s, { title: `${who}new${i}`, body: "x" })
            : target;
          if (who === "a") a = next; else b = next;
        }
        if (rng.chance(0.3)) { a = mergeStore(a, b).store; }
      }
      try { sameAs(a, b, `seed ${seed}`); } catch (e) { if (process.env.DBG) { const j = (st: RowState) => JSON.stringify({ star: st.star, own: [...st.own], creation: [...st.creation] }); console.log('A', j(peerStateOf(a))); console.log('B', j(peerStateOf(b))); } throw e; }
    }
  });
});

// Review of PR #1853, rounds 6 and 7: a side that does not hold the row (only its stamps: a row that went with its note) has no values. The same write seen with a value on
// one side and without on the other is not "the same stamp with other content", and the copy with the value is kept (round 7, point 4). A cell without a value is a stamp,
// never a value (round 7, point 3): the stamps merge as always (so both nodes end with the same), and what the column shows is the winner among the cells with a value.
describe("a copy of a write without its value (unit.ts `valueless`: a mark of the cell, kept and sent as such; review of PR #1853, round 8)", () => {
  const c = st("A", 1, T0 - 10), s0 = st("B", 2, T0 - 5), s = st("A", 3, T0);
  const star: Cell[] = [{ stamp: c, saw: {}, deleted: false, value: {} }];
  type X = { stamp: Stamp; value: string | null; bare?: true };
  const side = (cells: X[], field = "anchor"): RowState =>
    ({ star, own: new Map([[field, cells.map((x): Cell => ({ stamp: x.stamp, saw: { A: 1 }, deleted: false, value: x.value, ...(x.bare ? { valueless: true as const } : {}) }))]]), creation: new Map() });
  const merged = (m: ReturnType<typeof mergeRow>, field = "anchor") => ("rejected" in m ? m : {
    stamps: m.fields.get(field)!.map((x) => `${x.stamp.origin}:${x.stamp.seq}:${x.valueless ? "(no value)" : String(x.value)}`),
    conflicts: conflictsOf(m.fields.get(field)!).map((x) => String(x.value)),
    events: m.events.filter((e) => e.field === field).map((e) => String(e.result.unit[0]!.value)),
  });
  it("the same write with and without its value merges, either way round, into the copy with the value", () => {
    const held = side([{ stamp: s, value: "x1" }]), bare = side([{ stamp: s, value: null, bare: true }]);
    expect(merged(mergeRow(held, bare))).toEqual({ stamps: ["A:3:x1"], conflicts: [], events: [] });
    expect(merged(mergeRow(bare, held))).toEqual({ stamps: ["A:3:x1"], conflicts: [], events: ["x1"] });
  });
  it("a write without its value stays marked through the merge, either way round: never a NULL, never a conflict to show, and no event says it was taken", () => {
    const held = side([{ stamp: s0, value: "x0" }]), bare = side([{ stamp: s, value: null, bare: true }]);
    // concurrent (neither saw the other): both stay as heads; the winner says no value, so nothing new is shown
    const want = { stamps: ["A:3:(no value)", "B:2:x0"], conflicts: ["x0"], events: [] };
    expect(merged(mergeRow(held, bare))).toEqual(want);
    expect(merged(mergeRow(bare, held))).toEqual(want);
  });
  it("only copies without values: the stamps stay, each marked, and nothing is shown", () => {
    const one = side([{ stamp: s0, value: null, bare: true }]), other = side([{ stamp: s, value: null, bare: true }]);
    expect(merged(mergeRow(one, other))).toEqual({ stamps: ["A:3:(no value)", "B:2:(no value)"], conflicts: [], events: [] });
    expect(merged(mergeRow(other, one))).toEqual({ stamps: ["A:3:(no value)", "B:2:(no value)"], conflicts: [], events: [] });
  });
  it("the same write with two different values is still refused, and a NULL is a value", () => {
    expect(mergeRow(side([{ stamp: s, value: "x1" }]), side([{ stamp: s, value: "x2" }]))).toEqual({ rejected: "same-stamp-different-content", unit: "anchor" });
    expect(mergeRow(side([{ stamp: s, value: "x1" }]), side([{ stamp: s, value: null }]))).toEqual({ rejected: "same-stamp-different-content", unit: "anchor" });
  });
  it("a mark on a tombstone, on a value or on a field's tombstone is not the format", () => {
    expect(rejectReason({ stamp: s, saw: { A: 1 }, deleted: true, value: null, valueless: true })).toBe("malformed");
    expect(rejectReason({ stamp: s, saw: { A: 1 }, deleted: false, value: "x", valueless: true })).toBe("malformed");
    expect(mergeRow(undefined, { star, own: new Map([["anchor", [{ stamp: s, saw: { A: 1 }, deleted: true, value: null }]]]), creation: new Map() })).toEqual({ rejected: "malformed", unit: "anchor" });
  });
});

describe("a unit a foreign key empties (dbUnits.ts clearedOnDelete; review of PR #1853, round 9, point 1)", () => {
  const c = st("A", 1, T0 - 10), s = st("A", 3, T0), t = st("B", 4, T0 + 5);
  const star: Cell[] = [{ stamp: c, saw: {}, deleted: false, value: {} }];
  const side = (field: string, cells: Array<{ stamp: Stamp; value: string | null }>): RowState =>
    ({ star, own: new Map([[field, cells.map((x): Cell => ({ stamp: x.stamp, saw: { A: 1 }, deleted: false, value: x.value }))]]), creation: new Map() });
  const task = new Map([["task", { composite: false, columns: ["task_id"] }]]);
  const detached = new Map([["detached", { composite: true, columns: ["detached_note_id"] }]]);
  const shown = (m: ReturnType<typeof mergeRow>, field: string) => ("rejected" in m ? m : m.fields.get(field)!.map((x) => `${x.stamp.origin}:${x.stamp.seq}:${String(x.value)}`));
  it("one write held with its id and with NULL (the database emptied it): no clash, either way round, the copy with the id is kept", () => {
    const named = side("task", [{ stamp: s, value: "T" }]), emptied = side("task", [{ stamp: s, value: null }]);
    expect(shown(mergeRow(named, emptied, task), "task")).toEqual(["A:3:T"]);
    expect(shown(mergeRow(emptied, named, task), "task")).toEqual(["A:3:T"]);
    // the same in a composite: only the declared column may differ
    const a = side("detached", [{ stamp: s, value: `{"detached_tags": ["x"], "detached_note_id": "D"}` }]), b = side("detached", [{ stamp: s, value: `{"detached_tags": ["x"], "detached_note_id": null}` }]);
    expect(shown(mergeRow(a, b, detached), "detached")).toEqual([`A:3:{"detached_tags": ["x"], "detached_note_id": "D"}`]);
    expect(shown(mergeRow(b, a, detached), "detached")).toEqual([`A:3:{"detached_tags": ["x"], "detached_note_id": "D"}`]);
  });
  it("without the declaration, or two different ids, or another column that differs: still refused", () => {
    expect(mergeRow(side("task", [{ stamp: s, value: "T" }]), side("task", [{ stamp: s, value: null }]))).toEqual({ rejected: "same-stamp-different-content", unit: "task" });
    expect(mergeRow(side("task", [{ stamp: s, value: "T" }]), side("task", [{ stamp: s, value: "U" }]), task)).toEqual({ rejected: "same-stamp-different-content", unit: "task" });
    expect(mergeRow(side("detached", [{ stamp: s, value: `{"detached_tags": ["x"], "detached_note_id": "D"}` }]), side("detached", [{ stamp: s, value: `{"detached_tags": ["y"], "detached_note_id": null}` }]), detached))
      .toEqual({ rejected: "same-stamp-different-content", unit: "detached" });
  });
  it("a NULL that is a write of its own (another stamp) is a write like any other: the later wins", () => {
    expect((shown(mergeRow(side("task", [{ stamp: s, value: "T" }]), side("task", [{ stamp: t, value: null }]), task), "task") as string[])[0]).toBe("B:4:null");
  });
});

