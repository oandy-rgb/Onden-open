import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PdfPageHighlights } from "../components/pdf/PdfHighlights";
import { PageInkSvg } from "../pagebook";

// What PdfNodeView gives the page picture: the page's height in units, from its viewport.
const heightOf = (viewport: { width: number; height: number }) => (1000 * viewport.height) / viewport.width;
import { withUnits } from "../lib/pdf/pageUnits";
import type { PdfHighlightRecord } from "../lib/pdf/coords";

// Render-path verification for the stored format: records exactly as the
// retired lib persisted them (and as our capture now produces them) must
// come out as positioned DOM at the current zoom.

const vp = { width: 1200, height: 1600 }; // page rendered at 2x capture scale

const textRecord: PdfHighlightRecord = {
  id: "t1",
  type: "text",
  content: { text: "quote" },
  position: {
    boundingRect: { x1: 10, y1: 700, x2: 110, y2: 724, width: 600, height: 800, pageNumber: 1 },
    rects: [
      { x1: 10, y1: 700, x2: 110, y2: 712, width: 600, height: 800, pageNumber: 1 },
      { x1: 10, y1: 712, x2: 80, y2: 724, width: 600, height: 800, pageNumber: 1 },
    ],
  },
};

// Legacy quirk: old alt+drag area selects were saved as type:"text" with NO
// line rects — the lib rendered them invisibly; we fall back to the bbox.
const legacyAreaAsText: PdfHighlightRecord = {
  id: "t2",
  type: "text",
  content: { image: "data:image/png;base64,xyz" },
  position: {
    boundingRect: { x1: 50, y1: 50, x2: 150, y2: 100, width: 600, height: 800, pageNumber: 1 },
    rects: [],
  },
};

const drawingRecordFixture: PdfHighlightRecord = {
  id: "d1",
  type: "drawing",
  content: {
    strokes: [{ points: [{ x: 5, y: 5 }, { x: 55, y: 35 }], color: "#7a2e33", width: 2.5 }],
    frame: { w: 60, h: 40 },
  },
  position: {
    boundingRect: { x1: 95, y1: 95, x2: 155, y2: 135, width: 600, height: 800, pageNumber: 1 },
    rects: [],
  },
};

// Pre-unification drawing: no frame stored — recovered from stroke extents.
const legacyDrawing: PdfHighlightRecord = {
  id: "d2",
  type: "drawing",
  content: {
    strokes: [{ points: [{ x: 10, y: 10 }, { x: 30, y: 20 }], color: "#7a2e33", width: 2.5 }],
  },
  position: {
    boundingRect: { x1: 0, y1: 0, x2: 30, y2: 20, width: 600, height: 800, pageNumber: 1 },
    rects: [],
  },
};

const arrowRecord: PdfHighlightRecord = {
  id: "s1",
  type: "shape",
  content: {
    shape: {
      shapeType: "arrow",
      strokeColor: "#315f8f",
      strokeWidth: 2.5,
      startPoint: { x: 0, y: 1 },
      endPoint: { x: 1, y: 0 },
    },
  },
  position: {
    boundingRect: { x1: 100, y1: 100, x2: 200, y2: 150, width: 600, height: 800, pageNumber: 1 },
    rects: [],
  },
};

const otherPage: PdfHighlightRecord = {
  ...textRecord,
  id: "t9",
  position: {
    ...textRecord.position,
    boundingRect: { ...textRecord.position.boundingRect, pageNumber: 2 },
  },
};

describe("PdfPageHighlights", () => {
  it("renders text line rects scaled to the current viewport", () => {
    const { container } = render(
      <PdfPageHighlights highlights={[textRecord]} pageNumber={1} viewport={vp} />,
    );
    const parts = container.querySelectorAll(".pdf-hl-part");
    expect(parts).toHaveLength(2);
    const first = parts[0] as HTMLElement;
    // 2x viewport doubles capture-time px.
    expect(first.style.getPropertyValue("--pdf-hl-left")).toBe("20px");
    expect(first.style.getPropertyValue("--pdf-hl-top")).toBe("1400px");
    expect(first.style.getPropertyValue("--pdf-hl-width")).toBe("200px");
    expect(first.style.getPropertyValue("--pdf-hl-height")).toBe("24px");
  });

  it("renders only the requested page", () => {
    const { container } = render(
      <PdfPageHighlights highlights={[textRecord, otherPage]} pageNumber={2} viewport={vp} />,
    );
    expect(container.querySelectorAll(".pdf-hl")).toHaveLength(1);
  });

  it("falls back to the bounding box for legacy rect-less text records", () => {
    const { container } = render(
      <PdfPageHighlights highlights={[legacyAreaAsText]} pageNumber={1} viewport={vp} />,
    );
    const parts = container.querySelectorAll(".pdf-hl-part");
    expect(parts).toHaveLength(1);
    expect((parts[0] as HTMLElement).style.getPropertyValue("--pdf-hl-left")).toBe("100px");
    expect((parts[0] as HTMLElement).style.getPropertyValue("--pdf-hl-width")).toBe("200px");
  });

  it("draws no drawing or shape record: they are the older form of the page's own strokes and shapes", () => {
    const { container } = render(
      <PdfPageHighlights highlights={[drawingRecordFixture, arrowRecord, textRecord]} pageNumber={1} viewport={vp} />,
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelectorAll(".pdf-hl-part")).toHaveLength(2); // the text rects only
  });

  it("survives a JSON persistence round-trip unchanged", () => {
    const stored = JSON.parse(JSON.stringify([textRecord, drawingRecordFixture, arrowRecord]));
    expect(stored).toEqual([textRecord, drawingRecordFixture, arrowRecord]);
  });
});

// The page's drawing: older records read as page units (lib/pdf/pageUnits), then
// drawn with the shared static geometry into a viewBox 1000 wide.
describe("PageInkSvg on a PDF page", () => {
  const pageOf = (records: PdfHighlightRecord[], erased: Record<string, Array<[number, number]>> = {}) => {
    const env = withUnits({ version: 1, pages: erased ? { 1: { version: 1, strokes: [], erased, page: { width: 1000 } } } : {}, annotations: records });
    return env.units!.pages["pdf:1"]!.doc;
  };
  const view = (records: PdfHighlightRecord[], erased?: Record<string, Array<[number, number]>>, viewport = vp) =>
    render(<PageInkSvg doc={pageOf(records, erased)} heightUnits={heightOf(viewport)} />).container;

  it("scales with the page: the viewBox is 1000 wide and as tall as the page's ratio says", () => {
    const svg = view([drawingRecordFixture]).querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 1000 1333.3333333333333");
    expect(svg.getAttribute("class")).toBe("page-ink-svg");
  });

  it("older strokes (no tool named) keep their uniform line: a filled round line of their width", () => {
    const container = view([drawingRecordFixture]);
    const path = container.querySelector("path")!;
    expect(path.getAttribute("fill")).toBe("#7a2e33");
    expect(path.getAttribute("d")).toMatch(/^M .* Q .* Z$/);
    // the line is 2.5 px wide at capture: 2.5·1000/600 units, so it spans that across the stroke
    const ys = [...path.getAttribute("d")!.matchAll(/(-?\d+\.\d) (-?\d+\.\d)/g)].map((m) => Number(m[2]));
    const width = Math.max(...ys) - Math.min(...ys);
    expect(width).toBeGreaterThan((2.5 * 1000) / 600);
  });

  const pressured = (toolId: string, pressure: number[]): PdfHighlightRecord => ({
    ...drawingRecordFixture,
    id: "p1",
    content: {
      strokes: [{
        points: pressure.map((p, i) => ({ x: 5 + i * 10, y: 20, p })),
        color: "#315f8f", width: 4, toolId,
      }],
      frame: { w: 60, h: 40 },
    },
  });

  it("strokes that name their tool are filled outlines, the pen at full opacity", () => {
    const path = view([pressured("pen", [0.2, 0.9, 0.9, 0.2])]).querySelector("path")!;
    expect(path.getAttribute("fill")).toBe("#315f8f");
    expect(path.getAttribute("stroke")).toBeNull();
    expect(path.getAttribute("d")).toMatch(/^M .* Q .* Z$/);
    expect(path.getAttribute("fill-opacity")).toBeNull();
  });

  it("pressure changes the shape of the outline", () => {
    const outline = (pressure: number[]) => view([pressured("pen", pressure)]).querySelector("path")!.getAttribute("d");
    expect(outline([0.1, 0.1, 0.1, 0.1])).not.toBe(outline([0.9, 0.9, 0.9, 0.9]));
  });

  it("the highlighter is translucent", () => {
    expect(view([pressured("highlighter", [0.5, 0.5, 0.5])]).querySelector("path")!.getAttribute("fill-opacity")).toBe("0.45");
  });

  it("erased spans are left out", () => {
    const record = pressured("pen", [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(view([record]).querySelectorAll("path")).toHaveLength(1);
    expect(view([record], { p1: [[2, 3]] }).querySelectorAll("path")).toHaveLength(2); // the two surviving runs
    expect(view([record], { p1: [[0, 5]] }).querySelector("path")).toBeNull(); // erased whole
  });

  it("a drawing recorded without a frame (before frames existed) is drawn where it was", () => {
    expect(view([legacyDrawing]).querySelectorAll("path")).toHaveLength(1);
  });

  it("draws shapes from the shape geometry: an arrow's shaft, then its head", () => {
    const container = view([arrowRecord]);
    const path = container.querySelector("path")!;
    expect(path.getAttribute("stroke")).toBe("#315f8f");
    expect(path.getAttribute("fill")).toBe("none");
    // the arrow runs from the box's bottom-left to its top-right, in page units (×1000/600)
    expect(path.getAttribute("d")!.startsWith("M 166.7 250.0 L 333.3 166.7 M ")).toBe(true);
  });

  it("a filled shape has a translucent inside of its line colour; an arrow never fills", () => {
    const shape = { id: "s", start: [100, 100] as [number, number], end: [300, 200] as [number, number], color: "#c43c3c", size: 4, fill: "solid" };
    const { container } = render(<PageInkSvg doc={{ version: 1, strokes: [], erased: {}, page: { width: 1000 }, shapes: [{ ...shape, kind: "ellipse" }, { ...shape, id: "a", kind: "arrow" }] }} heightUnits={heightOf(vp)} />);
    const [ellipse, arrow] = Array.from(container.querySelectorAll("path"));
    expect(ellipse!.getAttribute("fill")).toBe("#c43c3c");
    expect(Number(ellipse!.getAttribute("fill-opacity"))).toBeGreaterThan(0);
    expect(Number(ellipse!.getAttribute("fill-opacity"))).toBeLessThan(1);
    expect(arrow!.getAttribute("fill")).toBe("none");
  });

  it("draws nothing for a page with no strokes or shapes", () => {
    const { container } = render(<PageInkSvg doc={{ version: 1, strokes: [], erased: {}, page: { width: 1000 } }} heightUnits={heightOf(vp)} />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
