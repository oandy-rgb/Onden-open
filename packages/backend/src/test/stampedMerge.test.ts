// The merge core (spine/stampedMerge): one unit, a store of units, bodies, and the cross-row rules of
// docs/architecture/proposals/distributed-ready-2026-11-12.md §4, each with the cases the proposal names. DB-free.
import { describe, expect, it } from "vitest";
import { mergeBody } from "../services/eventLog/bodyMergeMoves.js";
import { resolveBody } from "../spine/stampedMerge/body.js";
import { type Cell, type Json, type Stamp, type Unit, DEFAULT_MAX_SKEW_MS, GENESIS_STAMP_ORIGIN, canonical, conflictsOf, mergeUnit, writeUnit } from "../spine/stampedMerge/unit.js";
import { type Store, STAR, createRow, deleteRow, effectiveUnit, jsonObjectOf, keyField, mergeStore, rowOf, seenOfRow, storeText, writeField } from "../spine/stampedMerge/store.js";
import { resolveSlugs, resolveTagNames, resolveViewNames } from "../spine/stampedMerge/rules/names.js";
import { resolveRunningFocus } from "../spine/stampedMerge/rules/focus.js";
import { noticesForEditedDeletes, recoverLateEdits, trashOrphanedChildren } from "../spine/stampedMerge/rules/trash.js";
import { resolveMoveCycles } from "../spine/stampedMerge/rules/moveCycle.js";
import { identityChangeAllowed, pendingNeedsConfirmation, permissionAt, verdictOfWrite, type PermissionChange } from "../spine/stampedMerge/rules/permission.js";
import { mergeDuplicateRefs } from "../spine/stampedMerge/rules/functionRefs.js";

const T0 = 1_700_000_000_000;
const st = (origin: string, seq: number, wall = T0 + seq, author: string | null = null, counter = 0): Stamp => ({ origin, seq, wall, counter, author, device: null });
const cell = (value: Json, stamp: Stamp, saw: Record<string, number> = {}): Cell => ({ stamp, saw, deleted: false, value });
const tomb = (stamp: Stamp, saw: Record<string, number> = {}, meta?: Json): Cell => ({ stamp, saw, deleted: true, value: null, ...(meta === undefined ? {} : { meta }) });
const genesis = (value: Json): Cell => cell(value, { origin: GENESIS_STAMP_ORIGIN, seq: 0, wall: 0, counter: 0, author: null, device: null });
const heads = (u: Unit) => u.map((c) => `${c.stamp.origin}:${c.stamp.seq}`);

describe("one unit", () => {
  it("the larger stamp is the value; the other stays as a conflict with its value (4.11)", () => {
    const a = [cell("A", st("n1", 1))], b = [cell("B", st("n2", 1, T0 + 5))];
    const r = mergeUnit(a, b);
    expect(r.outcome).toBe("conflict");
    expect(r.unit[0]!.value).toBe("B");
    expect(r.losers.map((c) => c.value)).toEqual(["A"]);
    expect(conflictsOf(r.unit).map((c) => c.value)).toEqual(["A"]);
    expect(canonical(mergeUnit(b, a).unit)).toBe(canonical(r.unit)); // either side computes the same
  });
  it("a write that had seen the old value replaces it: that is not a conflict", () => {
    const old = [cell("A", st("n1", 1))];
    const next = writeUnit(old, st("n2", 1, T0 + 9), { value: "B" });
    const r = mergeUnit(old, next);
    expect(r).toMatchObject({ outcome: "took", write: true, losers: [] });
    expect(heads(r.unit)).toEqual(["n2:1"]);
    expect(mergeUnit(next, old)).toMatchObject({ outcome: "kept", write: false }); // the older one arriving late changes nothing
  });
  it("a write that saw both sides of a conflict ends it", () => {
    const both = mergeUnit([cell("A", st("n1", 1))], [cell("B", st("n2", 1))]).unit;
    expect(both).toHaveLength(2);
    const fixed = writeUnit(both, st("n3", 1, T0 + 99), { value: "C" });
    expect(heads(mergeUnit(both, fixed).unit)).toEqual(["n3:1"]);
  });
  it("a real write made on top of a genesis value replaces it, and is not a conflict", () => {
    const real = writeUnit([genesis("old")], st("n1", 1), { value: "new" });
    const r = mergeUnit([genesis("old")], real);
    expect(r).toMatchObject({ outcome: "took", losers: [] });
    expect(heads(r.unit)).toEqual(["n1:1"]);
    expect(mergeUnit(real, [genesis("old")])).toMatchObject({ outcome: "kept", write: false });
  });
  it("a real write wins over a genesis value it never saw, and that value stays as a conflict (it was somebody's words before stamps existed)", () => {
    // Node A held x and wrote x2 on top of it; node B held y and never changed it.
    const x2 = writeUnit([genesis("x")], st("a", 1), { value: "x2" });
    const r = mergeUnit([genesis("y")], x2);
    expect(r.unit[0]!.value).toBe("x2");
    expect(r.outcome).toBe("conflict");
    expect(r.losers.map((c) => c.value)).toEqual(["y"]);
    expect(canonical(mergeUnit(x2, [genesis("y")]).unit)).toBe(canonical(r.unit));
    // A person who saw both ends it.
    expect(heads(mergeUnit(r.unit, writeUnit(r.unit, st("a", 2, T0 + 9), { value: "z" })).unit)).toEqual(["a:2"]);
    // The genesis value x it did see is gone, not a conflict.
    expect(heads(mergeUnit([genesis("x")], x2).unit)).toEqual(["a:1"]);
  });
  it("two genesis values that differ are both kept, not silently chosen (add-device-snapshot §5)", () => {
    const a = [genesis("from backup")], b = [genesis("from here")];
    const r = mergeUnit(a, b);
    expect(r.outcome).toBe("conflict");
    expect(r.unit).toHaveLength(2);
    expect(canonical(mergeUnit(b, a).unit)).toBe(canonical(r.unit));
    expect(mergeUnit([genesis("same")], [genesis("same")]).outcome).toBe("same");
  });
  it("the same content is neither a conflict nor a change, whether or not the stamps are the same; the larger stamp is shown", () => {
    const a = [cell({ k: 1, j: 2 }, st("n1", 1))], b = [cell({ j: 2, k: 1 }, st("n2", 1, T0 + 50))];
    const r = mergeUnit(a, b), r2 = mergeUnit(b, a);
    expect(r.outcome).toBe("same");
    expect(r.losers).toEqual([]);
    expect(conflictsOf(r.unit)).toEqual([]);
    expect(r.unit[0]!.stamp.origin).toBe("n2");
    expect(canonical(r.unit)).toBe(canonical(r2.unit));
    expect(mergeUnit(a, a)).toMatchObject({ outcome: "same", write: false });
  });
  it("the same tombstone written twice is not a conflict", () => {
    expect(mergeUnit([tomb(st("n1", 1))], [tomb(st("n2", 1))]).outcome).toBe("same");
  });
  it("the same (origin, seq) with other content is refused, not a conflict", () => {
    const r = mergeUnit([cell("A", st("n1", 1))], [cell("B", st("n1", 1))]);
    expect(r).toMatchObject({ outcome: "rejected", reason: "same-stamp-different-content", write: false });
    expect(r.unit[0]!.value).toBe("A");
  });
  it("a stamp whose clock runs more than the limit ahead of ours is deferred, not refused; at the limit it is taken (10 minutes, a parameter)", () => {
    const gate = { nowWall: T0, maxSkewMs: DEFAULT_MAX_SKEW_MS };
    expect(DEFAULT_MAX_SKEW_MS).toBe(10 * 60_000);
    const far = cell("x", st("n1", 1, T0 + DEFAULT_MAX_SKEW_MS + 1));
    expect(mergeUnit(undefined, [far], gate)).toMatchObject({ outcome: "deferred", write: false, deferred: [far] });
    expect(mergeUnit(undefined, [cell("x", st("n1", 1, T0 + DEFAULT_MAX_SKEW_MS))], gate).outcome).toBe("took");
    expect(mergeUnit(undefined, [cell("x", st("n1", 1, T0 + 5_000))], { nowWall: T0, maxSkewMs: 1_000 }).outcome).toBe("deferred");
    // Offered again once our clock has moved on, it is taken.
    expect(mergeUnit(undefined, [far], { nowWall: T0 + 60_000, maxSkewMs: DEFAULT_MAX_SKEW_MS }).outcome).toBe("took");
  });
  it("only the write that is too far ahead waits; the other heads of the same unit are taken now", () => {
    const ok = cell("ok", st("n1", 1, T0)), far = cell("far", st("n2", 1, T0 + 3_600_000));
    const r = mergeUnit([cell("here", st("n3", 1, T0))], [far, ok], { nowWall: T0, maxSkewMs: DEFAULT_MAX_SKEW_MS });
    expect(r.deferred).toEqual([far]);
    expect(r.unit.map((c) => c.value).sort()).toEqual(["here", "ok"]);
  });
  it("without the gate a stamp from the far future wins every later edit: the pollution the gate prevents", () => {
    const future = [cell("poison", st("rogue", 1, T0 + 365 * 86_400_000))];
    const honest = writeUnit(undefined, st("n1", 1, T0 + 1_000), { value: "mine" });
    expect(mergeUnit(honest, future).unit[0]!.value).toBe("poison");
    expect(mergeUnit(honest, future, { nowWall: T0, maxSkewMs: DEFAULT_MAX_SKEW_MS })).toMatchObject({ outcome: "deferred", unit: honest });
  });
  it("malformed writes are refused", () => {
    expect(mergeUnit(undefined, [{ ...cell("x", st("n1", 3)), saw: { n1: 3 } }]).outcome).toBe("rejected"); // saw itself
    expect(mergeUnit(undefined, [{ ...cell("x", st("n1", 1)), stamp: { ...st("n1", 1), seq: -1 } }]).outcome).toBe("rejected");
  });

  // Why a write carries what its writer had seen. With stamps alone, a node that never held the middle write of a chain
  // records a conflict the node that did hold it does not, and the records differ for ever.
  it("with stamps alone the conflict records depend on what a node happened to receive; with `saw` they do not", () => {
    const x = cell("X", st("a", 1));
    const y = writeUnit([x], st("b", 1, T0 + 10), { value: "Y" })[0]!;
    const z = writeUnit([y], st("c", 1, T0 + 20), { value: "Z" })[0]!;
    // naive: a conflict whenever content differs and both are real writes
    const naive = (held: Cell[], incoming: Cell) => (held.every((h) => h.value === incoming.value) ? [] : held.filter((h) => h.value !== incoming.value).map((h) => String(h.value)));
    const node1 = [...naive([x], y), ...naive([y], z)], node2 = naive([x], z);
    expect(node1.sort()).not.toEqual(node2.sort());
    const m1 = mergeUnit(mergeUnit([x], [y]).unit, [z]), m2 = mergeUnit([x], [z]);
    expect(m1.outcome).toBe("took");
    expect(m2.outcome).toBe("took");
    expect(canonical(m1.unit)).toBe(canonical(m2.unit));
    expect(conflictsOf(m1.unit)).toEqual([]);
  });
});

describe("rows, fields and JSON keys", () => {
  const row = { table: "note", row: "n" };
  const base = (): Store => createRow(new Map(), row, st("s", 1, T0, "u0"), { title: "t", body: "b", parent: null });
  it("a field with no stamp of its own follows `*`", () => {
    const s = base();
    expect(effectiveUnit(s, { ...row, field: "title" })![0]).toMatchObject({ value: "t", stamp: { origin: "s", seq: 1 } });
    expect(rowOf(s, "note", "n").fields.size).toBe(3);
  });
  it("one node changes the title, another the body: both stay, whichever way they meet", () => {
    const s = base();
    const a = writeField(s, { ...row, field: "title" }, st("a", 1, T0 + 10), { value: "title by a" });
    const b = writeField(s, { ...row, field: "body" }, st("b", 1, T0 + 11), { value: "body by b" });
    const ab = mergeStore(a, b), ba = mergeStore(b, a);
    expect(storeText(ab.store)).toBe(storeText(ba.store));
    const view = rowOf(ab.store, "note", "n");
    expect(view.fields.get("title")![0]!.value).toBe("title by a");
    expect(view.fields.get("body")![0]!.value).toBe("body by b");
    expect(view.fields.get("parent")![0]!.value).toBe(null);
    expect([...view.fields.values()].every((u) => u.length === 1)).toBe(true); // no conflict anywhere
  });
  it("the same field on both sides: the later wins, the other is a visible conflict, in every order", () => {
    const s = base();
    const a = writeField(s, { ...row, field: "title" }, st("a", 1, T0 + 10), { value: "A" });
    const b = writeField(s, { ...row, field: "title" }, st("b", 1, T0 + 20), { value: "B" });
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const u = effectiveUnit(mergeStore(x, y).store, { ...row, field: "title" })!;
      expect(u[0]!.value).toBe("B");
      expect(conflictsOf(u).map((c) => c.value)).toEqual(["A"]);
    }
  });
  it("two nodes that made the same row id with the same content (derived ids, 4.5) hold one row and no conflict", () => {
    const a = createRow(new Map(), row, st("a", 1, T0, "u0"), { title: "收件匣", parent: null });
    const b = createRow(new Map(), row, st("b", 1, T0 + 5, "u1"), { title: "收件匣", parent: null });
    const m = mergeStore(a, b).store;
    expect([...rowOf(m, "note", "n").fields.values()].every((u) => conflictsOf(u).length === 0)).toBe(true);
    expect(storeText(m)).toBe(storeText(mergeStore(b, a).store));
  });
  it("the same row id made with different content is a conflict on each field that differs, and only those", () => {
    const a = createRow(new Map(), row, st("a", 1, T0), { title: "A", parent: null });
    const b = createRow(new Map(), row, st("b", 1, T0 + 5), { title: "B", parent: null });
    const v = rowOf(mergeStore(a, b).store, "note", "n");
    expect(conflictsOf(v.fields.get("title")!)).toHaveLength(1);
    expect(conflictsOf(v.fields.get("parent")!)).toHaveLength(0);
  });
  it("the stored form is the same however the writes arrived (a field equal to following `*` is not stored)", () => {
    const s = base();
    const edited = writeField(s, { ...row, field: "title" }, st("a", 1, T0 + 10), { value: "x" });
    const m1 = mergeStore(new Map(), s).store;
    const m2 = mergeStore(mergeStore(new Map(), edited).store, s).store;
    const m3 = mergeStore(s, edited).store;
    expect(storeText(m2)).toBe(storeText(m3));
    expect(storeText(m1)).toBe(storeText(s));
  });
  it("a JSON column merges key by key; removing a key is a tombstone for that key", () => {
    const s = createRow(new Map(), { table: "tag", row: "t" }, st("s", 1), { [keyField("a")]: 1, [keyField("b")]: 2 });
    const a = writeField(s, { table: "tag", row: "t", field: keyField("a") }, st("a", 1, T0 + 5), { value: 10 });
    const b = writeField(s, { table: "tag", row: "t", field: keyField("b") }, st("b", 1, T0 + 6), { deleted: true });
    const c = writeField(s, { table: "tag", row: "t", field: keyField("c") }, st("c", 1, T0 + 7), { value: 3 });
    const m = mergeStore(mergeStore(a, b).store, c).store;
    expect(jsonObjectOf(m, "tag", "t")).toEqual({ a: 10, c: 3 });
    expect(storeText(m)).toBe(storeText(mergeStore(c, mergeStore(b, a).store).store));
  });
  it("a key removed on one node and changed on another: the later wins and the other stays visible", () => {
    const s = createRow(new Map(), { table: "tag", row: "t" }, st("s", 1), { [keyField("a")]: 1 });
    const removed = writeField(s, { table: "tag", row: "t", field: keyField("a") }, st("a", 1, T0 + 5), { deleted: true });
    const changed = writeField(s, { table: "tag", row: "t", field: keyField("a") }, st("b", 1, T0 + 9), { value: 2 });
    const u = effectiveUnit(mergeStore(removed, changed).store, { table: "tag", row: "t", field: keyField("a") })!;
    expect(u[0]!.value).toBe(2);
    expect(u[1]!.deleted).toBe(true);
  });
  it("a permanent delete keeps the fields written to the row: they are somebody's words", () => {
    const s = base();
    const purged = deleteRow(s, row, st("a", 1, T0 + 5, "u0"), { seen: { s: 1 } });
    const edited = writeField(s, { ...row, field: "title" }, st("b", 1, T0 + 6, "u1"), { value: "late" });
    const m = mergeStore(purged, edited).store;
    expect(rowOf(m, "note", "n").exists).toBe(false);
    expect(rowOf(m, "note", "n").fields.get("title")![0]!.value).toBe("late");
    expect(effectiveUnit(m, { ...row, field: STAR })![0]!.deleted).toBe(true);
  });
  it("units that are malformed, too far ahead, or reuse a (origin, seq) are left out and reported", () => {
    const local = base();
    const ahead = new Map<string, Unit>([["note\u0001n\u0001title", [cell("x", st("far", 1, T0 + 3_600_000))]]]);
    const r = mergeStore(local, ahead, { nowWall: T0, maxSkewMs: DEFAULT_MAX_SKEW_MS });
    expect(r.rejected).toEqual([]);
    expect(r.deferred.map((x) => x.address.field)).toEqual(["title"]);
    expect(storeText(r.store)).toBe(storeText(local));
    const clash = new Map<string, Unit>([["note\u0001n\u0001*", [cell({ title: "other" }, st("s", 1, T0, "u0"))]]]);
    expect(mergeStore(local, clash).rejected.map((x) => x.reason)).toEqual(["same-stamp-different-content"]);
  });
});

describe("making a row again, events, and system writes", () => {
  const row = { table: "note", row: "n" };
  const made = (): Store => createRow(new Map(), row, st("s", 1, T0, "u0"), { title: "t", body: "b" });
  it("a row deleted for good and made again by another node: both nodes end with the same fields and the same conflicts", () => {
    const base = made();
    const edited = writeField(base, { ...row, field: "title" }, st("a", 1, T0 + 5, "u0"), { value: "edit before the delete" });
    const purged = deleteRow(edited, row, st("a", 2, T0 + 6, "u0"));
    const again = createRow(purged, row, st("b", 1, T0 + 9, "u1"), { title: "again", body: "b2" });
    const concurrent = writeField(edited, { ...row, field: "body" }, st("c", 1, T0 + 7, "u2"), { value: "written while it was being deleted" });
    const m1 = mergeStore(again, concurrent).store, m2 = mergeStore(concurrent, again).store;
    expect(storeText(m1)).toBe(storeText(m2));
    const v = rowOf(m1, "note", "n");
    expect(v.exists).toBe(true);
    expect(v.fields.get("title")!.map((c) => c.value)).toEqual(["again"]); // the recreator saw the old title
    expect(v.fields.get("body")!.map((c) => c.value).sort()).toEqual(["b2", "written while it was being deleted"]); // it never saw this one: a conflict, not a loss
  });
  // A field write that the deleter had SEEN (the tombstone's meta.seen says so) ends with the deletion: after the same id is made again no old write stays beside the
  // recreated value. `createRow` carries the delete's `seen` into the new creation (batch 2b-1) and `droppedBySeen` (store.ts) applies it when merging. The test after it is the other half:
  // what the deleter had NOT seen stays, and rules/trash.ts tells its author.
  it("a write the deleter had seen is not a head again once the row is made again (three nodes: a made and edited it, b deleted and made it again, c never heard of the delete)", () => {
    const a1 = writeField(made(), { ...row, field: "title" }, st("a", 1, T0 + 5, "u0"), { value: "edited by a" });
    const c = a1; // c holds what a made
    const tombstoned = deleteRow(a1, row, st("b", 1, T0 + 6, "u1"), { seen: seenOfRow(a1, "note", "n") });
    // the database drops a purged row's field stamps with the row (migration 190 trigger): what b holds afterwards is the tombstone alone
    const b1 = new Map([...tombstoned].filter(([k]) => k.endsWith("*")));
    const b2 = createRow(b1, row, st("b", 2, T0 + 9, "u1"), { title: "again", body: "b2" });
    const everything = mergeStore(mergeStore(b2, c).store, b1).store, other = mergeStore(c, b2).store;
    expect(storeText(everything)).toBe(storeText(other)); // order does not matter
    expect(rowOf(everything, "note", "n").fields.get("title")!.map((x) => x.value)).toEqual(["again"]);
  });
  it("a write the deleter had NOT seen stays beside the recreated value, so its author can be told", () => {
    const base = made();
    const deleted = deleteRow(base, row, st("b", 1, T0 + 6, "u1"), { seen: seenOfRow(base, "note", "n") });
    const again = createRow(deleted, row, st("b", 2, T0 + 9, "u1"), { title: "again", body: "b2" });
    const unseen = writeField(base, { ...row, field: "title" }, st("a", 1, T0 + 5, "u0"), { value: "written before the delete, never seen by it" });
    const merged = mergeStore(again, unseen).store;
    expect(rowOf(merged, "note", "n").fields.get("title")!.map((x) => x.value).sort()).toEqual(["again", "written before the delete, never seen by it"]);
  });
  it("a recreated value does not cover a field write made by a node that had not seen it, even when the star's sequence number is higher", () => {
    // `*` of node a is write #9, and a wrote the title as #7 on another device's behalf of nobody: the title write is not seen by a creation value.
    const created = createRow(new Map(), row, st("a", 9, T0 + 9), { title: "creation" });
    const earlier = new Map<string, Unit>([["note\u0001n\u0001title", [cell("older edit", st("a", 7, T0 + 7))]]]);
    const u = effectiveUnit(mergeStore(created, earlier).store, { ...row, field: "title" })!;
    expect(u.map((c) => c.value).sort()).toEqual(["creation", "older edit"]);
  });
  it("same transaction: the row's creation and a field written in the same stamp; the event shows the unit the store holds", () => {
    const stamp = st("a", 1, T0);
    const local = createRow(new Map(), row, stamp, { title: "t" });
    const incoming = new Map<string, Unit>([["note\u0001n\u0001title", [cell("t2", stamp)]], ...[...local].filter(([k]) => k.endsWith("*"))]);
    const r = mergeStore(local, incoming);
    for (const e of r.events) expect(canonical(e.result.unit)).toBe(canonical(effectiveUnit(r.store, e.address)));
    expect(r.rejected).toEqual([]);
    expect(effectiveUnit(r.store, { ...row, field: "title" })![0]!.value).toBe("t2"); // the later statement of the same transaction
  });
  it("a creation value that the merged `*` no longer gives is not carried back by the event", () => {
    const created = made();
    const purged = deleteRow(created, row, st("a", 1, T0 + 5));
    const r = mergeStore(created, purged);
    for (const e of r.events) expect(canonical(e.result.unit)).toBe(canonical(effectiveUnit(r.store, e.address)));
    expect(effectiveUnit(r.store, { ...row, field: "title" })).toBeUndefined();
  });
  it("the system does not write to a unit that is in conflict (it would resolve what nobody has looked at); a person's write ends the conflict", () => {
    const a = writeUnit(undefined, st("a", 1, T0), { value: "A" }), b = writeUnit(undefined, st("b", 1, T0 + 5), { value: "B" });
    const conflict = mergeUnit(a, b).unit; // B wins, A is the conflict
    expect(writeUnit(conflict, st("sys", 1, T0 + 9), { value: "recalculated" }, "system")).toBe(conflict);
    const store = new Map<string, Unit>([["note\u0001n\u0001title", conflict]]);
    expect(writeField(store, { table: "note", row: "n", field: "title" }, st("sys", 2, T0 + 9), { value: "x" }, "system")).toBe(store);
    const quiet = writeUnit(undefined, st("a", 3, T0), { value: "A" });
    expect(writeUnit(quiet, st("sys", 3, T0 + 9), { value: "recalculated" }, "system")[0]!.value).toBe("recalculated");
    expect(heads(mergeUnit(conflict, writeUnit(conflict, st("p", 1, T0 + 9), { value: "decided" })).unit)).toEqual(["p:1"]);
  });
});

describe("a body written on two nodes (4.12)", () => {
  const base = "第一行\n第二行\n第三行\n";
  it("one value is its own text", () => {
    expect(resolveBody([cell(base, st("a", 1))], base, mergeBody)).toEqual({ kind: "single", text: base });
  });
  it("two heads with a base go through the one body merge", () => {
    const a = cell("第一行\n甲加的\n第二行\n第三行\n", st("a", 1)), b = cell("第一行\n第二行\n第三行\n乙加的\n", st("b", 1, T0 + 5));
    const r = resolveBody(mergeUnit([a], [b]).unit, base, mergeBody);
    expect(r.kind).toBe("merged");
    expect(r.text).toContain("甲加的"); expect(r.text).toContain("乙加的");
    expect(resolveBody(mergeUnit([b], [a]).unit, base, mergeBody)).toEqual(r);
  });
  it("the same line changed on both: a conflict, the newer text stays in the body and the other is offered back whole", () => {
    const a = cell("第一行\n甲改了\n第三行\n", st("a", 1)), b = cell("第一行\n乙改了\n第三行\n", st("b", 1, T0 + 5));
    const r = resolveBody(mergeUnit([a], [b]).unit, base, mergeBody);
    expect(r.kind).toBe("conflict");
    expect(r.text).toContain("乙改了");
    expect("offered" in r && r.offered.map((c) => c.value)).toEqual([a.value]);
  });
  it("no base found: nothing is merged, the newest stays, the others are kept whole", () => {
    const a = cell("A\n", st("a", 1)), b = cell("B\n", st("b", 1, T0 + 5));
    const r = resolveBody(mergeUnit([a], [b]).unit, null, mergeBody);
    expect(r).toMatchObject({ kind: "needs-decision", text: "B\n", reason: "no-base" });
    expect("offered" in r && r.offered.map((c) => c.value)).toEqual(["A\n"]);
  });
});

describe("4.2 two tags with one name under one parent", () => {
  const tag = (id: string, name: string, seq: number, parent: string | null = null) => ({ id, name, parent, created: st("n", seq) });
  it("the earlier keeps the name, the later is shown as 'name (2)' and the pair is reported", () => {
    const r = resolveTagNames([tag("late", "讀書", 5), tag("early", "讀書", 2)]);
    expect(r.shown.get("late")).toBe("讀書 (2)");
    expect(r.shown.has("early")).toBe(false);
    expect(r.clashes).toEqual([{ scope: "", name: "讀書", keeper: "early", others: ["late"] }]);
  });
  it("three of a name get (2) and (3) in the order they were made, and a real 'name (2)' keeps its own name", () => {
    const r = resolveTagNames([tag("c", "x", 3), tag("a", "x", 1), tag("b", "x", 2), tag("real", "x (2)", 4)]);
    expect(r.shown.get("b")).toBe("x (3)");
    expect(r.shown.get("c")).toBe("x (4)");
    expect(r.shown.has("real")).toBe(false);
  });
  it("different parents are different names; the answer does not depend on the order of the rows", () => {
    const rows = [tag("p", "x", 1, "A"), tag("q", "x", 2, "B"), tag("r", "x", 3, "A")];
    expect([...resolveTagNames(rows).shown]).toEqual([["r", "x (2)"]]);
    expect([...resolveTagNames([...rows].reverse()).shown]).toEqual([["r", "x (2)"]]);
  });
  it("the same rule for saved views on one owner (4.8)", () => {
    const r = resolveViewNames([{ id: "v2", owner: "tag", name: "待辦", created: st("b", 1) }, { id: "v1", owner: "tag", name: "待辦", created: st("a", 1) }, { id: "v3", owner: "other", name: "待辦", created: st("a", 2) }]);
    expect([...r.shown]).toEqual([["v2", "待辦 (2)"]]);
  });
});

describe("4.3 public slugs", () => {
  it("the earlier-made page keeps the slug, the other gets '-2'", () => {
    const r = resolveSlugs([{ id: "b", slug: "intro", created: st("n", 9), published: null }, { id: "a", slug: "intro", created: st("n", 2), published: null }]);
    expect([...r.shown]).toEqual([["b", "intro-2"]]);
  });
  it("a page that was already published keeps its address even when it is the later one; a published URL never changes for an unpublished page", () => {
    const r = resolveSlugs([{ id: "early", slug: "intro", created: st("n", 1), published: null }, { id: "late", slug: "intro", created: st("n", 9), published: st("n", 10) }]);
    expect([...r.shown]).toEqual([["early", "intro-2"]]);
    expect(r.publishedUrlChanged).toEqual([]);
  });
  it("two published pages with one slug: one URL has to change, and that is reported", () => {
    const r = resolveSlugs([{ id: "x", slug: "s", created: st("n", 1), published: st("n", 5) }, { id: "y", slug: "s", created: st("n", 2), published: st("n", 4) }]);
    expect([...r.shown]).toEqual([["x", "s-2"]]);
    expect(r.publishedUrlChanged).toEqual(["x"]);
  });
  it("a suffix never takes a slug someone already has", () => {
    const r = resolveSlugs([{ id: "a", slug: "s", created: st("n", 1), published: null }, { id: "b", slug: "s", created: st("n", 2), published: null }, { id: "c", slug: "s-2", created: st("n", 3), published: null }]);
    expect(r.shown.get("b")).toBe("s-3");
  });
});

describe("4.4 two running focus sessions", () => {
  it("both stay; the earlier ends when the later began; several chain", () => {
    const fixes = resolveRunningFocus([
      { id: "c", actor: "u", startedAt: 300, endedAt: null }, { id: "a", actor: "u", startedAt: 100, endedAt: null }, { id: "b", actor: "u", startedAt: 200, endedAt: null },
      { id: "other", actor: "v", startedAt: 150, endedAt: null }, { id: "done", actor: "u", startedAt: 50, endedAt: 60 },
    ]);
    expect(fixes).toEqual([{ id: "a", endedAt: 200 }, { id: "b", endedAt: 300 }]);
  });
});

describe("4.9 a deletion meeting a change it had not seen", () => {
  const del = (author: string | null, seen: Record<string, number>) => ({ stamp: st("d", 5, T0 + 5, author), seen });
  it("an edit the deleter had not seen: the note is in the trash with the edit, and the editor is told", () => {
    const n = noticesForEditedDeletes([{ id: "note", deleted: del("u0", { b: 1 }), edits: [st("b", 1, T0, "u1"), st("b", 2, T0 + 1, "u1"), st("c", 1, T0, "u0")] }]);
    expect(n).toEqual([{ to: "u1", note: "note", kind: "edit-kept-in-trash" }]); // b:1 was seen, b:2 was not; u0's own edit on another device is not told
  });
  it("nobody is told when the deleter had seen every edit", () => {
    expect(noticesForEditedDeletes([{ id: "n", deleted: del("u0", { b: 9 }), edits: [st("b", 2, T0, "u1")] }])).toEqual([]);
    expect(noticesForEditedDeletes([{ id: "n", deleted: null, edits: [st("b", 2, T0, "u1")] }])).toEqual([]);
  });
  it("a note made under a parent that was deleted before the deleter saw it follows the parent to the trash; its creator is told", () => {
    const r = trashOrphanedChildren([
      { id: "parent", parent: null, created: st("s", 1), deleted: del("u0", { s: 1 }) },
      { id: "kid", parent: "parent", created: st("b", 1, T0, "u1"), deleted: null },
      { id: "grandkid", parent: "kid", created: st("b", 2, T0, "u1"), deleted: null },
      { id: "seen", parent: "parent", created: st("s", 1, T0, "u1"), deleted: null },
    ]);
    // "seen": the deleter's `seen` says it held this note's creation, and still it is live under the deleted note (its cascade would have taken it, so `seen`
    // claimed more than the deleter held, or a later write brought it there): it goes to the trash with the parent, and nobody is told (the simulator's R4)
    expect(r.fixes).toEqual([{ note: "grandkid", trashedWith: "parent" }, { note: "kid", trashedWith: "parent" }, { note: "seen", trashedWith: "parent" }]);
    expect(r.notices).toEqual([{ to: "u1", note: "grandkid", kind: "created-under-deleted-parent" }, { to: "u1", note: "kid", kind: "created-under-deleted-parent" }]);
  });
  it("a note made long before and MOVED under a parent the deleter had trashed without seeing the move goes to the trash with it; the mover is told, and the notes under it go too", () => {
    const r = trashOrphanedChildren([
      { id: "parent", parent: null, created: st("s", 1), deleted: del("u0", { s: 1, b: 1 }) },
      { id: "moved", parent: "parent", created: st("b", 1, T0, "u1"), placed: st("b", 3, T0 + 3, "u2"), deleted: null },
      { id: "under", parent: "moved", created: st("b", 1, T0, "u1"), deleted: null },
    ]);
    expect(r.fixes).toEqual([{ note: "moved", trashedWith: "parent" }, { note: "under", trashedWith: "parent" }]);
    expect(r.notices).toEqual([{ to: "u2", note: "moved", kind: "created-under-deleted-parent" }]); // the mover; the note under it was made where the deleter saw it
  });
  it("the one who deleted is not told about their own device's child", () => {
    const r = trashOrphanedChildren([{ id: "p", parent: null, created: st("s", 1), deleted: del("u0", {}) }, { id: "k", parent: "p", created: st("b", 1, T0, "u0"), deleted: null }]);
    expect(r.fixes).toHaveLength(1);
    expect(r.notices).toEqual([]);
  });
  it("a permanent delete: the note does not come back; each author gets the writes the deleter had not seen as a recovery copy", () => {
    const copies = recoverLateEdits([{ id: "gone", purged: del("u0", { b: 1 }), writes: [
      { field: "title", stamp: st("b", 1, T0, "u1"), value: "seen" }, { field: "body", stamp: st("b", 2, T0, "u1"), value: "late" }, { field: "title", stamp: st("c", 1, T0, "u0"), value: "mine" },
    ] }]);
    expect(copies.map((c) => [c.to, c.fields.map((f) => f.value), c.notify])).toEqual([["u0", ["mine"], false], ["u1", ["late"], true]]);
  });
});

describe("4.10 two moves that make a loop", () => {
  it("the later move does not take effect: the note stays where it was, and its author is told", () => {
    const r = resolveMoveCycles([
      { note: "a", parent: "b", from: null, stamp: st("n1", 5, T0 + 5, "u1") },
      { note: "b", parent: "a", from: null, stamp: st("n2", 6, T0 + 9, "u2") },
    ]);
    expect(r.fixes).toEqual([{ note: "b", parent: null, notify: "u2" }]);
    expect(r.parents.get("b")).toBe(null);
    expect(r.needsDecision).toEqual([]);
  });
  it("the answer does not depend on the order of the rows or on which note the walk starts from", () => {
    const links = [
      { note: "a", parent: "c", from: "x", stamp: st("n1", 1, T0 + 1, "u1") }, { note: "b", parent: "a", stamp: st("n1", 2, T0 + 2, "u1") },
      { note: "c", parent: "b", from: "y", stamp: st("n2", 3, T0 + 3, "u2") }, { note: "x", parent: null, stamp: st("n1", 0, T0, "u1") },
    ];
    expect(resolveMoveCycles(links)).toEqual(resolveMoveCycles([...links].reverse()));
    expect(resolveMoveCycles(links).fixes).toEqual([{ note: "c", parent: "y", notify: "u2" }]);
  });
  it("a loop made only of notes that were created there has no earlier place: it is cut and reported", () => {
    const r = resolveMoveCycles([{ note: "a", parent: "b", stamp: st("n", 1) }, { note: "b", parent: "a", stamp: st("n", 2) }]);
    expect(r.needsDecision).toEqual(["b"]);
    expect(r.parents.get("b")).toBe(null);
  });
  it("no loop, no change", () => {
    expect(resolveMoveCycles([{ note: "a", parent: "b", from: null, stamp: st("n", 1) }, { note: "b", parent: null, stamp: st("n", 2) }]).fixes).toEqual([]);
  });
});

describe("4.1 a revocation holds from then on; 4.13 and 4.14", () => {
  const ch = (actor: string, permission: PermissionChange["permission"], seq: number): PermissionChange => ({ actor, permission, stamp: st("main", seq, T0 + seq * 1000) });
  const timeline = [ch("u1", "edit", 1), ch("u1", "none", 5)];
  it("what was written before the revocation stays; what was written after it is a suggestion, not dropped", () => {
    expect(verdictOfWrite(timeline, { author: "u1", stamp: st("p", 1, T0 + 3000) })).toBe("apply");
    expect(verdictOfWrite(timeline, { author: "u1", stamp: st("p", 2, T0 + 6000) })).toBe("suggestion");
    expect(verdictOfWrite(timeline, { author: "stranger", stamp: st("p", 3, T0 + 6000) })).toBe("suggestion");
  });
  it("computed from the whole set of changes, the answer does not depend on the order they arrived in", () => {
    const w = { author: "u1", stamp: st("p", 2, T0 + 6000) };
    expect(verdictOfWrite([...timeline].reverse(), w)).toBe(verdictOfWrite(timeline, w));
    expect(permissionAt(timeline, "u1", st("main", 0, T0 + 1000))).toBe("none"); // a write stamped just before the change was not allowed by it
  });
  // Expected to fail until the open question is decided (PR, "需要決定"): `it.fails` turns green the day it starts to pass, which is the signal to look at it again.
  it.fails("PINNED, not solved: a write judged on arrival by the changes held then gives the same state whichever of the write and a late revocation arrives first", () => {
    const write = { author: "u1", stamp: st("p", 2, T0 + 6000), value: "edit while offline" };
    const arrive = (order: ("write" | "revocation")[]): string[] => {
      const known: PermissionChange[] = [ch("u1", "edit", 1)];
      const applied: string[] = [];
      for (const what of order) {
        if (what === "revocation") known.push(ch("u1", "none", 5));
        else if (verdictOfWrite(known, write) === "apply") applied.push(write.value);
      }
      return applied;
    };
    expect(arrive(["write", "revocation"])).toEqual(arrive(["revocation", "write"])); // fails: the verdict is taken once, on arrival
    // What would make them agree: keep what the write replaced and recompute the unit's value from every write and every
    // permission change held. The unit state keeps only the heads, so that is not possible without keeping history. See the README.
  });
  it("owner transfer, invitations and sign-in links count only from the main server (4.13)", () => {
    expect(identityChangeAllowed({ kind: "invite", stamp: st("main", 1) }, "main")).toBe(true);
    expect(identityChangeAllowed({ kind: "owner-transfer", stamp: st("phone", 1) }, "main")).toBe(false);
  });
  it("a node away longer than the retry record is kept (30 days) lists what it has to send for confirmation (4.14)", () => {
    expect(pendingNeedsConfirmation(T0, T0 + 29 * 86_400_000)).toBe(false);
    expect(pendingNeedsConfirmation(T0, T0 + 31 * 86_400_000)).toBe(true);
  });
});

describe("function_refs made twice on two nodes", () => {
  const ref = (id: string, seq: number, config: Record<string, Unit>) => ({ id, holder: "h", fn: "f", instance: "i", created: st("n", seq), config });
  it("the earlier row stays; the other row's config keys are merged into it key by key", () => {
    const early = ref("early", 1, { a: [cell(1, st("x", 1))], b: [cell("old", st("x", 2))] });
    const late = ref("late", 2, { b: [cell("new", st("y", 1, T0 + 100))], c: [cell(3, st("y", 2))] });
    const [m] = mergeDuplicateRefs([late, early]);
    expect(m).toMatchObject({ keepId: "early", dropIds: ["late"] });
    expect(Object.keys(m!.config).sort()).toEqual(["a", "b", "c"]);
    expect(m!.config.b!.winner.value).toBe("new");
    expect(m!.config.b!.conflicts.map((c) => c.value)).toEqual(["old"]);
    expect(m!.config.c!.conflicts).toEqual([]);
    expect(mergeDuplicateRefs([early, late])).toEqual(mergeDuplicateRefs([late, early]));
  });
  it("a write of one row never counts as having seen a write of the other row, even when its `saw` is larger", () => {
    // Both are writes of node x; the later one's `saw` reaches x:5, which is a statement about ITS row's key, not the other's.
    const a = ref("a", 1, { k: [cell("kept row", st("x", 5, T0 + 1))] });
    const b = ref("b", 2, { k: [cell("other row", st("x", 9, T0 + 2), { x: 8 })] });
    expect(mergeDuplicateRefs([a, b])[0]!.config.k).toMatchObject({ winner: { value: "other row" }, conflicts: [{ value: "kept row" }] });
  });
  it("a reference with a natural key of its own is left alone", () => {
    expect(mergeDuplicateRefs([ref("a", 1, {}), { ...ref("b", 2, {}), instance: "other" }])).toEqual([]);
  });
});
