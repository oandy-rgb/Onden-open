// PDF shapes as page shapes: a stored record is read as a shape in page units
// and written back as a record (the older form), new shapes become records (and
// leave when the page loses them), and what an older or newer app stored is not
// harmed.
import { INK_SHAPE_KINDS, INK_PAGE_UNITS, type InkDocument, type InkShape } from "@onden/markdown/ink";
import { describe, expect, it } from "vitest";
import { shapeRecord } from "../lib/pdf/capture";
import { pageSignature } from "../lib/ink/pageSession";
import { pdfPageDoc, setPdfPageDoc, withUnits } from "../lib/pdf/pageUnits";
import { addShapeToPage, decodePdfInk, emptyMultiPageDoc, type InkMultiPageDoc } from "../lib/pdf/pdfAdapter";
import type { PdfHighlightRecord, PdfShapeType } from "../lib/pdf/coords";

const vp = { width: 600, height: 800 };
const style = (shapeType: PdfShapeType) => ({ shapeType, strokeColor: "#315f8f", strokeWidth: 3 });
const stored = (records: PdfHighlightRecord[]): InkMultiPageDoc =>
  records.reduce((doc, r) => addShapeToPage({ ...doc, annotations: [...(doc.annotations ?? []), r] }, r.position.boundingRect.pageNumber, r.id, r.content!.shape!), emptyMultiPageDoc());
const pageDoc = (shapes: InkShape[]): InkDocument => ({ version: 1, strokes: [], erased: {}, page: { width: INK_PAGE_UNITS }, shapes });
const inkShape = (id: string, kind: string, start: [number, number], end: [number, number]): InkShape => ({ id, kind, start, end, color: "#c43c3c", size: 4 });
const RATIO = 800 / 600;
/** The shapes of page `n` in page px at `width` px wide. */
const shapesAt = (env: InkMultiPageDoc, n: number, width: number) => (pdfPageDoc(env, n)?.shapes ?? []).map((s) => ({
  ...s,
  start: s.start.map((v) => (v * width) / INK_PAGE_UNITS),
  end: s.end.map((v) => (v * width) / INK_PAGE_UNITS),
}));

describe("shapeRecord", () => {
  it("every shape the button offers can be stored when it is big enough", () => {
    for (const kind of INK_SHAPE_KINDS) {
      const rec = shapeRecord("s", 1, { x: 50, y: 60 }, { x: 150, y: 140 }, style(kind), vp);
      expect(rec?.content?.shape?.shapeType, kind).toBe(kind);
    }
  });

  it("a line or arrow may be perfectly horizontal or vertical: its box is made thick enough, the ends keep their place", () => {
    for (const kind of ["line", "arrow"] as const) {
      const flat = shapeRecord("s", 1, { x: 50, y: 100 }, { x: 250, y: 100 }, style(kind), vp)!;
      const r = flat.position.boundingRect;
      expect(r.y2 - r.y1).toBeGreaterThanOrEqual(10);
      const { startPoint, endPoint } = flat.content!.shape!;
      expect(startPoint).toEqual({ x: 0, y: 0.5 });
      expect(endPoint).toEqual({ x: 1, y: 0.5 });
      // round trip: the same ends come back
      const [back] = shapesAt(stored([flat]), 1, vp.width);
      expect(back!.start[0]).toBeCloseTo(50, 9);
      expect(back!.start[1]).toBeCloseTo(100, 9);
      expect(back!.end[0]).toBeCloseTo(250, 9);
      expect(back!.end[1]).toBeCloseTo(100, 9);
    }
  });

  it("a box shape needs both sides, a line only its length", () => {
    expect(shapeRecord("s", 1, { x: 0, y: 0 }, { x: 200, y: 4 }, style("rectangle"), vp)).toBeNull();
    expect(shapeRecord("s", 1, { x: 0, y: 0 }, { x: 200, y: 4 }, style("line"), vp)).not.toBeNull();
    expect(shapeRecord("s", 1, { x: 0, y: 0 }, { x: 5, y: 5 }, style("line"), vp)).toBeNull();
  });
});

describe("shape fill in a PDF record", () => {
  it("a filled shape's record keeps the fill, and reads back filled; an unfilled one carries no field", () => {
    const filled = shapeRecord("f", 1, { x: 50, y: 60 }, { x: 150, y: 140 }, { ...style("star"), fill: "solid" }, vp)!;
    expect(filled.content!.shape!.fill).toBe("solid");
    expect(pdfPageDoc(stored([filled]), 1)!.shapes![0]!.fill).toBe("solid");
    const plain = shapeRecord("p", 1, { x: 50, y: 60 }, { x: 150, y: 140 }, style("star"), vp)!;
    expect(plain.content!.shape).not.toHaveProperty("fill");
    expect(pdfPageDoc(stored([plain]), 1)!.shapes![0]).not.toHaveProperty("fill");
  });

  it("a filled shape the engine made is written to both forms with its fill", () => {
    const next = setPdfPageDoc(emptyMultiPageDoc(), 1, pageDoc([{ ...inkShape("n", "ellipse", [100, 100], [300, 200]), fill: "solid" }]), RATIO);
    expect(next.annotations?.[0]?.content?.shape?.fill).toBe("solid");
    expect(pdfPageDoc(next, 1)!.shapes![0]!.fill).toBe("solid");
  });
});

describe("a stored shape as a page shape", () => {
  it("older records (rectangle, circle, arrow) read as shapes in page units, at any zoom the same place", () => {
    const records = [
      shapeRecord("r", 1, { x: 100, y: 100 }, { x: 300, y: 220 }, style("rectangle"), vp)!,
      shapeRecord("c", 1, { x: 100, y: 300 }, { x: 200, y: 360 }, style("circle"), vp)!,
      shapeRecord("a", 1, { x: 400, y: 400 }, { x: 320, y: 340 }, style("arrow"), vp)!,
    ];
    const shapes = shapesAt(stored(records), 1, 1200); // zoomed to 2×
    const round = (p: number[]) => p.map((v) => Math.round(v * 1e6) / 1e6);
    // A box's record box is the outer edge of its 3 px line, so the corners are 1.5 px in at
    // the capture zoom (3 px at 2×: the line now scales with the page, like a pen stroke).
    expect(shapes.map((s) => [s.id, s.kind, round(s.start), round(s.end)])).toEqual([
      ["r", "rectangle", [203, 203], [597, 437]],
      ["c", "circle", [203, 603], [397, 717]],
      ["a", "arrow", [800, 800], [640, 680]],
    ]);
    expect(shapes[0]!.size * (1200 / INK_PAGE_UNITS)).toBeCloseTo(6, 9);
  });

  it("a record of a kind this version cannot draw is kept in the page and its record is not rewritten", () => {
    const future = shapeRecord("f", 1, { x: 10, y: 10 }, { x: 100, y: 100 }, style("rectangle"), vp)!;
    future.content!.shape!.shapeType = "spiral" as PdfShapeType;
    const doc = withUnits(stored([future]));
    expect(pdfPageDoc(doc, 1)!.shapes![0]!.kind).toBe("spiral");
    // an unrelated edit on the page keeps it, in both forms
    const next = setPdfPageDoc(doc, 1, structuredClone(pdfPageDoc(doc, 1)!), RATIO);
    expect(next.annotations).toEqual(doc.annotations);
    expect(next.pages[1]!.shapes).toEqual(doc.pages[1]!.shapes);
  });
});

describe("writing a page's shapes back", () => {
  it("a box shape's record box is the outer edge of its line, so an older app draws it in the same place", () => {
    const shape = inkShape("n1", "rectangle", [100, 100], [300, 220]); // 4 units line
    const doc = setPdfPageDoc(emptyMultiPageDoc(), 1, pageDoc([shape]), RATIO);
    expect(doc.annotations![0]!.position.boundingRect).toMatchObject({ x1: 98, y1: 98, x2: 302, y2: 222, width: 1000 });
  });

  it("a new shape becomes one record and one older page entry, once however often it is written", () => {
    const page = pageDoc([inkShape("n1", "star", [50, 60], [150, 140])]);
    const once = setPdfPageDoc(emptyMultiPageDoc(), 1, page, RATIO);
    const twice = setPdfPageDoc(once, 1, page, RATIO);
    expect(twice.annotations).toEqual(once.annotations);
    expect(once.annotations).toHaveLength(1);
    expect(once.annotations![0]).toMatchObject({ id: "n1", type: "shape", content: { shape: { shapeType: "star", strokeColor: "#c43c3c", strokeWidth: 4 } } });
    expect(once.pages[1]!.shapes).toHaveLength(1);
  });

  it("a shape the page loses (erased, or undone) takes its record and page entry with it; a later undo brings it back", () => {
    const shape = inkShape("n1", "diamond", [50, 60], [150, 140]);
    const added = setPdfPageDoc(emptyMultiPageDoc(), 1, pageDoc([shape]), RATIO);
    const removed = setPdfPageDoc(added, 1, pageDoc([]), RATIO);
    expect(removed.annotations).toEqual([]);
    expect(removed.pages[1]!.shapes).toEqual([]);
    const back = setPdfPageDoc(removed, 1, pageDoc([shape]), RATIO);
    expect(back.annotations!.map((a) => a.id)).toEqual(["n1"]);
  });

  it("a loaded shape the page still has is not rewritten; an erased one goes", () => {
    const rec = shapeRecord("r", 1, { x: 100, y: 100 }, { x: 300, y: 220 }, style("rectangle"), vp)!;
    const doc = withUnits(stored([rec]));
    const same = setPdfPageDoc(doc, 1, structuredClone(pdfPageDoc(doc, 1)!), RATIO);
    expect(same.annotations![0]).toBe(doc.annotations![0]);
    const erased = setPdfPageDoc(doc, 1, pageDoc([]), RATIO);
    expect(erased.annotations).toEqual([]);
  });

  it("shapes on other pages and other records are untouched", () => {
    const other = shapeRecord("p2", 2, { x: 10, y: 10 }, { x: 100, y: 100 }, style("rectangle"), vp)!;
    const doc = withUnits(stored([other]));
    const next = setPdfPageDoc(doc, 1, pageDoc([inkShape("n1", "line", [50, 60], [150, 140])]), RATIO);
    expect(next.annotations!.map((a) => a.id)).toEqual(["p2", "n1"]);
    expect(next.pages[2]!.shapes).toHaveLength(1);
  });

  it("the page signature changes when a shape comes or goes", () => {
    expect(pageSignature(pageDoc([]))).not.toBe(pageSignature(pageDoc([inkShape("n1", "line", [0, 0], [50, 50])])));
  });

  it("what is saved survives the codec and an older reader (shapes keep their kind and corners)", () => {
    const next = setPdfPageDoc(emptyMultiPageDoc(), 1, pageDoc([inkShape("n1", "roundedRectangle", [50, 60], [150, 140])]), RATIO);
    const decoded = decodePdfInk(JSON.stringify(next), null);
    expect(decoded.annotations![0]!.content!.shape!.shapeType).toBe("roundedRectangle");
    expect(decoded.units!.pages["pdf:1"]!.doc.shapes![0]).toMatchObject({ kind: "roundedRectangle", start: [50, 60], end: [150, 140] });
  });
});
