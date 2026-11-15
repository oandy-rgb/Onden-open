// A PDF note's drawing as pages in page units (lib/pdf/pageUnits.ts): the older
// fields convert on read to where they were drawn, a save writes both forms, and
// the two always describe the same drawing.
import { INK_PAGE_UNITS, UNIFORM_TOOL_ID, currentUnits, legacyFingerprint, mergeInk, encodeInk, type InkDocument, type InkShape, type InkStroke } from "@onden/markdown/ink";
import { describe, expect, it } from "vitest";
import { drawingRecord, shapeRecord } from "../lib/pdf/capture";
import { scaledToViewport, type PdfDrawingStroke, type PdfHighlightRecord, type PdfShapeType } from "../lib/pdf/coords";
import { pagesFromLegacy, pdfPageDoc, readPdfInk, recordFrame, setPdfPageDoc, withUnits } from "../lib/pdf/pageUnits";
import { addDrawingToPage, addShapeToPage, decodePdfInk, emptyMultiPageDoc, type InkMultiPageDoc } from "../lib/pdf/pdfAdapter";

const VP = { width: 600, height: 800 };

/** A drawing as the older app stored it: record + its strokes in pages[n]. */
function legacyDrawing(doc: InkMultiPageDoc, id: string, page: number, strokes: PdfDrawingStroke[], viewport = VP): InkMultiPageDoc {
  const record = drawingRecord(id, page, strokes, viewport)!;
  return addDrawingToPage({ ...doc, annotations: [...(doc.annotations ?? []), record] }, page, id, record.content!.strokes!);
}

function legacyShape(doc: InkMultiPageDoc, id: string, page: number, kind: PdfShapeType, a: [number, number], b: [number, number], viewport = VP, width = 3): InkMultiPageDoc {
  const record = shapeRecord(id, page, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }, { shapeType: kind, strokeColor: "#315f8f", strokeWidth: width }, viewport)!;
  return addShapeToPage({ ...doc, annotations: [...(doc.annotations ?? []), record] }, page, id, record.content!.shape!);
}

/** Where the older app drew a record's strokes at `viewport` (page px): its own
 *  frame → px conversion, written out independently of the new code. */
function oldPositions(record: PdfHighlightRecord, viewport: { width: number; height: number }) {
  const frame = recordFrame(record);
  const r = scaledToViewport(record.position.boundingRect, viewport);
  const sx = r.width / frame.w, sy = r.height / frame.h;
  return (record.content?.strokes ?? []).map((s) => ({
    points: s.points.map((p) => [r.left + p.x * sx, r.top + p.y * sy] as [number, number]),
    width: s.width * sx,
  }));
}

/** The new reading of a stroke, in page px at `viewport`. */
const px = (stroke: InkStroke, viewport: { width: number }): Array<[number, number]> =>
  stroke.points.map((p) => [(p[0] * viewport.width) / INK_PAGE_UNITS, (p[1] * viewport.width) / INK_PAGE_UNITS]);

const maxGap = (a: Array<[number, number]>, b: Array<[number, number]>) =>
  Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i]![0], p[1] - b[i]![1])));

const stroke = (pts: Array<[number, number]>, extra: Partial<PdfDrawingStroke> = {}): PdfDrawingStroke =>
  ({ points: pts.map(([x, y]) => ({ x, y })), color: "#7a2e33", width: 2.5, ...extra });

const pageDocOf = (env: InkMultiPageDoc, n = 1) => pdfPageDoc(env, n)!;

describe("an older drawing read as page units", () => {
  const zooms = [{ width: 600, height: 800 }, { width: 1200, height: 1600 }, { width: 450, height: 600 }];

  it("lands where the older app drew it, at every zoom (record with a frame)", () => {
    const env = legacyDrawing(emptyMultiPageDoc(), "d1", 1, [stroke([[100, 100], [150, 120], [200, 100]]), stroke([[300, 300], [350, 340]], { width: 4 })]);
    const doc = pageDocOf(withUnits(env));
    expect(doc.page.width).toBe(1000);
    const old = oldPositions(env.annotations![0]!, VP);
    expect(doc.strokes.map((s) => s.id)).toEqual(["d1:0", "d1:1"]);
    for (const viewport of zooms) {
      const record = env.annotations![0]!;
      const want = oldPositions(record, viewport);
      doc.strokes.forEach((s, i) => {
        expect(maxGap(px(s, viewport), want[i]!.points)).toBeLessThan(0.5);
        expect((s.size * viewport.width) / INK_PAGE_UNITS).toBeCloseTo(want[i]!.width, 6);
      });
    }
    expect(old).toHaveLength(2);
  });

  it("a record captured at another zoom than it is read at still lands in the same place", () => {
    const env = legacyDrawing(emptyMultiPageDoc(), "d1", 1, [stroke([[500, 500], [900, 700]], { width: 5 })], { width: 1500, height: 2000 });
    const doc = pageDocOf(withUnits(env));
    for (const viewport of zooms) {
      expect(maxGap(px(doc.strokes[0]!, viewport), oldPositions(env.annotations![0]!, viewport)[0]!.points)).toBeLessThan(0.5);
    }
    expect(doc.page.width).toBe(1000);
    expect(doc.strokes[0]!.points[0]).toEqual([(500 * 1000) / 1500, (500 * 1000) / 1500]);
  });

  it("a record without a frame (before frames existed) is recovered from the stroke extents", () => {
    const env = legacyDrawing(emptyMultiPageDoc(), "old", 2, [stroke([[100, 100], [150, 100], [200, 100]])]);
    delete env.annotations![0]!.content!.frame;
    const doc = pageDocOf(withUnits(env), 2);
    for (const viewport of zooms) {
      expect(maxGap(px(doc.strokes[0]!, viewport), oldPositions(env.annotations![0]!, viewport)[0]!.points)).toBeLessThan(0.5);
    }
  });

  it("erased spans follow the stroke id", () => {
    let env = legacyDrawing(emptyMultiPageDoc(), "a", 1, [stroke([[10, 10], [20, 20], [30, 30], [40, 40]])]);
    env = legacyDrawing(env, "g", 1, [stroke([[100, 10], [110, 20]]), stroke([[200, 10], [210, 20], [220, 30]])]);
    env = { ...env, pages: { 1: { ...env.pages[1]!, erased: { a: [[1, 2]], "g:1": [[0, 0]] } } } };
    const doc = pageDocOf(withUnits(env));
    expect(doc.erased).toEqual({ a: [[1, 2]], "g:1": [[0, 0]] });
    expect(doc.strokes.map((s) => s.id)).toEqual(["a", "g:0", "g:1"]);
  });

  it("keeps pressure, the highlighter and the colour; a stroke with no tool stays a constant-width line", () => {
    const env = legacyDrawing(emptyMultiPageDoc(), "p", 1, [
      { points: [{ x: 10, y: 10, p: 0.3 }, { x: 40, y: 40, p: 0.9 }], color: "#c2871d", width: 7, toolId: "highlighter" },
      { points: [{ x: 60, y: 10 }, { x: 90, y: 40 }], color: "#000", width: 2 },
    ]);
    const [marker, plain] = pageDocOf(withUnits(env)).strokes;
    expect(marker).toMatchObject({ toolId: "highlighter", color: "#c2871d" });
    expect(marker!.points.map((p) => p[2])).toEqual([0.3, 0.9]);
    expect(plain!.toolId).toBe(UNIFORM_TOOL_ID);
    expect(plain!.points.every((p) => p.length === 2)).toBe(true);
  });

  it("a shape record becomes a shape at the same place at every zoom; a box is inset by half its line", () => {
    const env = legacyShape(legacyShape(emptyMultiPageDoc(), "r", 1, "rectangle", [100, 100], [300, 220]), "a", 1, "arrow", [400, 400], [320, 340]);
    const doc = pageDocOf(withUnits(env));
    const [rect, arrow] = doc.shapes!;
    for (const viewport of zooms) {
      const k = viewport.width / INK_PAGE_UNITS;
      const scale = viewport.width / VP.width;
      expect(rect!.start[0] * k).toBeCloseTo((100 + 1.5) * scale, 6);
      expect(rect!.end[1] * k).toBeCloseTo((220 - 1.5) * scale, 6);
      expect(arrow!.start[0] * k).toBeCloseTo(400 * scale, 6);
      expect(arrow!.end[1] * k).toBeCloseTo(340 * scale, 6);
    }
    expect(rect).toMatchObject({ id: "r", kind: "rectangle", color: "#315f8f" });
    expect(rect!.size).toBeCloseTo((3 * INK_PAGE_UNITS) / VP.width, 9);
  });

  it("text and area records are not touched, and are not drawings", () => {
    const text = { id: "t", type: "text", content: { text: "x" }, position: { boundingRect: { x1: 1, y1: 2, x2: 3, y2: 4, width: 600, height: 800, pageNumber: 1 }, rects: [] } } as PdfHighlightRecord;
    const env = { ...legacyDrawing(emptyMultiPageDoc(), "d", 1, [stroke([[1, 1], [9, 9]])]), };
    const withText = { ...env, annotations: [text, ...env.annotations!] };
    const next = setPdfPageDoc(withUnits(withText), 1, pageDocOf(withUnits(withText)), 800 / 600);
    expect(next.annotations!.find((a) => a.id === "t")).toBe(text);
    expect(Object.keys(pagesFromLegacy({ ...emptyMultiPageDoc(), annotations: [text] }).pages)).toEqual([]);
  });

  it("strokes only pages[n] holds (their record is gone) are kept as stored", () => {
    const env: InkMultiPageDoc = {
      version: 1,
      pages: { 3: { version: 1, strokes: [{ id: "lost", points: [[5, 6], [7, 8]], color: "#000", size: 2, toolId: "pen" }], erased: { lost: [[0, 0]] }, page: { width: 1000 } } },
      annotations: [],
    };
    const doc = pageDocOf(withUnits(env), 3);
    expect(doc.strokes).toEqual(env.pages[3]!.strokes);
    expect(doc.erased).toEqual({ lost: [[0, 0]] });
  });

  it("a drawing missing from pages[n] (very old data) converts all the same", () => {
    const record = drawingRecord("v", 1, [stroke([[10, 10], [60, 60]])], VP)!;
    const doc = pageDocOf(withUnits({ version: 1, pages: {}, annotations: [record] }));
    expect(doc.strokes.map((s) => s.id)).toEqual(["v"]);
  });

  it("reading twice converts once: pages that already have units are not converted again", () => {
    const env = legacyDrawing(emptyMultiPageDoc(), "d1", 1, [stroke([[10, 10], [60, 60]])]);
    const once = withUnits(env);
    expect(currentUnits(once)).not.toBeNull();
    expect(withUnits(once)).toBe(once);
    expect(readPdfInk(JSON.stringify(once), null).units).toEqual(once.units);
  });
});

describe("saving writes both forms", () => {
  const drawn = (): InkDocument => ({
    version: 1, page: { width: 1000 }, erased: { n1: [[1, 1]] },
    strokes: [
      { id: "n1", points: [[100, 100, 0.5], [200, 150, 0.7], [300, 120, 0.6]], color: "#315f8f", size: 6, toolId: "pen" },
      { id: "n2", points: [[400, 400], [500, 450]], color: "#c2871d", size: 18, toolId: "highlighter" },
    ],
    shapes: [{ id: "sh", kind: "ellipse", start: [100, 600], end: [400, 800], color: "#c43c3c", size: 5 }],
  });

  it("units hold the page as the engine had it, and the older fields hold the same drawing", () => {
    const env = setPdfPageDoc(emptyMultiPageDoc(), 2, drawn(), 800 / 600);
    expect(env.units!.pages["pdf:2"]).toMatchObject({ key: "pdf:2", background: { kind: "pdf", page: 2 }, size: { width: 1000 } });
    expect(env.units!.pages["pdf:2"]!.size.height).toBeCloseTo(1333.333, 2);
    expect(env.units!.pages["pdf:2"]!.doc.strokes.map((s) => s.id)).toEqual(["n1", "n2"]);
    expect(env.annotations!.map((a) => [a.id, a.type])).toEqual([["n1", "drawing"], ["n2", "drawing"], ["sh", "shape"]]);
    expect(env.pages[2]!.strokes.map((s) => s.id)).toEqual(["n1", "n2"]);
    expect(env.pages[2]!.erased).toEqual({ n1: [[1, 1]] });
    expect(env.pages[2]!.shapes!.map((s) => s.id)).toEqual(["sh"]);
    expect(env.unitsFrom).toBe(legacyFingerprint(env));
  });

  it("older → page units gives the page back, within half a pixel at any zoom (round trip)", () => {
    const env = setPdfPageDoc(emptyMultiPageDoc(), 1, drawn(), 800 / 600);
    const legacyOnly = decodePdfInk(JSON.stringify({ ...env, units: undefined, unitsFrom: undefined }), null);
    const back = pagesFromLegacy(legacyOnly).pages["pdf:1"]!.doc;
    const first = drawn();
    expect(back.strokes.map((s) => s.id)).toEqual(first.strokes.map((s) => s.id));
    first.strokes.forEach((s, i) => {
      expect(maxGap(px(back.strokes[i]!, { width: 1200 }), px(s, { width: 1200 }))).toBeLessThan(0.01);
      expect(back.strokes[i]!.size).toBeCloseTo(s.size, 6);
      expect(back.strokes[i]!.toolId).toBe(s.toolId);
      expect(back.strokes[i]!.points.map((p) => p[2])).toEqual(s.points.map((p) => p[2]));
    });
    expect(back.erased).toEqual(first.erased);
    expect(back.shapes![0]!.start[0]).toBeCloseTo(first.shapes![0]!.start[0], 6);
    expect(back.shapes![0]!.end[1]).toBeCloseTo(first.shapes![0]!.end[1], 6);
    expect(back.shapes![0]).toMatchObject({ kind: "ellipse", color: "#c43c3c" });
  });

  it("an edit rewrites only what changed: kept records stay as they were, another page is untouched", () => {
    let env = legacyDrawing(emptyMultiPageDoc(), "old", 1, [stroke([[10, 10], [60, 60]])]);
    env = legacyDrawing(env, "other", 2, [stroke([[20, 20], [80, 80]])]);
    env = withUnits(env);
    const oldRecord = env.annotations!.find((a) => a.id === "old");
    const page = structuredClone(pageDocOf(env, 1));
    page.strokes.push({ id: "fresh", points: [[300, 300], [400, 400]], color: "#000", size: 4, toolId: "pen" });
    const next = setPdfPageDoc(env, 1, page, 800 / 600);
    expect(next.annotations!.find((a) => a.id === "old")).toBe(oldRecord);
    expect(next.annotations!.map((a) => a.id)).toEqual(["old", "other", "fresh"]);
    expect(next.pages[2]).toBe(env.pages[2]);
    expect(next.units!.pages["pdf:2"]).toBe(env.units!.pages["pdf:2"]);
  });

  it("a stroke the page no longer has takes its record and page entry with it; a whole older group is kept whole", () => {
    let env = legacyDrawing(emptyMultiPageDoc(), "g", 1, [stroke([[10, 10], [60, 60]]), stroke([[100, 100], [160, 160]])]);
    env = withUnits(legacyDrawing(env, "solo", 1, [stroke([[300, 300], [360, 360]])]));
    const withoutSolo = { ...pageDocOf(env), strokes: pageDocOf(env).strokes.filter((s) => s.id !== "solo") };
    const next = setPdfPageDoc(env, 1, withoutSolo, 800 / 600);
    expect(next.annotations!.map((a) => a.id)).toEqual(["g"]);
    expect(next.pages[1]!.strokes.map((s) => s.id)).toEqual(["g:0", "g:1"]);
    // half a group: the rest become records of their own, ids unchanged
    const half = setPdfPageDoc(next, 1, { ...withoutSolo, strokes: withoutSolo.strokes.filter((s) => s.id !== "g:0") }, 800 / 600);
    expect(half.annotations!.map((a) => a.id)).toEqual(["g:1"]);
    expect(half.pages[1]!.strokes.map((s) => s.id)).toEqual(["g:1"]);
  });

  it("orphans (pages[n] only) stay orphans; text and area records stay", () => {
    const env0: InkMultiPageDoc = {
      version: 1,
      pages: { 1: { version: 1, strokes: [{ id: "lost", points: [[5, 6], [7, 8]], color: "#000", size: 2, toolId: "pen" }], erased: {}, page: { width: 1000 } } },
      annotations: [],
    };
    const env = withUnits(env0);
    const next = setPdfPageDoc(env, 1, pageDocOf(env), 800 / 600);
    expect(next.annotations).toEqual([]);
    expect(next.pages[1]!.strokes).toEqual(env0.pages[1]!.strokes);
  });

  it("an empty page that had no drawing writes nothing", () => {
    const env = withUnits(emptyMultiPageDoc());
    expect(setPdfPageDoc(env, 4, { version: 1, strokes: [], erased: {}, page: { width: 1000 } }, 1.4)).toBe(env);
  });
});

describe("an older app edits the older fields (it keeps `units` as found)", () => {
  it("units that no longer match are converted again: nothing the older app drew is lost, nothing from before is", () => {
    const base = setPdfPageDoc(emptyMultiPageDoc(), 1, { version: 1, page: { width: 1000 }, erased: {}, strokes: [{ id: "new1", points: [[100, 100], [200, 200]], color: "#000", size: 4, toolId: "pen" }] }, 800 / 600);
    // the older app: adds a drawing (record + page copy), leaves `units` alone
    const edited = legacyDrawing(base, "oldApp", 1, [stroke([[50, 50], [90, 90]])]);
    expect(currentUnits(edited)).toBeNull();
    const read = withUnits(edited);
    expect(pageDocOf(read).strokes.map((s) => s.id).sort()).toEqual(["new1", "oldApp"]);
    expect(read.unitsFrom).toBe(legacyFingerprint(read));
  });

  it("the older app erasing a stroke's span is seen too", () => {
    const base = setPdfPageDoc(emptyMultiPageDoc(), 1, { version: 1, page: { width: 1000 }, erased: {}, strokes: [{ id: "s", points: [[1, 1], [2, 2], [3, 3]], color: "#000", size: 4, toolId: "pen" }] }, 1.4);
    const edited = { ...base, pages: { ...base.pages, 1: { ...base.pages[1]!, erased: { s: [[1, 1]] as Array<[number, number]> } } } };
    expect(pageDocOf(withUnits(edited)).erased).toEqual({ s: [[1, 1]] });
  });

  it("a text highlight added by the older app does not make `units` stale", () => {
    const base = setPdfPageDoc(emptyMultiPageDoc(), 1, { version: 1, page: { width: 1000 }, erased: {}, strokes: [{ id: "s", points: [[1, 1], [2, 2]], color: "#000", size: 4, toolId: "pen" }] }, 1.4);
    const text = { id: "t", type: "text", position: { boundingRect: { x1: 1, y1: 1, x2: 2, y2: 2, width: 600, height: 800, pageNumber: 1 }, rects: [] } } as PdfHighlightRecord;
    expect(currentUnits({ ...base, annotations: [...base.annotations!, text] })).not.toBeNull();
  });
});

describe("two devices drawing on a PDF in the new format", () => {
  const strokeDoc = (id: string, x: number): InkDocument => ({ version: 1, page: { width: 1000 }, erased: {}, strokes: [{ id, points: [[x, 10], [x + 50, 60]], color: "#000", size: 4, toolId: "pen" }] });
  const merged = (base: InkMultiPageDoc, stored: InkMultiPageDoc, incoming: InkMultiPageDoc): InkMultiPageDoc =>
    decodePdfInk(mergeInk(encodeInk(base), encodeInk(stored), encodeInk(incoming)).value, null);
  const idsOf = (env: InkMultiPageDoc, n: number) => (env.units!.pages[`pdf:${n}`]?.doc.strokes ?? []).map((s) => s.id).sort();

  it("different strokes on the same page: both survive, in both forms", () => {
    const base = withUnits(emptyMultiPageDoc());
    const a = setPdfPageDoc(base, 1, strokeDoc("a", 10), 1.4);
    const b = setPdfPageDoc(base, 1, strokeDoc("b", 300), 1.4);
    const result = merged(base, a, b);
    expect(idsOf(result, 1)).toEqual(["a", "b"]);
    expect(result.annotations!.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(result.pages[1]!.strokes.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(currentUnits(result)).not.toBeNull(); // the merged units are still trusted
  });

  it("different pages never conflict", () => {
    const base = withUnits(emptyMultiPageDoc());
    const a = setPdfPageDoc(base, 1, strokeDoc("a", 10), 1.4);
    const b = setPdfPageDoc(base, 2, strokeDoc("b", 10), 1.4);
    const result = merged(base, a, b);
    expect(idsOf(result, 1)).toEqual(["a"]);
    expect(idsOf(result, 2)).toEqual(["b"]);
    expect(Object.keys(result.pages).sort()).toEqual(["1", "2"]);
  });

  it("an erase on one device and a stroke on the other both stay", () => {
    const start = setPdfPageDoc(emptyMultiPageDoc(), 1, strokeDoc("a", 10), 1.4);
    const erased = setPdfPageDoc(start, 1, { ...strokeDoc("a", 10), erased: { a: [[0, 0]] } }, 1.4);
    const added = setPdfPageDoc(start, 1, { ...strokeDoc("a", 10), strokes: [...strokeDoc("a", 10).strokes, ...strokeDoc("b", 300).strokes] }, 1.4);
    const result = merged(start, erased, added);
    expect(result.units!.pages["pdf:1"]!.doc.erased).toEqual({ a: [[0, 0]] });
    expect(idsOf(result, 1)).toEqual(["a", "b"]);
  });

  it("the older app on one side: units go stale, the older fields hold both, a reader converts them", () => {
    const base = setPdfPageDoc(emptyMultiPageDoc(), 1, strokeDoc("a", 10), 1.4);
    const oldApp = legacyDrawing(base, "o", 1, [stroke([[10, 10], [50, 50]])]);
    const newApp = setPdfPageDoc(base, 1, { ...strokeDoc("a", 10), strokes: [...strokeDoc("a", 10).strokes, ...strokeDoc("b", 300).strokes] }, 1.4);
    const result = merged(base, oldApp, newApp);
    expect(currentUnits(result)).toBeNull();
    expect(idsOf(withUnits(result), 1)).toEqual(["a", "b", "o"]);
  });

  it("an older app's save over a newer one's keeps the newer one's units, which a reader trusts again once they match", () => {
    const base = setPdfPageDoc(emptyMultiPageDoc(), 1, strokeDoc("a", 10), 1.4);
    const oldAppText = { ...base, annotations: [...base.annotations!, { id: "t", type: "text", position: { boundingRect: { x1: 1, y1: 1, x2: 2, y2: 2, width: 600, height: 800, pageNumber: 1 }, rects: [] } } as PdfHighlightRecord] };
    const newApp = setPdfPageDoc(base, 1, { ...strokeDoc("a", 10), strokes: [...strokeDoc("a", 10).strokes, ...strokeDoc("b", 300).strokes] }, 1.4);
    const result = merged(base, newApp, oldAppText);
    expect(currentUnits(result)).not.toBeNull();
    expect(idsOf(result, 1)).toEqual(["a", "b"]);
    expect(result.annotations!.some((r) => r.id === "t")).toBe(true);
  });
});

describe("random drawings: older → page units → older, nothing lost, nothing moved", () => {
  // A small deterministic generator (the same seed, the same drawings).
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  it("keeps every stroke, erased span and shape, within half a pixel at any zoom", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const int = (n: number) => Math.floor(r() * n);
      const viewport = { width: 300 + int(900), height: 0 };
      viewport.height = viewport.width * 1.3;
      let env = emptyMultiPageDoc();
      const ids: string[] = [];
      for (let g = 0; g < 1 + int(4); g++) {
        const strokes: PdfDrawingStroke[] = Array.from({ length: 1 + int(3) }, () => {
          const n = 2 + int(8);
          const pressured = r() < 0.5;
          return {
            points: Array.from({ length: n }, () => ({ x: r() * viewport.width, y: r() * viewport.height, ...(pressured ? { p: r() } : {}) })),
            color: r() < 0.5 ? "#000" : "#c2871d",
            width: 1 + r() * 10,
            ...(r() < 0.8 ? { toolId: r() < 0.3 ? "highlighter" : "pen" } : {}),
          };
        });
        env = legacyDrawing(env, `g${g}`, 1 + int(2), strokes, viewport);
        strokes.forEach((_, i) => ids.push(strokes.length === 1 ? `g${g}` : `g${g}:${i}`));
      }
      for (let s = 0; s < int(3); s++) {
        const kind = (["rectangle", "ellipse", "triangle", "diamond"] as const)[int(4)]!;
        const a: [number, number] = [r() * 300, r() * 300];
        env = legacyShape(env, `sh${s}`, 1 + int(2), kind, a, [a[0] + 40 + r() * 200, a[1] + 40 + r() * 200], viewport, 1 + r() * 6);
      }
      // erase some spans
      const pages = { ...env.pages };
      for (const [n, page] of Object.entries(pages)) {
        const erased = { ...page.erased };
        for (const s of page.strokes) if (r() < 0.4 && s.points.length > 2) erased[s.id] = [[1, 1 + int(s.points.length - 2)]];
        pages[Number(n)] = { ...page, erased };
      }
      env = { ...env, pages };

      const units = withUnits(env);
      // the page the new code shows is where the old code drew
      for (const record of env.annotations!.filter((a) => a.type === "drawing")) {
        const pageDoc = pageDocOf(units, record.position.boundingRect.pageNumber);
        const want = oldPositions(record, viewport);
        record.content!.strokes!.forEach((_, i) => {
          const id = record.content!.strokes!.length === 1 ? record.id : `${record.id}:${i}`;
          const got = pageDoc.strokes.find((s) => s.id === id)!;
          expect(got, `seed ${seed} ${id}`).toBeDefined();
          expect(maxGap(px(got, viewport), want[i]!.points)).toBeLessThan(0.5);
          expect(got.points.length).toBe(want[i]!.points.length);
        });
      }
      // every page, written back and read again, is the same drawing
      let rewritten = units;
      for (const key of Object.keys(units.units!.pages)) {
        const n = Number(key.slice(4));
        rewritten = setPdfPageDoc(rewritten, n, units.units!.pages[key]!.doc, 1.3);
      }
      const again = pagesFromLegacy(decodePdfInk(JSON.stringify({ ...rewritten, units: undefined, unitsFrom: undefined }), null));
      for (const [key, record] of Object.entries(units.units!.pages)) {
        const back = again.pages[key]!.doc;
        expect(back.strokes.map((s) => s.id).sort(), `seed ${seed}`).toEqual(record.doc.strokes.map((s) => s.id).sort());
        for (const s of record.doc.strokes) {
          const b = back.strokes.find((x) => x.id === s.id)!;
          expect(maxGap(px(b, viewport), px(s, viewport))).toBeLessThan(0.5);
          expect(back.erased[s.id] ?? []).toEqual(record.doc.erased[s.id] ?? []);
        }
        expect((back.shapes ?? []).map((s: InkShape) => s.id).sort()).toEqual((record.doc.shapes ?? []).map((s) => s.id).sort());
      }
      expect(ids.length).toBeGreaterThan(0);
    }
  });
});
