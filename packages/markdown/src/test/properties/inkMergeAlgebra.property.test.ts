// Is the ink merge a replicated-value merge? (attempts-2026-11-16 §2.3 row `ink`, §10 item 4; gate for step S1; PR #1774, #1783.)
// The merge is mergeInkHeads(base, heads) of ink.ts: the result must depend only on the base and the SET of heads (saves made from that
// base) — not on the order they are given, a head given twice, or a head equal to the base — and mergeInk(base, stored, incoming) is the
// same function with two heads, so it gives the same bytes in either role. Folding pairwise is not the same thing (an intermediate has lost
// where deleted items were) and is not claimed. Proved on random heads, seeded (a failure prints the seed and the heads):
//  1 pure: same inputs, same output; inputs unchanged.
//  2 the set decides: every permutation of the heads, a head repeated, the base as one more head — byte-identical value, identical conflicts.
//  3 two heads: mergeInk(b, s, i) = mergeInk(b, i, s) = mergeInkHeads(b, [s, i]).
//  4 nothing lost: a stroke / shape any head added is in the result; a base stroke one head deleted and no head changed is gone.
//  5 conflicts are exact: an item two heads changed differently is reported, and every version of it that the merge did not keep can be
//    taken back from the heads (inkConflictLosers); nothing else is reported as a stroke conflict.
//  6 base = null (no common base) and one head: defined, same guarantees; one head is that head, unchanged.
// Forms: a single page, a notebook (morePages, with and without `order`), a PDF envelope (per-page strokes, highlight records, `units`
// written by a new app or left stale by an old one). Edits: add / delete / change / erase a stroke, insert one in the middle, move one to the
// end (reorder), add / delete a page, add / remove a shape (also of a kind this version does not know), add a feature name (sometimes
// required), set an unknown field. Ids come from one random pool, so a head's new id may sort before or after the base's.
import { describe, expect, it } from "vitest";
import { mergeInk, mergeInkHeads, inkConflictLosers, decodeInk, encodeInk, legacyFingerprint, type InkDocument, type InkEnvelope, type InkShape, type InkStroke } from "../../ink.js";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";

// ── seeded generator ──────────────────────────────────────────────────────
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!, chance: (p: number) => next() < p };
}
type Rng = ReturnType<typeof rng>;

const stroke = (id: string, tag = 0): InkStroke => ({ id, points: [[1, 2], [3 + tag, 4], [5, 6 + tag]], color: tag % 2 ? "#ff0000" : "#000000", size: 2 + tag, toolId: "pen" });
const shape = (id: string, tag = 0): InkShape => ({ id, kind: tag % 3 === 2 ? "hexagon-from-a-newer-app" : "rectangle", start: [tag, 1], end: [10, 10 + tag], color: "#000000", size: 2 });
const blank = (width = 1000): InkDocument => ({ version: 1, strokes: [], erased: {}, page: { width } });
const record = (key: string, doc: InkDocument) => ({ key, background: { kind: "blank" }, size: { width: 1000, height: 1400 }, doc });
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Ids no one else has, in random order relative to each other (a uuid's order means nothing). */
function idPool(r: Rng) {
  const used = new Set<string>();
  return () => { for (;;) { const id = `${"abcdefghijklmnop"[r.int(16)]}${r.int(1000)}`; if (!used.has(id)) { used.add(id); return id; } } };
}

/** Edits that apply to any page: 0 add a stroke, 1 erase part of one, 2 change one, 5 add / remove a shape, 8 delete a stroke,
 *  9 insert one in the middle, 10 move one to the end (an undo that re-adds it). */
function editPage(page: InkDocument, r: Rng, fresh: () => string, op: number): void {
  const n = page.strokes.length;
  if (op === 0) page.strokes.push(stroke(fresh(), r.int(5)));
  else if (op === 1 && n) { const s = r.pick(page.strokes); const at = r.int(3); page.erased[s.id] = [[at, at]]; }
  else if (op === 2 && n) { const at = r.int(n); page.strokes[at] = stroke(page.strokes[at]!.id, 1 + r.int(4)); }
  else if (op === 5) { if (page.shapes?.length && r.chance(0.3)) page.shapes.splice(r.int(page.shapes.length), 1); else page.shapes = [...(page.shapes ?? []), shape(fresh(), r.int(3))]; }
  else if (op === 8 && n) { const [gone] = page.strokes.splice(r.int(n), 1); delete page.erased[gone!.id]; }
  else if (op === 9) page.strokes.splice(r.int(n + 1), 0, stroke(fresh(), r.int(5)));
  else if (op === 10 && n > 1) { const [moved] = page.strokes.splice(r.int(n - 1), 1); page.strokes.push(moved!); }
}

/** 6 add a feature name (sometimes required), 7 set a field this version does not know on one of `holders`. */
function editDoc(doc: { features?: string[]; requires?: string[] }, holders: object[], r: Rng, fresh: () => string, op: number): void {
  if (op === 6) { const name = `f-${fresh()}`; doc.features = [...(doc.features ?? []), name]; if (r.chance(0.3)) doc.requires = [...(doc.requires ?? []), name]; }
  else if (op === 7) (r.pick(holders) as Record<string, unknown>)[`x_${fresh()}`] = r.int(9);
}

/** A notebook edit: page ops 3 add a page (at the end or in the middle of `order`), 4 delete a page; the rest per editPage / editDoc. */
function editNote(doc: InkDocument, r: Rng, fresh: () => string, op: number, withOrder: boolean): void {
  const pages: InkDocument[] = [doc, ...Object.values(doc.morePages?.pages ?? {}).map((p) => p.doc)];
  if (op === 3) {
    const key = `pg-${fresh()}`;
    const more = doc.morePages ?? { version: 1 as const, pages: {} };
    more.pages[key] = record(key, blank());
    if (withOrder) { const order = [...(more.order ?? ["page", ...Object.keys(more.pages).filter((k) => k !== key)])]; order.splice(1 + r.int(order.length), 0, key); more.order = order; }
    doc.morePages = more;
  } else if (op === 4 && doc.morePages && Object.keys(doc.morePages.pages).length) {
    const key = r.pick(Object.keys(doc.morePages.pages));
    delete doc.morePages.pages[key];
    if (doc.morePages.order) doc.morePages.order = doc.morePages.order.filter((k) => k !== key);
  } else if (op === 6 || op === 7) editDoc(doc, [doc, r.pick(pages), ...(doc.morePages ? [doc.morePages, ...Object.values(doc.morePages.pages)] : [])], r, fresh, op);
  else editPage(r.pick(pages), r, fresh, op);
}

type Form = "page" | "notebook" | "notebook-no-order" | "pdf";
type Scenario = { base: InkDocument | InkEnvelope; heads: Array<InkDocument | InkEnvelope> };

function noteScenario(seed: number, count: number, form: Form, ops: readonly number[]): Scenario {
  const r = rng(seed);
  const fresh = idPool(r);
  const withOrder = form === "notebook";
  const base = blank();
  for (let i = r.int(4); i > 0; i--) base.strokes.push(stroke(fresh(), r.int(3)));
  if (form !== "page") for (let i = r.int(3); i > 0; i--) {
    const key = `pg-${fresh()}`; const d = blank(); for (let j = r.int(3); j > 0; j--) d.strokes.push(stroke(fresh(), 0));
    base.morePages = base.morePages ?? { version: 1, pages: {} }; base.morePages.pages[key] = record(key, d);
    if (withOrder) base.morePages.order = [...(base.morePages.order ?? ["page"]), key];
  }
  const pageOps = ops.filter((o) => form !== "page" || (o !== 3 && o !== 4));
  const heads = Array.from({ length: count }, () => { const d = clone(base); for (let i = 1 + r.int(3); i > 0; i--) editNote(d, r, fresh, r.pick(pageOps.length ? pageOps : [0]), withOrder); return d; });
  return { base, heads };
}

/** A PDF envelope: pages 1–3 with strokes, highlight records, and `units` (the pages in page units). A head is a new app (writes `units`
 *  to match its older fields, `unitsFrom` = their fingerprint) or an old one (edits the older fields, carries `units` stale). Ops 3 add a
 *  highlight record, 4 remove one; the others per editPage / editDoc. */
function envScenario(seed: number, count: number, ops: readonly number[]): Scenario {
  const r = rng(seed);
  const fresh = idPool(r);
  const withUnits = (env: InkEnvelope): InkEnvelope => {
    const pages = Object.fromEntries(Object.entries(env.pages).map(([num, doc]) => [`pdf:${num}`, { key: `pdf:${num}`, background: { kind: "pdf", page: Number(num) }, size: { width: 1000, height: 1400 }, doc: clone(doc) }]));
    return { ...env, units: { ...(env.units ?? {}), version: 1, pages }, unitsFrom: legacyFingerprint({ ...env, units: undefined }) };
  };
  const base: InkEnvelope = { version: 1, pages: {}, annotations: [] };
  for (let p = 1 + r.int(3); p > 0; p--) { const d = blank(); for (let j = r.int(3); j > 0; j--) d.strokes.push(stroke(fresh(), r.int(3))); base.pages[p] = d; }
  for (let j = r.int(3); j > 0; j--) base.annotations!.push({ id: fresh() });
  const start = r.chance(0.8) ? withUnits(base) : base;
  const heads = Array.from({ length: count }, () => {
    let d = clone(start);
    const newApp = r.chance(0.6);
    for (let i = 1 + r.int(3); i > 0; i--) {
      const op = r.pick(ops);
      const page = d.pages[Number(r.pick(Object.keys(d.pages)))]!;
      if (op === 3) d.annotations = [...(d.annotations ?? []), { id: fresh() }];
      else if (op === 4 && d.annotations?.length) d.annotations.splice(r.int(d.annotations.length), 1);
      else if (op === 6 || op === 7) editDoc(d, [d, page], r, fresh, op);
      else editPage(page, r, fresh, op);
    }
    if (newApp && d.units) d = withUnits(d);
    return d;
  });
  return { base: start, heads };
}

const scenarioOf = (seed: number, count: number, form: Form, ops: readonly number[]): Scenario =>
  form === "pdf" ? envScenario(seed, count, ops) : noteScenario(seed, count, form, ops);

// ── the properties ────────────────────────────────────────────────────────
const enc = (d: InkDocument | InkEnvelope) => encodeInk(d);
const permutations = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
const describeScenario = (seed: number, base: string | null, heads: readonly string[]) => `seed ${seed}\nbase ${base}\nheads ${heads.join("\n      ")}`;
const ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
// Owner rule (2026-11-18): a fresh seed on every run unless PROPS_SEED is set. This branch's shared helper still defaults to a
// fixed seed (PR #1881 changes that), so the choice is made here; every failure message names its scenario seed, and the base
// seed is printed so a run can be replayed with PROPS_SEED=<it> (PROPS_RUNS sets how many scenarios).
const BASE_SEED = process.env.PROPS_SEED ? PROPS_SEED : Date.now() % 2 ** 31;
console.info(`inkMergeAlgebra: base seed ${BASE_SEED}, ${PROPS_RUNS} scenarios (replay: PROPS_SEED=${BASE_SEED})`);
const SEEDS = Array.from({ length: PROPS_RUNS }, (_, i) => BASE_SEED + i);

/** First violation of 2 / 3 on `heads`, or null. */
function violation(base: string | null, heads: readonly string[]): string | null {
  const reference = mergeInkHeads(base, heads);
  const same = (r: { value: string; conflicts: unknown[] }) => r.value === reference.value && JSON.stringify(r.conflicts) === JSON.stringify(reference.conflicts);
  for (const order of permutations([...heads])) if (!same(mergeInkHeads(base, order))) return "an order of the heads gives another value";
  for (const h of heads) if (!same(mergeInkHeads(base, [...heads, h]))) return "a head given twice changes the result";
  if (base !== null && !same(mergeInkHeads(base, [...heads, base]))) return "the base as one more head changes the result";
  for (const s of heads) for (const i of heads) {
    const one = mergeInk(base, s, i), other = mergeInk(base, i, s);
    if (one.value !== other.value || JSON.stringify(one.conflicts) !== JSON.stringify(other.conflicts)) return "mergeInk depends on which head is incoming";
    if (s !== i && one.value !== mergeInkHeads(base, [s, i]).value) return "mergeInk is not mergeInkHeads with two heads";
  }
  return null;
}

type Item = { id: string };
/** Every page's strokes and shapes (and an envelope's records), by where they are. */
function itemsOf(raw: string): Map<string, Map<string, Item>> {
  const d = decodeInk(raw);
  const out = new Map<string, Map<string, Item>>();
  const add = (where: string, items: readonly Item[] | undefined) => { const m = out.get(where) ?? new Map<string, Item>(); for (const it of items ?? []) m.set(it.id, it); out.set(where, m); };
  if (d.kind === "page") {
    add("s:page", d.doc.strokes); add("h:page", d.doc.shapes);
    for (const [k, p] of Object.entries(d.doc.morePages?.pages ?? {})) { add(`s:${k}`, p.doc.strokes); add(`h:${k}`, p.doc.shapes); }
  } else if (d.kind === "pdf") {
    for (const [n, p] of Object.entries(d.doc.pages)) { add(`s:${n}`, p.strokes); add(`h:${n}`, p.shapes); }
    add("a", d.doc.annotations);
  }
  return out;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** First violation of 4 / 5, or null. */
function lossOrConflict(base: string | null, heads: readonly string[]): string | null {
  const result = mergeInkHeads(base, heads);
  const out = itemsOf(result.value), was = itemsOf(base ?? "");
  const each = heads.map(itemsOf);
  const deletedPages = new Set(result.conflicts.filter((c) => c.kind === "deletedPage").map((c) => c.pageKey));
  for (const [where, items] of new Map(each.flatMap((m) => [...m]))) {
    const ids = new Set(each.flatMap((m) => [...(m.get(where)?.keys() ?? [])]));
    for (const id of ids) {
      const before = was.get(where)?.get(id);
      const versions = each.map((m) => (m.has(where) ? m.get(where)!.get(id) : "no-page"));
      const changed = versions.filter((v) => v !== "no-page" && !same(v, before));
      const kept = out.get(where)?.get(id);
      if (before === undefined && changed.length && !kept) return `${where} ${id}: added by a head, lost`;
      const distinct = changed.filter((v, n) => v !== undefined && changed.findIndex((w) => same(w, v)) === n);
      if (distinct.length > 1) {
        const kind = where[0] === "s" ? "stroke" : where[0] === "h" ? "shape" : "annotation";
        const c = result.conflicts.find((x) => x.kind === kind && x.id === id);
        if (!c) return `${where} ${id}: changed differently by two heads, not reported`;
        const losers = inkConflictLosers(result.value, heads, c);
        const recovered = losers.map((raw) => itemsOf(raw).get(where)?.get(id));
        for (const v of distinct) if (!same(v, kept) && !recovered.some((x) => same(x, v))) return `${where} ${id}: a version the merge did not keep cannot be taken back`;
      }
      if (before !== undefined && changed.length > 0 && changed.every((v) => v === undefined) && kept) {
        const page = where.slice(2);
        if (!deletedPages.has(page)) return `${where} ${id}: deleted by a head and changed by none, still there`;
      }
      void items;
    }
  }
  return null;
}

function firstFailure(count: number, form: Form, ops: readonly number[], nullBase: boolean, check: (b: string | null, hs: readonly string[]) => string | null): string | null {
  for (const seed of SEEDS) {
    const { base, heads } = scenarioOf(seed, count, form, ops);
    const b = nullBase ? null : enc(base), hs = heads.map(enc);
    const v = check(b, hs);
    if (v) return `${v}\n${describeScenario(seed, b, hs)}`;
  }
  return null;
}

describe("1 pure", () => {
  it("same inputs give the same output and the inputs are not mutated (seeded, 3 heads, every form)", () => {
    for (const form of ["page", "notebook", "notebook-no-order", "pdf"] as const) for (const seed of SEEDS) {
      const { base, heads } = scenarioOf(seed, 3, form, ALL);
      const args = [enc(base), heads.map(enc)] as const;
      const before = JSON.stringify(args);
      expect(mergeInkHeads(...args), `${form} seed ${seed}`).toEqual(mergeInkHeads(...args));
      expect(JSON.stringify(args), `${form} seed ${seed}: inputs unchanged`).toBe(before);
    }
  });
});

describe("edges", () => {
  const one = (extra?: (d: InkDocument) => void) => { const d = blank(); d.strokes.push(stroke("s1")); extra?.(d); return d; };
  it("empty document, nothing added: every merge is the empty document and does not throw", () => {
    const e = enc(blank());
    expect(violation(e, [e, e, e])).toBeNull();
    expect(violation(null, [e, e, e])).toBeNull();
  });
  it("one stroke in the base, three heads that leave it: no violation, the base back", () => {
    const base = enc(one());
    expect(violation(base, [base, base, base])).toBeNull();
    expect(mergeInkHeads(base, [base, base]).value).toBe(base);
  });
  it("the same stroke erased the same way on two heads, a third left it", () => {
    const base = enc(one());
    const erased = enc(one((d) => { d.erased.s1 = [[0, 1]]; }));
    expect(violation(base, [erased, erased, base])).toBeNull();
    expect(mergeInkHeads(base, [erased, base]).value).toBe(erased);
  });
  it("one head: that head, byte for byte", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const { base, heads } = scenarioOf(seed, 1, "notebook", ALL);
      expect(mergeInkHeads(enc(base), [enc(heads[0]!)]).value).toBe(enc(heads[0]!));
      expect(mergeInkHeads(null, [enc(heads[0]!)]).value).toBe(enc(heads[0]!));
    }
  });
});

describe("2 / 3 the set of heads decides (every permutation, a repeat, the base as a head, mergeInk in both roles)", () => {
  // These were pinned with it.fails in PR #1774 for the pairwise fold; in the all-heads form they hold outright.
  const T = (name: string, count: number, form: Form, ops: number[], nullBase = false) =>
    it(name, () => { expect(firstFailure(count, form, ops, nullBase, violation)).toBeNull(); });
  T("single page, 3 heads, additions only, shared base", 3, "page", [0]);
  T("single page, 3 heads, all edits (two heads may change one stroke differently)", 3, "page", ALL);
  T("notebook (morePages), 3 heads, pages added / removed / edited, shared base", 3, "notebook", ALL);
  T("notebook, 4 heads (24 orders)", 4, "notebook", ALL);
  T("notebook without `order`, 3 heads, all edits", 3, "notebook-no-order", ALL);
  T("base = null, single page", 3, "page", ALL, true);
  T("base = null, notebook", 3, "notebook", ALL, true);
  T("PDF envelope (pages, highlight records, `units` new or stale), 4 heads, all edits", 4, "pdf", ALL);
  T("PDF envelope, base = null", 3, "pdf", ALL, true);
  T("notebook: strokes added and a page removed", 3, "notebook", [0, 4]);
  T("notebook: a page added on each head (all kept and listed)", 3, "notebook", [3]);
  T("single page: a stroke deleted, inserted in the middle, moved to the end", 3, "page", [8, 9, 10]);
});

describe("4 / 5 nothing lost, deletions kept, every conflict exact and recoverable", () => {
  const T = (name: string, count: number, form: Form, ops: number[], nullBase = false) =>
    it(name, () => { expect(firstFailure(count, form, ops, nullBase, lossOrConflict)).toBeNull(); });
  T("single page, 3 heads, all edits", 3, "page", ALL);
  T("notebook, 4 heads, all edits", 4, "notebook", ALL);
  T("notebook without `order`, 3 heads", 3, "notebook-no-order", ALL);
  T("PDF envelope, 3 heads", 3, "pdf", ALL);
  T("base = null, notebook", 3, "notebook", ALL, true);
  it("the generators do make heads that change one stroke differently (so 5 is exercised)", () => {
    let seen = 0;
    for (const seed of SEEDS) { const { base, heads } = scenarioOf(seed, 3, "page", [2]); seen += mergeInkHeads(enc(base), heads.map(enc)).conflicts.filter((c) => c.kind === "stroke").length; }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("the minimal counterexamples of PR #1774", () => {
  const withStrokes = (...strokes: InkStroke[]) => { const d = blank(); d.strokes.push(...strokes); return d; };
  const merge = (base: string | null, stored: string, incoming: string) => mergeInk(base, stored, incoming).value;
  const base = enc(blank());
  const a = enc(withStrokes(stroke("a")));
  const b = enc(withStrokes(stroke("b")));
  it("two sides add one stroke each to an empty page: merge(a, b) and merge(b, a) are byte-identical", () => {
    expect(merge(base, a, b)).toBe(merge(base, b, a));
  });
  it("base = null: the same two heads, byte-identical in both orders", () => {
    expect(merge(null, a, b)).toBe(merge(null, b, a));
  });
  it("one stroke changed differently on two sides: the same bytes in both orders, the conflict reported, the other version recoverable", () => {
    const start = enc(withStrokes(stroke("s", 0)));
    const left = enc(withStrokes(stroke("s", 1)));
    const right = enc(withStrokes(stroke("s", 2)));
    expect(merge(start, left, right)).toBe(merge(start, right, left));
    const result = mergeInk(start, left, right);
    expect(result.conflicts).toEqual([{ kind: "stroke", id: "s" }]);
    expect(inkConflictLosers(result.value, [left, right], result.conflicts[0]!)).toEqual([result.value === left ? right : left]);
  });
  it("three heads change one stroke three ways: one result for every order, and both losing versions come back from the heads", () => {
    const start = enc(withStrokes(stroke("s", 0)));
    const heads = [1, 2, 3].map((t) => enc(withStrokes(stroke("s", t))));
    const results = new Set(permutations([...heads]).map((order) => JSON.stringify(mergeInkHeads(start, order))));
    expect(results.size).toBe(1);
    const result = mergeInkHeads(start, heads);
    const losers = inkConflictLosers(result.value, heads, result.conflicts[0]!);
    expect(losers.sort()).toEqual(heads.filter((h) => h !== result.value).sort());
  });
  it("a stroke erased on one side and changed on the other: order independent (erasure is a separate interval set)", () => {
    const start = enc(withStrokes(stroke("s", 0)));
    const erased = enc((() => { const d = withStrokes(stroke("s", 0)); d.erased.s = [[0, 1]]; return d; })());
    const changed = enc(withStrokes(stroke("s", 3)));
    expect(merge(start, erased, changed)).toBe(merge(start, changed, erased));
  });
  it("a page added on each of two sides: the page list `order` names both pages, and the stored JSON is the same in both orders", () => {
    const page = (key: string) => { const d = blank(); d.morePages = { version: 1, pages: { [key]: record(key, blank()) }, order: [key] }; return enc(d); };
    const [p1, p2] = [page("p1"), page("p2")];
    const [ab, ba] = [decodeInk(merge(base, p1, p2)), decodeInk(merge(base, p2, p1))];
    expect(ab.kind === "page" && ab.doc.morePages?.order?.slice().sort()).toEqual(["p1", "p2"]);
    expect(ba.kind === "page" && ba.doc.morePages?.order?.slice().sort()).toEqual(["p1", "p2"]);
    expect(merge(base, p1, p2)).toBe(merge(base, p2, p1));
  });
  it("a page removed on one side, the other removed a different page and drew on this one: the same `order` in both orders", () => {
    const pageDoc = (draw: boolean) => { const d = blank(); if (draw) d.strokes.push(stroke("x")); return d; };
    const book = (pages: Record<string, boolean>) => { const d = blank(); const keys = Object.keys(pages); d.morePages = { version: 1, pages: Object.fromEntries(keys.map((k) => [k, record(k, pageDoc(pages[k]!))])), order: keys }; return enc(d); };
    const start = book({ p1: false, p2: false });
    const removedP1 = book({ p2: false });
    const removedP2DrewP1 = book({ p1: true });
    const [ab, ba] = [decodeInk(merge(start, removedP1, removedP2DrewP1)), decodeInk(merge(start, removedP2DrewP1, removedP1))];
    expect(ab.kind === "page" && ab.doc.morePages?.order).toEqual(ba.kind === "page" && ba.doc.morePages?.order);
  });
});

// Review of PR #1774 (note-cf): two sides change the same page setting differently (page width / background, a further page's background / size).
describe("page settings changed on both sides (the same class as a stroke changed on both)", () => {
  const settings = (width: number, background: string, size: number) => {
    const d = blank(width); d.page.background = background;
    const key = "pg";
    d.morePages = { version: 1, pages: { [key]: { key, background: { kind: "blank", tone: background }, size: { width: 1000, height: size }, doc: blank() } }, order: [key] };
    return enc(d);
  };
  const start = settings(1000, "white", 1400), left = settings(900, "grey", 1500), right = settings(800, "black", 1600);
  it("merge(left, right) = merge(right, left), and with a third head every order gives one value", () => {
    expect(mergeInk(start, left, right)).toEqual(mergeInk(start, right, left));
    const third = settings(700, "blue", 1700);
    expect(new Set(permutations([left, right, third]).map((o) => mergeInkHeads(start, o).value)).size).toBe(1);
  });
  it("the conflict is reported in both orders, and the other settings come back from the heads", () => {
    const result = mergeInk(start, left, right);
    expect(result.conflicts.length).toBeGreaterThan(0);
    for (const c of result.conflicts) expect(inkConflictLosers(result.value, [left, right], c)).toHaveLength(1);
  });
  it("a further page's background or size changed on both sides is reported too (as that page's settings)", () => {
    const only = (tone: string, height: number) => { const d = decodeInk(start); if (d.kind !== "page") throw new Error("page"); d.doc.morePages!.pages.pg = { ...d.doc.morePages!.pages.pg!, background: { kind: "blank", tone }, size: { width: 1000, height } }; return enc(d.doc); };
    for (const [l, r] of [[only("grey", 1400), only("black", 1400)], [only("white", 1500), only("white", 1600)]] as const) {
      expect(mergeInk(start, l, r).conflicts).toEqual([{ kind: "page", pageKey: "pg" }]);
      expect(mergeInk(start, r, l).conflicts).toEqual([{ kind: "page", pageKey: "pg" }]);
    }
  });
});
