// What a page leaves on the device at pen-up is a drawing holding only the strokes just added (lib/ink/additions),
// sent, if the page dies before its save, as a save made from nothing. The server merges it like any save
// (@onden/markdown/ink mergeInk with base ""). Property: for every drawing the server may hold and every set of strokes
// added on one of its pages, that merge is exactly the drawing with those strokes added — nothing it held is lost, moved
// to another page, duplicated or changed (page settings, order, the PDF's older fields), and merging it twice changes
// nothing more. For each format: a single page (board pen layer, note_ink first page), a notebook (morePages), a PDF envelope.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "./helpers/propsConfig";
import { decodeInk, encodeInk, mergeInk, notePages, noteDoc, withPageAppended, withPageDoc, type InkDocument, type InkPages, type InkStroke } from "@onden/markdown/ink";
import { INK_PAGE_KEY } from "@onden/markdown/page-text";
import { notebookWithOnly, pageWithOnly } from "../lib/ink";
import { pdfWithOnly } from "../lib/pdf";
import { emptyMultiPageDoc, type InkMultiPageDoc } from "../lib/pdf/pdfAdapter";
import { pdfPageDoc, readPdfInk, setPdfPageDoc } from "../lib/pdf/pageUnits";

const stroke = (id: string, i: number): InkStroke => ({ id, points: [[i, i + 1], [i + 5, i + 9], [i + 9, i + 4]], color: "#000000", size: 2, toolId: "pen" });
const ids = (doc: InkDocument | undefined) => (doc?.strokes ?? []).map((s) => s.id).sort();
const run = { numRuns: PROPS_RUNS, ...(PROPS_SEED === undefined ? {} : { seed: PROPS_SEED }) };

/** A drawing as pages of stroke ids (first page key `page` / `pdf:1`…), and which page gets which new strokes. */
const world = fc.record({
  pages: fc.array(fc.array(fc.integer({ min: 0, max: 50 }), { maxLength: 6 }), { minLength: 1, maxLength: 4 }),
  erased: fc.boolean(),
  target: fc.nat(),
  added: fc.integer({ min: 1, max: 4 }),
});
type World = typeof world extends fc.Arbitrary<infer T> ? T : never;
const strokesOf = (p: number, xs: number[]) => xs.map((x, i) => stroke(`p${p}s${i}`, x));
const addedOf = (n: number) => Array.from({ length: n }, (_, i) => stroke(`new${i}`, 7 * i));
const merge = (stored: string, partial: string) => mergeInk("", stored, partial).value;

describe("a drawing of only the added strokes, merged from nothing, adds exactly them", () => {
  it("one page (a board's pen layer)", () => {
    fc.assert(fc.property(world, (w: World) => {
      const before: InkDocument = { version: 1, strokes: strokesOf(0, w.pages[0]!), erased: w.erased && w.pages[0]!.length ? { p0s0: [[0, 1]] } : {}, page: { width: 1000 } };
      const added = addedOf(w.added);
      const after: InkDocument = { ...before, strokes: [...before.strokes, ...added] };
      const once = merge(encodeInk(before), encodeInk(pageWithOnly(before.page, { strokes: added, shapes: [] })));
      const got = decodeInk(once);
      expect(got.kind).toBe("page");
      const doc = (got as { doc: InkDocument }).doc;
      expect(ids(doc)).toEqual(ids(after));
      expect(doc.erased).toEqual(after.erased);
      expect(doc.page).toEqual(after.page);
      expect(merge(once, encodeInk(pageWithOnly(before.page, { strokes: added, shapes: [] })))).toBe(once);
    }), run);
  });

  it("a notebook (first page and more pages)", () => {
    fc.assert(fc.property(world, (w: World) => {
      let pages: InkPages = notePages({ version: 1, strokes: strokesOf(0, w.pages[0]!), erased: {}, page: { width: 1000 } });
      const keys = [INK_PAGE_KEY];
      for (let p = 1; p < w.pages.length; p++) {
        const key = `k${p}`;
        keys.push(key);
        pages = withPageAppended(pages, key);
        pages = withPageDoc(pages, key, { ...pages.pages[key]!.doc, strokes: strokesOf(p, w.pages[p]!) });
      }
      const key = keys[w.target % keys.length]!;
      const added = addedOf(w.added);
      const afterPages = withPageDoc(pages, key, { ...pages.pages[key]!.doc, strokes: [...pages.pages[key]!.doc.strokes, ...added] });
      const before = encodeInk(noteDoc(pages)!);
      const partial = encodeInk(noteDoc(notebookWithOnly(pages, key, { strokes: added, shapes: [] })!)!);
      const once = merge(before, partial);
      const got = notePages((decodeInk(once) as { doc: InkDocument }).doc);
      const want = notePages(noteDoc(afterPages)!);
      for (const k of keys) expect(ids(got.pages[k]?.doc), `page ${k}`).toEqual(ids(want.pages[k]?.doc));
      expect(Object.keys(got.pages).sort()).toEqual(Object.keys(want.pages).sort());
      expect(got.order ?? null).toEqual(want.order ?? null);
      for (const k of keys) expect(got.pages[k]!.doc.page).toEqual(want.pages[k]!.doc.page);
      expect(merge(once, partial)).toBe(once);
    }), run);
  });

  it("a PDF envelope (units and the older fields)", () => {
    fc.assert(fc.property(world, (w: World) => {
      const ratio = 842 / 595;
      let env: InkMultiPageDoc = emptyMultiPageDoc();
      for (let p = 0; p < w.pages.length; p++) {
        if (w.pages[p]!.length) env = setPdfPageDoc(env, p + 1, { version: 1, strokes: strokesOf(p, w.pages[p]!), erased: {}, page: { width: 1000 } }, ratio);
      }
      const n = (w.target % w.pages.length) + 1;
      const key = `pdf:${n}`;
      const added = addedOf(w.added);
      const page = pdfPageDoc(env, n) ?? { version: 1, strokes: [], erased: {}, page: { width: 1000 } };
      const after = setPdfPageDoc(env, n, { ...page, strokes: [...page.strokes, ...added] }, ratio);
      const partial = encodeInk(pdfWithOnly(env, key, { strokes: added, shapes: [] }, ratio)!);
      const once = merge(encodeInk(env), partial);
      const got = readPdfInk(once, null);
      const want = readPdfInk(encodeInk(after), null);
      for (let p = 1; p <= w.pages.length; p++) expect(ids(pdfPageDoc(got, p)), `page ${p} (units)`).toEqual(ids(pdfPageDoc(want, p)));
      // The older fields an older app reads: the same strokes on the same pages, and one record each.
      for (let p = 1; p <= w.pages.length; p++) expect(ids(got.pages[p]), `page ${p} (older fields)`).toEqual(ids(want.pages[p]));
      expect((got.annotations ?? []).map((a) => a.id).sort()).toEqual((want.annotations ?? []).map((a) => a.id).sort());
      expect(merge(once, partial)).toBe(once);
    }), run);
  });
});
