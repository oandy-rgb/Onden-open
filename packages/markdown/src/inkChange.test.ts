import { describe, it, expect } from "vitest";
import { encodeInk, inkChangeSummary, inkChangeView, inkToSvg, type InkDocument, type InkEnvelope, type InkShape, type InkStroke } from "./ink.js";

const stroke = (id: string, n = 6): InkStroke => ({
  id, points: Array.from({ length: n }, (_, i) => [i * 10, i * 5] as [number, number]), color: "#123456", size: 2, toolId: "pen",
});
const shape = (id: string): InkShape => ({ id, kind: "rectangle", start: [0, 0], end: [50, 50], color: "#654321", size: 2 });
const page = (strokes: InkStroke[], erased: InkDocument["erased"] = {}, shapes: InkShape[] = []): InkDocument =>
  ({ version: 1, strokes, erased, page: { width: 1000 }, ...(shapes.length ? { shapes } : {}) });
const pdf = (pages: Record<number, InkDocument>): InkEnvelope => ({ version: 1, pages });
const enc = encodeInk;
const strokes = (n: number, from = 0) => Array.from({ length: n }, (_, i) => stroke(`s${from + i}`));

describe("inkChangeSummary", () => {
  it("counts strokes drawn since the earlier save", () => {
    expect(inkChangeSummary(enc(page(strokes(3))), enc(page(strokes(15))))).toEqual({ added: 12, erased: 0 });
  });

  it("counts everything as drawn when there is no earlier save", () => {
    expect(inkChangeSummary(null, enc(page(strokes(4))))).toEqual({ added: 4, erased: 0 });
    expect(inkChangeSummary("not json", enc(page(strokes(2))))).toEqual({ added: 2, erased: 0 });
  });

  it("counts a stroke taken out whole as erased", () => {
    expect(inkChangeSummary(enc(page(strokes(5))), enc(page(strokes(2))))).toEqual({ added: 0, erased: 3 });
  });

  it("counts a partly erased stroke once however many spans were erased", () => {
    const before = page(strokes(3));
    const after = page(strokes(3), { s0: [[0, 1], [3, 4]], s1: [[2, 2]] });
    expect(inkChangeSummary(enc(before), enc(after))).toEqual({ added: 0, erased: 2 });
  });

  it("does not count spans that were already erased, nor a stroke drawn and erased within the change", () => {
    const before = page(strokes(2), { s0: [[0, 1]] });
    const after = page([...strokes(2), stroke("s9")], { s0: [[0, 1]], s9: [[0, 2]] });
    expect(inkChangeSummary(enc(before), enc(after))).toEqual({ added: 1, erased: 0 });
  });

  it("counts shapes like strokes", () => {
    const before = page([], {}, [shape("a"), shape("b")]);
    const after = page([], {}, [shape("b"), shape("c"), shape("d")]);
    expect(inkChangeSummary(enc(before), enc(after))).toEqual({ added: 2, erased: 1 });
  });

  it("adds up the pages of a PDF note", () => {
    const before = pdf({ 1: page(strokes(2)), 2: page(strokes(1)) });
    const after = pdf({ 1: page(strokes(5)), 2: page([]), 3: page(strokes(2, 10)) });
    expect(inkChangeSummary(enc(before), enc(after))).toEqual({ added: 5, erased: 1 });
  });

  it("is zero for the same drawing or two unreadable values", () => {
    const same = enc(page(strokes(3)));
    expect(inkChangeSummary(same, same)).toEqual({ added: 0, erased: 0 });
    expect(inkChangeSummary(null, null)).toEqual({ added: 0, erased: 0 });
  });
});

describe("a handwriting note of several pages", () => {
  const sheet = (key: string, d: InkDocument) => ({ key, background: { kind: "blank" }, size: { width: 1000, height: 1400 }, doc: d });
  const note = (first: InkStroke[], second: InkStroke[]): InkDocument => ({ ...page(first), morePages: { version: 1, pages: { u: sheet("u", page(second)) } } });
  it("counts every page, and shows the page that changed most", () => {
    const before = enc(note(strokes(1), strokes(1, 10)));
    const after = enc(note(strokes(2), strokes(4, 10)));
    expect(inkChangeSummary(before, after)).toEqual({ added: 4, erased: 0 });
    expect(inkChangeView(before, after)!.strokes.map((s) => s.id)).toEqual(["s11", "s12", "s13"]);
  });
});

describe("inkChangeView", () => {
  it("draws only the change: new strokes in their colour, erased ones pale grey, the rest left out", () => {
    const before = page([stroke("keep"), stroke("gone")]);
    const after = page([stroke("keep"), stroke("new")]);
    const view = inkChangeView(enc(before), enc(after))!;
    expect(view.strokes.map((s) => [s.id, s.color])).toEqual([["gone", expect.stringContaining("rgba")], ["new", "#123456"]]);
    expect(inkToSvg(view)).toContain("<svg");
  });

  it("shows a partly erased stroke as it was before", () => {
    const before = page([stroke("a")], { a: [[0, 1]] });
    const after = page([stroke("a")], { a: [[0, 3]] });
    const view = inkChangeView(enc(before), enc(after))!;
    expect(view.strokes.map((s) => s.id)).toEqual(["a"]);
    expect(view.erased).toEqual({ a: [[0, 1]] });
  });

  it("keeps the erasure of a stroke that was drawn in the change", () => {
    const view = inkChangeView(enc(page([])), enc(page([stroke("n")], { n: [[0, 1]] })))!;
    expect(view.erased).toEqual({ n: [[0, 1]] });
  });

  it("includes changed shapes", () => {
    const view = inkChangeView(enc(page([], {}, [shape("old")])), enc(page([], {}, [shape("new")])))!;
    expect(view.shapes!.map((s) => s.id)).toEqual(["old", "new"]);
    expect(view.shapes![0]!.color).toContain("rgba");
  });

  it("picks the PDF page that changed most", () => {
    const before = pdf({ 1: page([]), 2: page([]) });
    const after = pdf({ 1: page(strokes(1)), 2: page(strokes(3, 5)) });
    expect(inkChangeView(enc(before), enc(after))!.strokes).toHaveLength(3);
  });

  it("is null when nothing changed", () => {
    const same = enc(page(strokes(2)));
    expect(inkChangeView(same, same)).toBeNull();
  });
});
