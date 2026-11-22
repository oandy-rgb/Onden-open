// The handwriting merge after it stopped depending on which side is `incoming` (jsonMerge weaveOrder; property file
// test/properties/inkMergeAlgebra.property.test.ts): what that changes for drawings stored before it, for an app version
// that still merges the old way, and the rule for a page deleted on one device while the other drew on it.
import { describe, expect, it } from "vitest";
import { decodeInk, encodeInk, inkPageOrder, mergeInk, mergeInkHeads, notePages, revertInkConflicts, type InkDocument, type InkPageRecord, type InkStroke } from "./ink.js";
import { weaveOrder } from "./jsonMerge.js";

const stroke = (id: string, tag = 0): InkStroke => ({ id, points: [[1, 2], [3 + tag, 4]], color: tag ? "#ff0000" : "#000000", size: 2, toolId: "pen" });
const page = (strokes: InkStroke[], extra: Partial<InkDocument> = {}): InkDocument => ({ version: 1, strokes, erased: {}, page: { width: 1000 }, ...extra });
const record = (key: string, doc: InkDocument): InkPageRecord => ({ key, background: { kind: "blank" }, size: { width: 1000, height: 1400 }, doc });
const book = (first: InkStroke[], more: Record<string, InkStroke[]>, order = Object.keys(more)): InkDocument =>
  page(first, { morePages: { version: 1, pages: Object.fromEntries(Object.entries(more).map(([k, s]) => [k, record(k, page(s))])), order } });
const enc = (d: InkDocument) => encodeInk(d);
const note = (raw: string): InkDocument => { const d = decodeInk(raw); if (d.kind !== "page") throw new Error("not a note"); return d.doc; };
const strokeIds = (raw: string) => note(raw).strokes.map((s) => s.id);
const allIds = (raw: string) => { const d = note(raw); return [...d.strokes, ...Object.values(d.morePages?.pages ?? {}).flatMap((p) => p.doc.strokes)].map((s) => s.id).sort(); };

describe("weaveOrder — one rule for every position a merge outputs", () => {
  const w = (base: string[], ...sides: string[][]) => weaveOrder(base, sides);
  it("each side's additions after the common part; two sides adding at the same place: smallest key first, in any order of the sides", () => {
    expect(w(["a"], ["a", "x"], ["a", "y"])).toEqual(["a", "x", "y"]);
    expect(w(["a"], ["a", "y"], ["a", "x"])).toEqual(["a", "x", "y"]);
  });
  it("a side's own order of its additions is kept (a stroke drawn later stays on top)", () => {
    expect(w([], ["z", "b"], ["m"])).toEqual(["m", "z", "b"]);
    expect(w([], ["m"], ["z", "b"])).toEqual(["m", "z", "b"]);
  });
  it("an insertion in the middle stays where that side put it", () => {
    expect(w(["a", "c"], ["a", "b", "c"], ["a", "c", "d"])).toEqual(["a", "b", "c", "d"]);
  });
  it("two sides that order the same two keys differently: the side that changed the base's order wins, in either order", () => {
    expect(w(["a", "b"], ["a", "b"], ["b", "a"])).toEqual(["b", "a"]);
    expect(w(["a", "b"], ["b", "a"], ["a", "b"])).toEqual(["b", "a"]);
    expect(w(["a", "b", "c"], ["a", "b", "c", "d"], ["b", "a", "c"])).toEqual(["b", "a", "c", "d"]);
  });
  it("only kept keys, each once", () => {
    expect(weaveOrder(["a", "b"], [["a", "b", "b"], ["b", "c"]], new Set(["b", "c"]))).toEqual(["b", "c"]);
  });
  it("review counterexample: base [a, b]; A [b, x]; B [y, b]; C [] — one answer for the set, whatever the order of the sides", () => {
    const sides = [["b", "x"], ["y", "b"], []];
    const answers = new Set([[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
      .map((order) => JSON.stringify(weaveOrder(["a", "b"], order.map((n) => sides[n]!), new Set(["x", "y"])))));
    expect([...answers]).toEqual([JSON.stringify(["y", "x"])]);
  });
});

describe("review counterexamples (PR #1783): the merge of a set of heads does not depend on their order", () => {
  const all = (base: string, heads: string[]) => {
    const perms = (xs: string[]): string[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
    return new Set(perms(heads).map((order) => mergeInkHeads(base, order).value));
  };
  it("pages: A draws on pz, B adds pa at the end, C deletes pz — one page order", () => {
    const base = enc(book([], { pz: [] }, ["page", "pz"]));
    const a = enc(book([], { pz: [stroke("x")] }, ["page", "pz"]));
    const b = enc(book([], { pz: [], pa: [] }, ["page", "pz", "pa"]));
    const c = enc(book([], {}, ["page"]));
    const values = all(base, [a, b, c]);
    expect(values.size).toBe(1);
    const doc = note([...values][0]!);
    expect(doc.morePages?.order).toEqual(["page", "pz", "pa"]);
    expect(doc.morePages?.pages.pz?.doc.strokes.map((s) => s.id)).toEqual(["x"]);
  });
  it("pages, base without `order`: the page that comes back is listed the same way for every order of the heads", () => {
    const base = enc(page([], { morePages: { version: 1, pages: { pz: record("pz", page([])) } } }));
    const a = enc(page([], { morePages: { version: 1, pages: { pz: record("pz", page([stroke("x")])) } } }));
    const b = enc(book([], { pz: [], pa: [] }, ["page", "pz", "pa"]));
    const c = enc(page([], { morePages: { version: 1, pages: {} } }));
    expect(all(base, [a, b, c]).size).toBe(1);
  });
  it("strokes: base [x, h]; A deletes h; B changes h; C adds b — b lands in one place", () => {
    const base = enc(page([stroke("x"), stroke("h")]));
    const a = enc(page([stroke("x")]));
    const b = enc(page([stroke("x"), stroke("h", 3)]));
    const c = enc(page([stroke("x"), stroke("h"), stroke("b")]));
    const values = all(base, [a, b, c]);
    expect(values.size).toBe(1);
    expect(strokeIds([...values][0]!)).toEqual(["x", "h", "b"]);
  });
  it("two heads through mergeInk are the same function: either role, the same bytes", () => {
    const base = enc(page([stroke("x"), stroke("h")]));
    const a = enc(page([stroke("x")])), b = enc(page([stroke("x"), stroke("h", 3), stroke("b")]));
    expect(mergeInk(base, a, b)).toEqual(mergeInk(base, b, a));
    expect(mergeInk(base, a, b)).toEqual(mergeInkHeads(base, [a, b]));
  });
});

describe("an empty drawing (\"\") as one of the values", () => {
  // Who can send "": no app path does — saveInk always sends an encoded drawing, and the inbox's Revert sends the
  // reverted drawing. "" reaches the merge only as what is stored (an attribute set to "" without a base, e.g. through
  // the generic attribute route) or as `base` (the note had no drawing yet).
  const x = enc(page([stroke("s")]));
  it("base X, stored \"\" (cleared since), incoming X (this writer changed nothing): the clear stands — \"\"", () => {
    expect(mergeInk(x, "", x).value).toBe("");
  });
  it("base \"\", stored X, incoming \"\" (made from nothing, changed nothing): X", () => {
    expect(mergeInk("", x, "").value).toBe(x);
  });
  it("cleared on one side, a stroke added on the other: the new stroke stays, the old one goes", () => {
    const added = enc(page([stroke("s"), stroke("t")]));
    for (const value of [mergeInk(x, "", added).value, mergeInk(x, added, "").value]) expect(strokeIds(value)).toEqual(["t"]);
  });
});

describe("drawings stored before this change", () => {
  // The old merge wrote incoming's strokes first, then the stored side's additions: a stored page's stroke order is
  // whatever that was (here not sorted by id), and it is the paint order the person sees.
  const stored = page([stroke("s9"), stroke("s1"), stroke("s5")]);

  it("an unchanged drawing saved again comes back byte for byte (no history point, no upload)", () => {
    const raw = enc(stored);
    expect(mergeInk(raw, raw, raw).value).toBe(raw);
    expect(mergeInk(null, raw, raw).value).toBe(raw);
  });

  it("a save made from it while nothing else changed is kept exactly as sent", () => {
    const raw = enc(stored), next = enc(page([...stored.strokes, stroke("s0")]));
    expect(mergeInk(raw, raw, next).value).toBe(next);
  });

  it("a real merge keeps every stroke and the stored order of the strokes that were there; only the two new ones are placed by id", () => {
    const raw = enc(stored);
    const left = enc(page([...stored.strokes, stroke("s7")]));
    const right = enc(page([...stored.strokes, stroke("s3")]));
    for (const value of [mergeInk(raw, left, right).value, mergeInk(raw, right, left).value]) {
      expect(strokeIds(value)).toEqual(["s9", "s1", "s5", "s3", "s7"]);
    }
  });

  it("a notebook stored with its pages in an incoming-dependent key order keeps every page and its shown order", () => {
    const old = book([stroke("f")], { pz: [stroke("z")], pa: [stroke("a")] }, ["pz", "pa"]);
    const raw = enc(old);
    const drew = enc(book([stroke("f"), stroke("g")], { pz: [stroke("z")], pa: [stroke("a")] }, ["pz", "pa"]));
    const added = enc(book([stroke("f")], { pz: [stroke("z")], pa: [stroke("a")], pn: [stroke("n")] }, ["pz", "pa", "pn"]));
    const value = mergeInk(raw, drew, added).value;
    expect(value).toBe(mergeInk(raw, added, drew).value);
    expect(allIds(value)).toEqual(["a", "f", "g", "n", "z"]);
    expect(inkPageOrder(notePages(note(value))).filter((key) => key !== "page")).toEqual(["pz", "pa", "pn"]);
  });
});

describe("a page deleted on one device while the other drew on it", () => {
  const base = enc(book([], { p1: [], p2: [stroke("x")] }));
  const deletedP2 = enc(book([], { p1: [] }, ["p1"]));
  const drewOnP2 = enc(book([], { p1: [], p2: [stroke("x"), stroke("y")] }));

  it("the page comes back with the ink, listed where it was, and the conflict is reported — in either role", () => {
    for (const [stored, incoming] of [[deletedP2, drewOnP2], [drewOnP2, deletedP2]] as const) {
      const result = mergeInk(base, stored, incoming);
      const doc = note(result.value);
      expect(doc.morePages?.pages.p2?.doc.strokes.map((s) => s.id)).toEqual(["x", "y"]);
      expect(doc.morePages?.order).toEqual(["p1", "p2"]);
      expect(result.conflicts).toEqual([{ kind: "deletedPage", pageKey: "p2" }]);
    }
    expect(mergeInk(base, deletedP2, drewOnP2).value).toBe(mergeInk(base, drewOnP2, deletedP2).value);
  });

  it("the delete wins when the deleter had already seen the other side's drawing (it is in the base)", () => {
    const seen = drewOnP2; // the deleter loaded the page with x and y on it
    const deletedAfterSeeing = enc(book([], { p1: [] }, ["p1"]));
    const drewElsewhere = enc(book([stroke("f")], { p1: [], p2: [stroke("x"), stroke("y")] }));
    for (const [stored, incoming] of [[deletedAfterSeeing, drewElsewhere], [drewElsewhere, deletedAfterSeeing]] as const) {
      const result = mergeInk(seen, stored, incoming);
      expect(note(result.value).morePages?.pages.p2).toBeUndefined();
      expect(note(result.value).morePages?.order).toEqual(["p1"]);
      expect(result.conflicts).toEqual([]);
    }
  });

  it("the inbox's Revert applies the version the merge did not keep — the delete again — in both directions", () => {
    // The server keeps both values a merge was made from (the stored one and the one sent); Revert gets both.
    for (const [stored, incoming] of [[deletedP2, drewOnP2], [drewOnP2, deletedP2]] as const) {
      const kept = mergeInk(base, stored, incoming);
      const reverted = note(revertInkConflicts(kept.value, [stored, incoming], kept.conflicts));
      expect(reverted.morePages?.pages.p2).toBeUndefined();
      expect(reverted.morePages?.order).toEqual(["p1"]);
      expect(reverted.morePages?.pages.p1).toBeDefined();
    }
  });
});

describe("app versions that still merge the old way", () => {
  // Their `order` is the same shape (a list of page keys); what differs is that their own merge (the app merges before
  // sending when the server holds strokes it does not show) keeps one side's list, so a page can be missing from it.
  const base = enc(book([], { p1: [] }));
  const newMerge = mergeInk(base, enc(book([], { p1: [], pa: [] }, ["p1", "pa"])), enc(book([], { p1: [], pb: [] }, ["p1", "pb"]))).value;

  it("an old app reading the new merged value sees the same shape, and both pages listed", () => {
    const doc = note(newMerge);
    expect(doc.morePages?.order).toEqual(["p1", "pa", "pb"]);
    expect(inkPageOrder(notePages(doc)).filter((key) => key !== "page")).toEqual(["p1", "pa", "pb"]);
  });

  it("an old app's write whose `order` lost a page: the page itself is kept and still shown (after the listed ones); a later merge keeps it", () => {
    const doc = note(newMerge);
    const oldWrite = enc({ ...doc, strokes: [stroke("o")], morePages: { ...doc.morePages!, order: ["p1", "pa"] } });
    expect(inkPageOrder(notePages(note(oldWrite)))).toEqual(expect.arrayContaining(["p1", "pa", "pb"]));
    // A new app drew on pb meanwhile; the server merges the old app's write (base = the new merged value).
    const newWrite = enc({ ...doc, morePages: { ...doc.morePages!, pages: { ...doc.morePages!.pages, pb: record("pb", page([stroke("b")])) } } });
    for (const value of [mergeInk(newMerge, newWrite, oldWrite).value, mergeInk(newMerge, oldWrite, newWrite).value]) {
      const merged = note(value);
      expect(merged.strokes.map((s) => s.id)).toEqual(["o"]);
      expect(merged.morePages?.pages.pb?.doc.strokes.map((s) => s.id)).toEqual(["b"]);
      expect(inkPageOrder(notePages(merged))).toEqual(expect.arrayContaining(["p1", "pa", "pb"]));
    }
  });
});
