import { describe, expect, it } from "vitest";
import { INK_SHAPE_KINDS, UNIFORM_TOOL_ID, encodeInk, inkToSvg, type InkDocument } from "./ink.js";

const page: InkDocument = {
  version: 1,
  erased: {},
  page: { width: 1000 },
  strokes: [
    { id: "a", color: "#1e1e1e", size: 4, toolId: "pen", points: [[10, 10], [60, 40], [120, 20]] },
    { id: "b", color: "#e03131", size: 3, toolId: "highlighter", points: [[30, 90], [200, 120]] },
  ],
};

describe("inkToSvg", () => {
  it("draws a stored drawing as a self-contained, sized <svg>", () => {
    const svg = inkToSvg(encodeInk(page))!;
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toMatch(/ width="\d+" height="\d+" viewBox="/);
    expect((svg.match(/<path /g) ?? []).length).toBe(2);
    expect(svg).toContain('fill-opacity="0.4"');
    expect(inkToSvg(page)).toBe(svg); // a decoded page renders the same
  });

  it("nothing to draw: null", () => {
    expect(inkToSvg(null)).toBeNull();
    expect(inkToSvg("not json")).toBeNull();
    expect(inkToSvg(encodeInk({ ...page, strokes: [] }))).toBeNull();
    expect(inkToSvg(encodeInk({ ...page, erased: { a: [[0, 2]], b: [[0, 1]] } }))).toBeNull();
    // a PDF's envelope is not a picture of its own
    expect(inkToSvg(JSON.stringify({ version: 1, pages: { 1: page } }))).toBeNull();
  });

  it("keeps a hostile colour out of the markup", () => {
    const svg = inkToSvg({ ...page, strokes: [{ ...page.strokes[0]!, color: 'red" onload="alert(1)' }] })!;
    expect(svg).not.toContain("onload");
    expect(svg).toContain('fill="#000"');
  });
});

describe("inkToSvg — a constant-width line (the tool of a PDF stroke saved before pressure was kept)", () => {
  const stroke = (toolId: string, extra: Partial<InkDocument["strokes"][number]> = {}) =>
    ({ id: "u", color: "#7a2e33", size: 10, toolId, points: [[10, 10], [110, 10], [210, 60]] as Array<[number, number]>, ...extra });
  const pathD = (toolId: string) => /<path d="([^"]+)"/.exec(inkToSvg({ ...page, strokes: [stroke(toolId)] })!)![1]!;
  const ys = (d: string) => [...d.matchAll(/(-?\d+\.\d) (-?\d+\.\d)/g)].map((m) => Number(m[2]));

  it("is exactly as wide as its size along a straight run, whatever the pointer's speed would say", () => {
    const d = pathD(UNIFORM_TOOL_ID);
    // the first leg is horizontal at y = 10: its two edges are 5 above and 5 below
    expect(Math.min(...ys(d).filter((y) => y < 20))).toBeCloseTo(5, 0);
    expect(Math.max(...ys(d).filter((y) => y < 20))).toBeCloseTo(15, 0);
  });

  it("is not the pen: no velocity-simulated thinning", () => {
    expect(pathD(UNIFORM_TOOL_ID)).not.toBe(pathD("pen"));
  });

  it("is deterministic, and a tool nobody knows still draws as a pen", () => {
    expect(pathD(UNIFORM_TOOL_ID)).toBe(pathD(UNIFORM_TOOL_ID));
    expect(pathD("pencil")).toBe(pathD("pen"));
  });
});

describe("inkToSvg — shapes", () => {
  const shapes: NonNullable<InkDocument["shapes"]> = [
    { id: "r", kind: "rectangle", start: [10, 10], end: [110, 60], color: "#2f9e44", size: 3 },
    { id: "c", kind: "circle", start: [200, 10], end: [260, 70], color: "#1971c2", size: 2 },
    { id: "a", kind: "arrow", start: [0, 200], end: [100, 200], color: "#e03131", size: 2 },
  ];
  const doc = (extra: Partial<InkDocument>): InkDocument => ({ ...page, ...extra });

  const outlines = (svg: string) => (svg.match(/<path d="[^"]*" fill="none" stroke=/g) ?? []).length;

  it("a filled shape tints its inside with its colour at the shared opacity; the outline stays full", () => {
    const svg = inkToSvg(doc({ shapes: [{ ...shapes[0]!, fill: "solid" }, { ...shapes[2]!, fill: "solid" }, { ...shapes[1]!, fill: "hatched" }] }))!;
    expect(svg).toMatch(/<path d="M[^"]*" fill="#2f9e44" fill-opacity="0.25" stroke="#2f9e44"/);
    // an arrow has no inside, and an unknown fill value draws as none: both as before
    expect(svg).toMatch(/<path d="M[^"]*" fill="none" stroke="#e03131"/);
    expect(svg).toMatch(/<path d="M[^"]*" fill="none" stroke="#1971c2"/);
    expect(inkToSvg(doc({ shapes }))).not.toContain("fill-opacity=\"0.25\"");
  });

  it("a hostile colour on a filled shape stays out of the markup", () => {
    const svg = inkToSvg(doc({ shapes: [{ ...shapes[0]!, fill: "solid", color: 'red" onload="alert(1)' }] }))!;
    expect(svg).not.toContain("onload");
  });

  it("draws rectangle, circle/ellipse and arrow with their colours", () => {
    const svg = inkToSvg(doc({ shapes }))!;
    expect(outlines(svg)).toBe(3);
    expect(svg).toMatch(/<path d="M[^"]*" fill="none" stroke="#e03131"/); // arrow shaft + head
    for (const c of ["#2f9e44", "#1971c2", "#e03131"]) expect(svg).toContain(`stroke="${c}"`);
  });

  it("draws every kind the shape button offers", () => {
    for (const kind of INK_SHAPE_KINDS) {
      const svg = inkToSvg(doc({ strokes: [], shapes: [{ id: kind, kind, start: [10, 10], end: [90, 70], color: "#123456", size: 3 }] }))!;
      expect(outlines(svg), kind).toBe(1);
    }
  });

  it("a drawing of shapes only is still a picture", () => {
    const svg = inkToSvg(doc({ strokes: [], shapes }))!;
    expect(outlines(svg)).toBe(3);
  });

  it("shapes are inside the content bounds", () => {
    const strokesOnly = inkToSvg(page)!;
    const withFar = inkToSvg(doc({ shapes: [{ id: "far", kind: "rectangle", start: [1000, 900], end: [1200, 1000], color: "#000", size: 2 }] }))!;
    const vb = (s: string) => s.match(/viewBox="([^"]+)"/)![1]!.split(" ").map(Number);
    expect(vb(withFar)[2]! + vb(withFar)[0]!).toBeGreaterThanOrEqual(1200);
    expect(vb(withFar)[3]! + vb(withFar)[1]!).toBeGreaterThanOrEqual(1000);
    expect(vb(strokesOnly)[2]! + vb(strokesOnly)[0]!).toBeLessThan(400);
  });

  it("keeps hostile colours out of the markup", () => {
    const svg = inkToSvg(doc({ shapes: [{ ...shapes[0]!, color: 'red" onload="alert(1)' }, { ...shapes[1]!, color: "url(javascript:alert(1))" }] }))!;
    expect(svg).not.toContain("onload");
    expect(svg).not.toContain("javascript");
    expect(svg).toContain('stroke="#000"');
  });

  it("skips an unknown kind without throwing, and ignores unknown fields", () => {
    const future = { id: "s", kind: "spiral", points: [[0, 0]], color: "#f00", size: 2, extra: '"><script>' } as unknown as NonNullable<InkDocument["shapes"]>[number];
    const svg = inkToSvg(doc({ shapes: [future, shapes[0]!] }))!;
    expect(svg).not.toContain("script");
    expect(svg).not.toContain("spiral");
    expect(outlines(svg)).toBe(1);
    // a stored value with a spiral parses and renders too
    expect(inkToSvg(JSON.stringify({ ...page, shapes: [future] }))).not.toBeNull();
  });

  it("is deterministic", () => {
    expect(inkToSvg(doc({ shapes }))).toBe(inkToSvg(doc({ shapes })));
  });

  it("an unknown toolId still renders (degraded to a pen)", () => {
    const svg = inkToSvg({ ...page, strokes: [{ ...page.strokes[0]!, toolId: "pencil" }] })!;
    expect(svg).toContain("<path ");
  });
});
