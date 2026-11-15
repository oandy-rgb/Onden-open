import { describe, expect, it } from "vitest";
import {
  addDrawingToPage,
  addShapeToPage,
  describeInkValueChange,
  diffMultiPage,
  emptyMultiPageDoc,
  drawingStrokesToInk,
  summarizeInkValue,
  type PdfDrawingStroke,
} from "../lib/pdf/pdfAdapter";
import { describeInkDiff, isEmptyInkDiff } from "../lib/ink/diff";

const libStroke = (n = 3): PdfDrawingStroke => ({
  points: Array.from({ length: n }, (_, i) => ({ x: i * 7, y: i * 3 })),
  color: "#7a2e33",
  width: 2.5,
});

describe("pdf ink adapter", () => {
  it("stored-stroke↔ink round-trips losslessly", () => {
    const lib = [libStroke(5), { ...libStroke(2), color: "#315f8f", width: 4 }];
    const ink = drawingStrokesToInk("h1", lib);
    expect(ink.map((s) => s.id)).toEqual(["h1:0", "h1:1"]);
    expect(ink.map((s) => s.points.map((p) => [p[0], p[1]]))).toEqual(lib.map((s) => s.points.map((p) => [p.x, p.y])));
  });

  it("a single-stroke gesture keeps the bare highlight id", () => {
    expect(drawingStrokesToInk("h9", [libStroke()])[0].id).toBe("h9");
  });

  it("addDrawingToPage accumulates per page without touching other pages", () => {
    let doc = emptyMultiPageDoc();
    doc = addDrawingToPage(doc, 1, "a", [libStroke()]);
    doc = addDrawingToPage(doc, 3, "b", [libStroke()]);
    doc = addDrawingToPage(doc, 1, "c", [libStroke()]);
    expect(doc.pages[1].strokes.map((s) => s.id)).toEqual(["a", "c"]);
    expect(doc.pages[3].strokes.map((s) => s.id)).toEqual(["b"]);
  });

  it("diffMultiPage reports gestures per page and reads as a gesture", () => {
    let prev = emptyMultiPageDoc();
    prev = addDrawingToPage(prev, 1, "a", [libStroke()]);
    let next = addDrawingToPage(prev, 1, "b", [libStroke()]);
    next = addDrawingToPage(next, 4, "c", [libStroke()]);
    const diffs = diffMultiPage(prev, next);
    expect(diffs[1].addedStrokes.map((s) => s.id)).toEqual(["b"]);
    expect(diffs[4].addedStrokes.map((s) => s.id)).toEqual(["c"]);
    expect(describeInkDiff(diffs[1])).toBe("drew 1 stroke");
  });

  it("diffMultiPage from null counts everything as drawn", () => {
    const next = addDrawingToPage(emptyMultiPageDoc(), 1, "a", [libStroke()]);
    const diffs = diffMultiPage(null, next);
    expect(diffs[1].addedStrokes).toHaveLength(1);
  });

  it("identical docs diff empty on every page", () => {
    const doc = addDrawingToPage(emptyMultiPageDoc(), 1, "a", [libStroke()]);
    const diffs = diffMultiPage(doc, doc);
    expect(Object.values(diffs).every(isEmptyInkDiff)).toBe(true);
  });

  it("shapes ride the same doc: add, diff", () => {
    let doc = emptyMultiPageDoc();
    doc = addShapeToPage(doc, 1, "r1", {
      shapeType: "rectangle", strokeColor: "#315f8f", strokeWidth: 2.5,
      startPoint: { x: 0.1, y: 0.2 }, endPoint: { x: 0.8, y: 0.9 },
    });
    expect(doc.pages[1].shapes).toHaveLength(1);
    const diffs = diffMultiPage(null, doc);
    expect(diffs[1].addedShapes.map((s) => s.kind)).toEqual(["rectangle"]);
    expect(describeInkDiff(diffs[1])).toBe("added 1 shape");
  });

  it("describeInkValueChange reads gestures across both formats", () => {
    const prev = addDrawingToPage(emptyMultiPageDoc(), 1, "a", [libStroke()]);
    const next = addDrawingToPage(prev, 2, "b", [libStroke()]);
    expect(describeInkValueChange(JSON.stringify(prev), JSON.stringify(next)))
      .toBe("p.2: drew 1 stroke");
    // single-page canvas doc
    const single = { version: 1, strokes: [], erased: {}, page: { width: 1000 } };
    const singleNext = { ...single, strokes: [{ id: "s", points: [[0, 0], [1, 1]], color: "#15130d", size: 3, toolId: "pen" }] };
    expect(describeInkValueChange(JSON.stringify(single), JSON.stringify(singleNext)))
      .toBe("drew 1 stroke");
    expect(describeInkValueChange(null, null)).toBe("no ink change");
    // a handwriting note of several pages: numbered as they read
    const sheet = (strokes: unknown[]) => ({ key: "u", background: { kind: "blank" }, size: { width: 1000, height: 1400 }, doc: { ...single, strokes } });
    const two = { ...single, morePages: { version: 1, pages: { u: sheet([]) } } };
    const twoNext = { ...singleNext, morePages: { version: 1, pages: { u: sheet(singleNext.strokes) } } };
    expect(describeInkValueChange(JSON.stringify(two), JSON.stringify(twoNext))).toBe("p.1: drew 1 stroke; p.2: drew 1 stroke");
    expect(summarizeInkValue(JSON.stringify(twoNext))).toBe("2 strokes on 2 pages");
  });

  it("summarizeInkValue totals strokes/shapes/pages", () => {
    let doc = addDrawingToPage(emptyMultiPageDoc(), 1, "a", [libStroke()]);
    doc = addDrawingToPage(doc, 3, "b", [libStroke()]);
    doc = addShapeToPage(doc, 3, "r", { shapeType: "arrow", strokeColor: "#315f8f", strokeWidth: 2 });
    expect(summarizeInkValue(JSON.stringify(doc))).toBe("2 strokes, 1 shape on 2 pages");
    expect(summarizeInkValue(JSON.stringify(emptyMultiPageDoc()))).toBe("empty");
    expect(summarizeInkValue("garbage")).toBe("empty");
  });

  it("describes highlight-only changes of an envelope instead of 'no ink change'", () => {
    const before = emptyMultiPageDoc();
    const after = { ...before, annotations: [{ id: "h1" }] as never };
    expect(describeInkValueChange(JSON.stringify(before), JSON.stringify(after))).toBe("added 1 highlight");
  });

  it("reports highlight changes alongside stroke changes in the same edit", () => {
    const before = emptyMultiPageDoc();
    const drawn = addDrawingToPage(before, 1, "d", [libStroke()]);
    const after = { ...drawn, annotations: [{ id: "d" }] as never };
    const summary = describeInkValueChange(JSON.stringify(before), JSON.stringify(after));
    expect(summary).toContain("p.1:");
    expect(summary).toContain("added 1 highlight");
  });
});
