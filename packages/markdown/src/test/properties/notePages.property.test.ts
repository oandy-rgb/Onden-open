// Property tests for the merge of `note_pages` (notePages.ts mergeNotePages): the function the distributed merge
// core will call for this key as well (docs/architecture/proposals/pdf-pages-in-note-2026-11-16.md 2.3, attempts-2026-11-16 2.5).
// DB-free; seed and run count from PROPS_SEED / PROPS_RUNS.
//   (a) pure: the same strings give the same answer
//   (b) the same for three or more heads in any order: heads folded in a fixed order (sorted by value) give the same list whatever
//       order they arrived in; folded pairwise in ANY order they give the same pages (the set), and every device's own order is kept.
//       Exact bytes for any pairwise order do NOT hold where a base page that one device deleted stood between pages other devices
//       added, nor with no base (pinned with it.fails below): the distributed core folds heads in a fixed order, as the first test says.
//   (c) with no base: the pages of both sides are kept, none removed, `clean: false`
//   (d) never overlapping ranges, never a duplicate id (the result is a list the codec accepts)

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { parsePdfPageKey, decodeNotePages, encodeNotePages, expandNotePages, insertBlankPage, mergeNotePages, type NotePages, type PageRun } from "../../notePages.js";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };
const FILES = ["/api/media/a.pdf", "/api/media/b.pdf"];
const PAGE_COUNT = 12;

const baseArb: fc.Arbitrary<NotePages> = fc.array(fc.oneof(
  fc.constant({ kind: "blank" as const }),
  fc.record({ kind: fc.constant("pdf" as const), file: fc.constantFrom(...FILES), from: fc.integer({ min: 1, max: 3 }), to: fc.oneof(fc.integer({ min: 4, max: PAGE_COUNT }), fc.constant(null)) }),
), { maxLength: 5 }).map((raw) => ({
  version: 1 as const,
  runs: raw.map((r, i): PageRun => (r.kind === "blank" ? { id: `b${i}`, kind: "blank" } : { id: `f${i}`, kind: "pdf", file: r.file, from: r.from, to: r.to })),
}));

/** An edit a device can make: insert a blank page after a page (cutting a run), or delete a page (cutting a run). */
type Edit = { op: "insert" | "delete"; at: number };
const editArb: fc.Arbitrary<Edit> = fc.record({ op: fc.constantFrom("insert" as const, "delete" as const), at: fc.nat(40) });
const pageKeys = (pages: NotePages) => expandNotePages(pages, () => PAGE_COUNT).entries.map((e) => e.key);

/** What step 3's delete will do to the list: a page leaves, a run is cut and the second half gets a new id. */
function removePage(pages: NotePages, key: string, mint: () => string): NotePages {
  const runs: PageRun[] = [];
  for (const run of pages.runs) {
    if (run.kind === "blank") { if (run.id !== key) runs.push(run); continue; }
    const prefix = run.keyPrefix ?? run.id;
    const parsed = parsePdfPageKey(key);
    const n = parsed?.prefix === prefix ? parsed.page : -1;
    const last = run.to ?? PAGE_COUNT;
    if (n < run.from || n > last) { runs.push(run); continue; }
    if (n > run.from) runs.push({ ...run, to: n - 1 });
    if (n < last || run.to === null) runs.push({ id: mint(), kind: "pdf", file: run.file, from: n + 1, to: run.to, keyPrefix: prefix });
  }
  return { version: 1, runs };
}

function apply(base: NotePages, edits: Edit[], tag: string): NotePages {
  let n = 0;
  const mint = () => `${tag}${++n}`;
  let pages = base;
  for (const edit of edits) {
    const keys = pageKeys(pages);
    if (keys.length === 0) { pages = insertBlankPage(pages, "end", [], mint)!.pages; continue; }
    const key = keys[edit.at % keys.length]!;
    pages = edit.op === "insert" ? insertBlankPage(pages, key, [], mint)!.pages : removePage(pages, key, mint);
  }
  return pages;
}

const headsArb = (count: number) => baseArb.chain((base) => fc.tuple(fc.constant(base), fc.array(fc.array(editArb, { maxLength: 4 }), { minLength: count, maxLength: count }))
  .map(([b, all]) => ({ base: b, heads: all.map((edits, i) => apply(b, edits, `h${i}_`)) })));

const enc = encodeNotePages;
const pagesOf = (value: string): NotePages => { const r = decodeNotePages(value); if (!r.ok) throw new Error(`unreadable result: ${value}`); return r.pages; };
const permutations = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));
const fold = (base: NotePages, heads: NotePages[]) => heads.slice(1).reduce((acc, next) => mergeNotePages(enc(base), enc(next), acc.merged), { merged: enc(heads[0]!), clean: true });

describe("mergeNotePages (properties)", () => {
  it("(a) is pure: the same strings give the same answer", () => {
    fc.assert(fc.property(headsArb(2), ({ base, heads }) => {
      const first = mergeNotePages(enc(base), enc(heads[0]!), enc(heads[1]!));
      const input = [enc(base), enc(heads[0]!), enc(heads[1]!)];
      expect(mergeNotePages(input[0]!, input[1]!, input[2]!)).toEqual(first);
      expect(input).toEqual([enc(base), enc(heads[0]!), enc(heads[1]!)]);
    }), fcOpts);
  });

  it("(b) two heads: incoming and current can swap", () => {
    fc.assert(fc.property(headsArb(2), ({ base, heads }) => {
      expect(mergeNotePages(enc(base), enc(heads[0]!), enc(heads[1]!))).toEqual(mergeNotePages(enc(base), enc(heads[1]!), enc(heads[0]!)));
    }), fcOpts);
  });

  it("(b) three or four heads, folded in a fixed order (sorted by value): the same list whatever order they arrived in", () => {
    fc.assert(fc.property(fc.integer({ min: 3, max: 4 }).chain(headsArb), ({ base, heads }) => {
      const fixed = (order: NotePages[]) => fold(base, [...order].sort((x, y) => (enc(x) < enc(y) ? -1 : enc(x) > enc(y) ? 1 : 0))).merged;
      const results = permutations(heads).map(fixed);
      for (const r of results) expect(r).toBe(results[0]);
    }), { ...fcOpts, numRuns: Math.max(20, Math.floor(PROPS_RUNS / 2)) });
  });

  it("(b) three or four heads merged pairwise in any order: the same pages", () => {
    fc.assert(fc.property(fc.integer({ min: 3, max: 4 }).chain(headsArb), ({ base, heads }) => {
      const results = permutations(heads).map((order) => [...pageKeys(pagesOf(fold(base, order).merged))].sort().join(","));
      for (const r of results) expect(r).toBe(results[0]);
    }), { ...fcOpts, numRuns: Math.max(20, Math.floor(PROPS_RUNS / 2)) });
  });

  it("(b) three or four heads merged pairwise in any order: each device's own order is kept (the pages it added in the order it put them; the base pages in the base's order)", () => {
    fc.assert(fc.property(fc.integer({ min: 3, max: 4 }).chain(headsArb), ({ base, heads }) => {
      const inBase = new Set(pageKeys(base));
      for (const order of permutations(heads)) {
        const merged = pageKeys(pagesOf(fold(base, order).merged));
        const at = new Map(merged.map((k, i) => [k, i] as const));
        for (const head of heads) {
          const own = pageKeys(head).filter((k) => at.has(k) && true);
          const added = own.filter((k) => !inBase.has(k));
          for (let i = 1; i < added.length; i++) expect(at.get(added[i - 1]!)!).toBeLessThan(at.get(added[i]!)!);
          const fromBase = own.filter((k) => inBase.has(k));
          for (let i = 1; i < fromBase.length; i++) expect(at.get(fromBase[i - 1]!)!).toBeLessThan(at.get(fromBase[i]!)!);
        }
      }
    }), { ...fcOpts, numRuns: Math.max(20, Math.floor(PROPS_RUNS / 4)) });
  }, 120_000);

  // Known limits, pinned so that they are not forgotten (the merged list is never wrong, only its order of pages two devices added
  // at the same place can differ by the order the merges were made in):
  it.fails("(b) KNOWN LIMIT: pairwise in any order gives the same bytes — not when a base page one device deleted stood between pages two other devices added (the merge of the two loses where they stood)", () => {
    fc.assert(fc.property(fc.integer({ min: 3, max: 4 }).chain(headsArb), ({ base, heads }) => {
      const results = permutations(heads).map((order) => fold(base, order).merged);
      for (const r of results) expect(r).toBe(results[0]);
    }), { ...fcOpts, numRuns: Math.max(20, Math.floor(PROPS_RUNS / 2)) });
  });

  it.fails("(b) KNOWN LIMIT: with no base, three heads merged pairwise in a different order can differ in bytes (the first merge turns an order picked by key into a constraint of the next)", () => {
    const blank = (id: string): PageRun => ({ id, kind: "blank" });
    const list = (...ids: string[]): string => enc({ version: 1, runs: ids.map(blank) });
    const a = list("q", "a"), b = list("p"), c = list("z", "p");
    expect(mergeNotePages(null, c, mergeNotePages(null, a, b).merged).merged).toBe(mergeNotePages(null, a, mergeNotePages(null, b, c).merged).merged);
  });

  it("(b) the same head twice changes nothing", () => {
    fc.assert(fc.property(headsArb(1), ({ base, heads }) => {
      const merged = mergeNotePages(enc(base), enc(heads[0]!), enc(heads[0]!));
      expect(pageKeys(pagesOf(merged.merged))).toEqual(pageKeys(heads[0]!));
    }), fcOpts);
  });

  it("(c) with no base the pages of both sides are kept, nothing is removed, and the merge is not clean", () => {
    fc.assert(fc.property(headsArb(2), ({ heads }) => {
      const result = mergeNotePages(null, enc(heads[0]!), enc(heads[1]!));
      expect(result.clean).toBe(false);
      const merged = new Set(pageKeys(pagesOf(result.merged)));
      for (const key of [...pageKeys(heads[0]!), ...pageKeys(heads[1]!)]) expect(merged.has(key)).toBe(true);
      expect(merged.size).toBe(new Set([...pageKeys(heads[0]!), ...pageKeys(heads[1]!)]).size);
      expect(mergeNotePages(null, enc(heads[1]!), enc(heads[0]!)).merged).toBe(result.merged);
    }), fcOpts);
  });

  it("(c) with a base: a page is in the result when both sides have it, or a side added it; removed on either side it is gone", () => {
    fc.assert(fc.property(headsArb(2), ({ base, heads }) => {
      const result = mergeNotePages(enc(base), enc(heads[0]!), enc(heads[1]!));
      const inBase = new Set(pageKeys(base)), a = new Set(pageKeys(heads[0]!)), b = new Set(pageKeys(heads[1]!));
      const expected = new Set([...a, ...b].filter((k) => !inBase.has(k) || a.has(k) && b.has(k)));
      expect(new Set(pageKeys(pagesOf(result.merged)))).toEqual(expected);
    }), fcOpts);
  });

  it("(d) the result has no overlapping ranges and no duplicate ids, each page once", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 4 }).chain(headsArb), ({ base, heads }) => {
      const merged = fold(base, heads).merged;
      const pages = pagesOf(merged); // throws when the codec refuses it: overlapping ranges, a duplicate id, a prefix of two files
      const keys = pageKeys(pages);
      expect(new Set(keys).size).toBe(keys.length);
      expect(new Set(pages.runs.map((r) => r.id)).size).toBe(pages.runs.length);
    }), fcOpts);
  });
});
