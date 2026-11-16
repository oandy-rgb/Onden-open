// Is the ink merge usable as a replicated-value merge for three or more heads? (attempts-2026-11-16 §2.3 row `ink`, §10 item 4; gate for step S1.)
// "Merge" here is mergeInk(base, stored, incoming) of ink.ts; N heads made from one base are folded as merge(base, acc, head).
// Proved on random heads (add stroke, erase, change a stroke, add page, remove page), seeded; a failure prints the seed and the heads.
//  1 pure: same inputs, same output; inputs unchanged.
//  2 order independence: EVERY permutation, every grouping ((a+b)+c vs a+(b+c)), a head twice, a head equal to the base: byte-identical.
//  3 base = null (no common base): does not throw, and satisfies 2.
//  4 both a single page (mergeNote through mergeInk) and the whole notebook (morePages: added / removed / edited on both sides).
// The properties that FAIL today are pinned with `it.fails` (the suite stays green; when the merge is fixed they go red and the marker is deleted).
// Each pinned one has a minimal counterexample test next to it.
import { describe, expect, it } from "vitest";
import { mergeInk, decodeInk, encodeInk, type InkDocument, type InkStroke } from "../../ink.js";
import { PROPS_SEED } from "../helpers/propsConfig.js";

// ── seeded generator ──────────────────────────────────────────────────────
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!, chance: (p: number) => next() < p };
}
type Rng = ReturnType<typeof rng>;

const stroke = (id: string, tag = 0): InkStroke => ({ id, points: [[1, 2], [3 + tag, 4], [5, 6 + tag]], color: tag % 2 ? "#ff0000" : "#000000", size: 2 + tag, toolId: "pen" });
const blank = (width = 1000): InkDocument => ({ version: 1, strokes: [], erased: {}, page: { width } });
const record = (key: string, doc: InkDocument) => ({ key, background: { kind: "blank" }, size: { width: 1000, height: 1400 }, doc });
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Edit `doc` in place: add a stroke, erase part of one, change one, add a page, remove a page. `fresh` hands out ids no other head uses. */
function edit(doc: InkDocument, r: Rng, fresh: () => string, op: number): void {
  const pages: InkDocument[] = [doc, ...Object.values(doc.morePages?.pages ?? {}).map((p) => p.doc)];
  const page = r.pick(pages);
  if (op === 0) page.strokes.push(stroke(fresh(), r.int(5)));
  else if (op === 1 && page.strokes.length) { const s = r.pick(page.strokes); const at = r.int(3); page.erased[s.id] = [[at, at]]; }
  else if (op === 2 && page.strokes.length) { const at = r.int(page.strokes.length); page.strokes[at] = stroke(page.strokes[at]!.id, 1 + r.int(4)); }
  else if (op === 3) { const key = `pg-${fresh()}`; const more = doc.morePages ?? { version: 1 as const, pages: {} }; more.pages[key] = record(key, blank()); more.order = [...(more.order ?? []), key]; doc.morePages = more; }
  else if (op === 4 && doc.morePages && Object.keys(doc.morePages.pages).length) { const key = r.pick(Object.keys(doc.morePages.pages)); delete doc.morePages.pages[key]; doc.morePages.order = doc.morePages.order?.filter((k) => k !== key); }
}

function makeBase(r: Rng, multi: boolean): InkDocument {
  const doc = blank();
  let n = 0; const fresh = () => `b${n++}`;
  for (let i = r.int(4); i > 0; i--) doc.strokes.push(stroke(fresh(), r.int(3)));
  if (multi) for (let i = r.int(3); i > 0; i--) { const key = `pg-${fresh()}`; const d = blank(); for (let j = r.int(3); j > 0; j--) d.strokes.push(stroke(fresh(), 0)); doc.morePages = doc.morePages ?? { version: 1, pages: {} }; doc.morePages.pages[key] = record(key, d); doc.morePages.order = [...(doc.morePages.order ?? []), key]; }
  return doc;
}

type Scenario = { base: InkDocument; heads: InkDocument[] };
/** `count` heads from one base. `ops` limits the edits (conflict-free sets use disjoint ones in the tests below). */
function scenario(seed: number, count: number, multi: boolean, ops: readonly number[] = [0, 1, 2, 3, 4]): Scenario {
  const r = rng(seed);
  const base = makeBase(r, multi);
  let n = 0; const fresh = () => `h${n++}`; // one counter for all heads: no two heads invent the same id
  const heads = Array.from({ length: count }, () => { const d = clone(base); for (let i = 1 + r.int(3); i > 0; i--) edit(d, r, fresh, r.pick(ops)); return d; });
  return { base, heads };
}

// ── the merge as a replicated-value merge ─────────────────────────────────
const enc = (d: InkDocument) => encodeInk(d);
const merge = (base: string | null, stored: string, incoming: string) => mergeInk(base, stored, incoming).value;
const fold = (base: string | null, heads: readonly string[]) => heads.slice(1).reduce((acc, h) => merge(base, acc, h), heads[0]!);
const permutations = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
const describeScenario = (seed: number, base: string | null, heads: readonly string[]) => `seed ${seed}\nbase ${base}\nheads ${heads.join("\n      ")}`;

/** The value as canonical JSON: object keys sorted, every list of strokes / shapes (and the page order) sorted by id: "the same drawing, whatever order the arrays and keys came out in". Used only by the second tier. */
function sameSetOfThings(raw: string): string {
  const byId = (a: unknown, b: unknown) => ((a as { id: string }).id < (b as { id: string }).id ? -1 : 1);
  const canon = (v: unknown, key = ""): unknown => {
    if (Array.isArray(v)) { const items = v.map((x) => canon(x)); return key === "strokes" || key === "shapes" ? items.sort(byId) : key === "order" ? items.sort() : items; }
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k], k)]));
    return v;
  };
  return JSON.stringify(canon(JSON.parse(raw)));
}

/** First violation of the algebra on `heads`, or null. `base` may be null (no common base). `same` decides when two results are "the same value": byte for byte, or up to the order of the arrays. */
function violation(base: string | null, heads: readonly string[], same: (a: string, b: string) => boolean = (a, b) => a === b): string | null {
  const reference = fold(base, heads);
  for (const order of permutations([...heads])) if (!same(fold(base, order), reference)) return "an order of the heads gives another value";
  for (const h of heads) {
    if (!same(fold(base, [...heads, h, h]), reference)) return "a head merged twice changes the result";
    if (!same(merge(base, h, h), h)) return "a head merged with itself is not itself";
  }
  if (base !== null && !same(fold(base, [...heads, base]), reference)) return "a head equal to the base changes the result";
  if (heads.length >= 3) {
    const [a, b, c] = heads as [string, string, string];
    if (!same(merge(base, merge(base, a, b), c), merge(base, a, merge(base, b, c)))) return "grouping (a+b)+c differs from a+(b+c)";
  }
  return null;
}
const sameUpToOrder = (a: string, b: string) => sameSetOfThings(a) === sameSetOfThings(b);

const SEEDS = Array.from({ length: 40 }, (_, i) => PROPS_SEED + i);
function firstFailure(count: number, multi: boolean, ops: readonly number[], nullBase = false, same?: (a: string, b: string) => boolean): string | null {
  for (const seed of SEEDS) {
    const { base, heads } = scenario(seed, count, multi, ops);
    const [b, hs] = [nullBase ? null : enc(base), heads.map(enc)];
    const v = violation(b, hs, same);
    if (v) return `${v}\n${describeScenario(seed, b, hs)}`;
  }
  return null;
}

describe("1 pure", () => {
  it("same inputs give the same output and the inputs are not mutated (seeded, 3 heads)", () => {
    for (const seed of SEEDS) {
      const { base, heads } = scenario(seed, 3, true);
      const args = [enc(base), enc(heads[0]!), enc(heads[1]!)] as const;
      const before = JSON.stringify(args);
      const one = mergeInk(...args), two = mergeInk(...args);
      expect(one, `seed ${seed}`).toEqual(two);
      expect(JSON.stringify(args), `seed ${seed}: inputs unchanged`).toBe(before);
    }
  });
});

// Edge documents: empty, one stroke, one stroke erased on two sides, erased on one and changed on the other.
describe("edges", () => {
  const one = (extra?: (d: InkDocument) => void) => { const d = blank(); d.strokes.push(stroke("s1")); extra?.(d); return d; };
  it("empty document, nothing added: every merge is the empty document and does not throw", () => {
    const e = enc(blank());
    expect(violation(e, [e, e, e])).toBeNull();
    expect(violation(null, [e, e, e])).toBeNull();
  });
  it("one stroke in the base, three heads that leave it: no violation", () => {
    const base = enc(one());
    expect(violation(base, [base, base, base])).toBeNull();
  });
  it("the same stroke erased the same way on two sides, a third left it", () => {
    const base = enc(one());
    const erased = enc(one((d) => { d.erased.s1 = [[0, 1]]; }));
    expect(violation(base, [erased, erased, base])).toBeNull();
  });
  it("base = null: three heads, no throw (value defined)", () => {
    const { heads } = scenario(1, 3, true);
    expect(() => fold(null, heads.map(enc))).not.toThrow();
  });
});

describe("2/3/4 the algebra on random heads (every permutation, grouping, repeat, base head; 3 heads = 6 orders, 4 heads = 24)", () => {
  // Heads that touch DISJOINT things (add stroke, add page only): the easiest case. Byte order of the strokes is part of "byte-identical".
  it.fails("single page, 3 heads, additions only, shared base [pinned: stroke order follows which side is `incoming`]", () => {
    expect(firstFailure(3, false, [0])).toBeNull();
  });
  it.fails("single page, 3 heads, all edits [pinned: same reason, plus a stroke changed on two sides is decided by `incoming`]", () => {
    expect(firstFailure(3, false, [0, 1, 2])).toBeNull();
  });
  it.fails("notebook (morePages), 3 heads, page added / removed / edited, shared base [pinned: same reason]", () => {
    expect(firstFailure(3, true, [0, 1, 2, 3, 4])).toBeNull();
  });
  it.fails("notebook, 4 heads (24 orders) [pinned: same reason]", () => {
    expect(firstFailure(4, true, [0, 1, 2, 3, 4])).toBeNull();
  });
  it.fails("base = null, single page [pinned: same reason]", () => {
    expect(firstFailure(3, false, [0, 1, 2], true)).toBeNull();
  });
  it.fails("base = null, notebook [pinned: same reason]", () => {
    expect(firstFailure(3, true, [0, 1, 2, 3, 4], true)).toBeNull();
  });
});

// Second tier: the same properties, results compared up to the ORDER of the stroke arrays. Split by the kind of edit, to see which kinds are only a matter of order.
describe("2/3/4 up to the order of the arrays, by kind of edit", () => {
  const T = (name: string, count: number, multi: boolean, ops: number[], nullBase = false) =>
    it(name, () => { expect(firstFailure(count, multi, ops, nullBase, sameUpToOrder)).toBeNull(); });
  T("single page: strokes added and erased", 3, false, [0, 1]);
  T("single page: strokes added and erased, base = null", 3, false, [0, 1], true);
  T("notebook: strokes added and erased on any page (no page added or removed)", 3, true, [0, 1]);
  T("notebook: strokes added, erased and changed on any page, base = null", 3, true, [0, 1], true);
  T("notebook: a page removed on one side, the rest untouched", 3, true, [4]);
});

describe("2/3/4 up to the order of the arrays: what still fails [pinned]", () => {
  const T = (name: string, count: number, multi: boolean, ops: number[], nullBase = false) =>
    it.fails(name, () => { expect(firstFailure(count, multi, ops, nullBase, sameUpToOrder)).toBeNull(); });
  T("single page: a stroke changed (two heads may change the same stroke: `incoming` wins)", 3, false, [0, 1, 2]);
  T("notebook: strokes added and a page removed (same `order` reason: a page one side removed and another drew on stays, but `order` is incoming's)", 3, true, [0, 4]);
  T("notebook: a page added (two heads each add one: `order` is one value, so the other's page is missing from it)", 3, true, [3]);
  T("notebook: all edits", 3, true, [0, 1, 2, 3, 4]);
  T("notebook: all edits, base = null", 3, true, [0, 1, 2, 3, 4], true);
});

describe("minimal counterexamples (each pinned with it.fails; delete the marker when the merge is fixed)", () => {
  const withStrokes = (...strokes: InkStroke[]) => { const d = blank(); d.strokes.push(...strokes); return d; };
  const base = enc(blank());
  const a = enc(withStrokes(stroke("a")));
  const b = enc(withStrokes(stroke("b")));
  it.fails("two sides add one stroke each to an empty page: merge(a, b) and merge(b, a) are not byte-identical (stroke order follows `incoming`)", () => {
    expect(merge(base, a, b)).toBe(merge(base, b, a));
  });
  it("...but they are the same set of strokes (only the order differs)", () => {
    expect(sameUpToOrder(merge(base, a, b), merge(base, b, a))).toBe(true);
  });
  it.fails("base = null: the same two heads, still order dependent", () => {
    expect(merge(null, a, b)).toBe(merge(null, b, a));
  });
  it.fails("one stroke changed differently on two sides: the result is whichever side is `incoming` (the conflict is reported, not resolved the same way)", () => {
    const start = enc(withStrokes(stroke("s", 0)));
    const left = enc(withStrokes(stroke("s", 1)));
    const right = enc(withStrokes(stroke("s", 2)));
    expect(merge(start, left, right)).toBe(merge(start, right, left));
  });
  it("a stroke erased on one side and changed on the other: order independent (erasure is a separate interval set)", () => {
    const start = enc(withStrokes(stroke("s", 0)));
    const erased = enc((() => { const d = withStrokes(stroke("s", 0)); d.erased.s = [[0, 1]]; return d; })());
    const changed = enc(withStrokes(stroke("s", 3)));
    expect(merge(start, erased, changed)).toBe(merge(start, changed, erased));
  });
  it.fails("a page added on each of two sides: the page list `order` keeps only `incoming`'s page, and the pages' key order in the stored JSON follows `incoming` too", () => {
    const page = (key: string) => { const d = blank(); d.morePages = { version: 1, pages: { [key]: record(key, blank()) }, order: [key] }; return enc(d); };
    const [p1, p2] = [page("p1"), page("p2")];
    const [ab, ba] = [decodeInk(merge(base, p1, p2)), decodeInk(merge(base, p2, p1))];
    expect(ab.kind === "page" && ab.doc.morePages?.order?.slice().sort()).toEqual(["p1", "p2"]); // the list should name both pages
    expect(ba.kind === "page" && ba.doc.morePages?.order?.slice().sort()).toEqual(["p1", "p2"]);
  });
  it.fails("a page removed on one side, the other removed a different page and drew on this one: `order` is incoming's, so it names no page or the wrong one", () => {
    const pageDoc = (draw: boolean) => { const d = blank(); if (draw) d.strokes.push(stroke("x")); return d; };
    const book = (pages: Record<string, boolean>) => { const d = blank(); const keys = Object.keys(pages); d.morePages = { version: 1, pages: Object.fromEntries(keys.map((k) => [k, record(k, pageDoc(pages[k]!))])), order: keys }; return enc(d); };
    const start = book({ p1: false, p2: false });
    const removedP1 = book({ p2: false });
    const removedP2DrewP1 = book({ p1: true });
    const [ab, ba] = [decodeInk(merge(start, removedP1, removedP2DrewP1)), decodeInk(merge(start, removedP2DrewP1, removedP1))];
    expect(ab.kind === "page" && ab.doc.morePages?.order).toEqual(ba.kind === "page" && ba.doc.morePages?.order);
  });
  it("the same stroke erased the same way on two sides: order independent", () => {
    const start = enc(withStrokes(stroke("s", 0)));
    const erased = enc((() => { const d = withStrokes(stroke("s", 0)); d.erased.s = [[0, 1]]; return d; })());
    expect(merge(start, erased, erased)).toBe(merge(start, erased, erased));
    expect(violation(start, [erased, erased, start])).toBeNull();
  });
});

// Review of PR #1774 (note-cf): the replicated-value table does not merge in arrival order. It sorts the heads by their marker into one fixed total order and folds
// them with the same function on every node, so what the merge must give is: for a given order of heads, a determined result, conflicts reported.
// Here the fixed order is a stand-in (the heads' own bytes, deduplicated); the real one is (time, counter, origin). The properties: any arrival order, any repeat,
// base = null: the same bytes and the same conflicts; nothing throws; no stroke any head added is lost.
describe("heads sorted into one fixed order, then folded (the form the replicated-value table uses)", () => {
  const sortedFold = (base: string | null, heads: readonly string[]) => {
    const order = [...new Set(heads)].sort();
    const conflicts: unknown[] = [];
    const value = order.slice(1).reduce((acc, h) => { const r = mergeInk(base, acc, h); conflicts.push(...r.conflicts); return r.value; }, order[0]!);
    return { value, conflicts: JSON.stringify(conflicts) };
  };
  const idsOf = (raw: string) => { const d = decodeInk(raw); return d.kind === "page" ? [...d.doc.strokes.map((s) => s.id), ...Object.values(d.doc.morePages?.pages ?? {}).flatMap((p) => p.doc.strokes.map((s) => s.id))] : []; };
  const check = (count: number, multi: boolean, ops: readonly number[], nullBase: boolean) => {
    for (const seed of SEEDS) {
      const { base, heads } = scenario(seed, count, multi, ops);
      const b = nullBase ? null : enc(base), hs = heads.map(enc);
      const reference = sortedFold(b, hs);
      for (const order of permutations([...hs])) {
        const got = sortedFold(b, [...order, order[0]!]); // a repeat of a head too
        expect(got.value, `seed ${seed}: arrival order`).toBe(reference.value);
        expect(got.conflicts, `seed ${seed}: conflicts`).toBe(reference.conflicts);
      }
      if (ops.every((o) => o !== 4)) { // pages removed may drop strokes by design; strokes only ever added are kept
        const kept = new Set(idsOf(reference.value));
        for (const h of hs) for (const id of idsOf(h)) expect(kept.has(id), `seed ${seed}: stroke ${id} lost`).toBe(true);
      }
    }
  };
  it("single page, all edits (add, erase, change): same bytes and conflicts for every arrival order", () => check(3, false, [0, 1, 2], false));
  it("notebook, all edits except page removal", () => check(3, true, [0, 1, 2, 3], false));
  it("notebook, all edits including page removal (no stroke-loss check)", () => check(4, true, [0, 1, 2, 3, 4], false));
  it("base = null", () => { check(3, false, [0, 1, 2], true); check(3, true, [0, 1, 2, 3, 4], true); });
});

// Review (note-cf): two sides change the same page setting differently (page width / background, a further page's background / size). Same class as the changed-stroke counterexample.
describe("page settings changed on both sides (the same class as a stroke changed on both)", () => {
  const settings = (width: number, background: string, size: number) => {
    const d = blank(width); d.page.background = background;
    const key = "pg";
    d.morePages = { version: 1, pages: { [key]: { key, background: { kind: "blank", tone: background }, size: { width: 1000, height: size }, doc: blank() } }, order: [key] };
    return enc(d);
  };
  const start = settings(1000, "white", 1400), left = settings(900, "grey", 1500), right = settings(800, "black", 1600);
  it.fails("merge(left, right) and merge(right, left) differ: the side that is `incoming` wins [pinned: reviewer says this belongs to the sorted-fold form below]", () => {
    expect(merge(start, left, right)).toBe(merge(start, right, left));
  });
  it("the conflict is reported in both orders", () => {
    expect(mergeInk(start, left, right).conflicts.length).toBeGreaterThan(0);
    expect(mergeInk(start, right, left).conflicts.length).toBeGreaterThan(0);
  });
  it("given the heads in one fixed order, the result is determined and the same however they arrived", () => {
    const sorted = [left, right, start].sort();
    const once = fold(start, sorted);
    expect(fold(start, [...sorted])).toBe(once);
    expect(fold(null, sorted)).toBe(fold(null, [...sorted]));
  });
});
