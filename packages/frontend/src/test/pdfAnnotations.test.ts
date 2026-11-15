import { describe, expect, it } from "vitest";
import {
  boundingRectOf,
  scaledPositionToViewport,
  scaledToViewport,
  viewportToScaled,
  type PdfHighlightRecord,
  type Scaled,
} from "../lib/pdf/coords";
import {
  areaRecord,
  clientRectsToPageRects,
  drawingFramePadding,
  drawingRecord,
  mergeLineRects,
  shapeRecord,
  textSelectionPosition,
  type PageRef,
} from "../lib/pdf/capture";
import { addDrawingToPage, emptyMultiPageDoc } from "../lib/pdf/pdfAdapter";

const vp = (width: number, height: number) => ({ width, height });

// ── Scaled coordinate math (the stored-format contract) ─────────────────────

describe("pdf scaled coords", () => {
  it("viewport→scaled→viewport round-trips exactly at the capture scale", () => {
    const rect = { left: 50, top: 80, width: 120, height: 14, pageNumber: 3 };
    const viewport = vp(800, 1000);
    const back = scaledToViewport(viewportToScaled(rect, viewport), viewport);
    expect(back).toEqual(rect);
  });

  it("rects scale linearly with the viewport (zoom invariance)", () => {
    const rect = { left: 50, top: 80, width: 120, height: 14, pageNumber: 1 };
    const scaled = viewportToScaled(rect, vp(800, 1000));
    const zoomed = scaledToViewport(scaled, vp(1600, 2000));
    expect(zoomed.left).toBeCloseTo(100);
    expect(zoomed.top).toBeCloseTo(160);
    expect(zoomed.width).toBeCloseTo(240);
    expect(zoomed.height).toBeCloseTo(28);
  });

  it("renders a legacy lib-era record identically (oracle math)", () => {
    // A record exactly as react-pdf-highlighter-plus stored it: viewport px
    // at capture zoom + the page viewport it was measured against.
    const legacy: Scaled = {
      x1: 90, y1: 200, x2: 210, y2: 215, width: 612, height: 792, pageNumber: 2,
    };
    const current = vp(918, 1188); // same page at 1.5x
    const r = scaledToViewport(legacy, current);
    // Lib formula: current.width * x / stored.width.
    expect(r.left).toBeCloseTo((918 * 90) / 612);
    expect(r.top).toBeCloseTo((1188 * 200) / 792);
    expect(r.width).toBeCloseTo((918 * (210 - 90)) / 612);
    expect(r.height).toBeCloseTo((1188 * (215 - 200)) / 792);
    expect(r.pageNumber).toBe(2);
  });

  it("honours usePdfCoordinates via convertToViewportRectangle", () => {
    const viewport = {
      width: 100,
      height: 100,
      // Fake PDF→viewport: flip y around 100, scale x by 2.
      convertToViewportRectangle: (r: number[]) => [r[0] * 2, 100 - r[1], r[2] * 2, 100 - r[3]],
    };
    const scaled: Scaled = { x1: 10, y1: 90, x2: 20, y2: 80, width: 50, height: 50, pageNumber: 1 };
    const r = scaledToViewport(scaled, viewport, true);
    expect(r).toEqual({ left: 20, top: 10, width: 20, height: 10, pageNumber: 1 });
  });

  it("scaledPositionToViewport converts boundingRect and every line rect", () => {
    const viewport = vp(1000, 1000);
    const mk = (left: number) => viewportToScaled({ left, top: 10, width: 50, height: 10, pageNumber: 1 }, vp(500, 500));
    const out = scaledPositionToViewport({ boundingRect: mk(10), rects: [mk(10), mk(70)] }, viewport);
    expect(out.boundingRect.left).toBeCloseTo(20);
    expect(out.rects.map((r) => r.left)).toEqual([20, 140]);
  });
});

// ── Selection rect capture ───────────────────────────────────────────────────

describe("pdf selection capture", () => {
  const pages: PageRef[] = [
    { number: 1, rect: { left: 100, top: 50, width: 600, height: 800 } },
    { number: 2, rect: { left: 100, top: 860, width: 600, height: 800 } },
  ];

  it("rebases client rects to page-local px and assigns page numbers", () => {
    const rects = clientRectsToPageRects(
      [
        { left: 150, top: 100, width: 200, height: 12 }, // page 1
        { left: 150, top: 900, width: 100, height: 12 }, // page 2
      ],
      pages,
    );
    expect(rects).toEqual([
      { left: 50, top: 50, width: 200, height: 12, pageNumber: 1 },
      { left: 50, top: 40, width: 100, height: 12, pageNumber: 2 },
    ]);
  });

  it("drops rects outside any page, zero-sized, or page-sized (containers)", () => {
    const rects = clientRectsToPageRects(
      [
        { left: 0, top: 0, width: 50, height: 10 }, // outside
        { left: 150, top: 100, width: 0, height: 10 }, // zero width
        { left: 100, top: 50, width: 600, height: 800 }, // the page itself
      ],
      pages,
    );
    expect(rects).toEqual([]);
  });

  it("merges per-span fragments of one selected line", () => {
    const line = (left: number, width: number) => ({ left, top: 100, width, height: 12, pageNumber: 1 });
    const merged = mergeLineRects([
      line(10, 40),
      line(52, 30), // 2px gap → same line, merge
      line(20, 10), // contained → dropped
      { ...line(10, 40) }, // duplicate → deduped
      { left: 10, top: 130, width: 40, height: 12, pageNumber: 1 }, // next line stays
    ]);
    expect(merged).toEqual([
      { left: 10, top: 100, width: 72, height: 12, pageNumber: 1 },
      { left: 10, top: 130, width: 40, height: 12, pageNumber: 1 },
    ]);
  });

  it("textSelectionPosition clamps to the first page and stores line rects", () => {
    const rects = [
      { left: 10, top: 700, width: 100, height: 12, pageNumber: 1 },
      { left: 10, top: 20, width: 80, height: 12, pageNumber: 2 }, // spill → dropped
    ];
    const pos = textSelectionPosition(rects, vp(600, 800));
    expect(pos).not.toBeNull();
    expect(pos!.rects).toHaveLength(1);
    expect(pos!.boundingRect.pageNumber).toBe(1);
    // Round-trip: stored → rendered at 2x viewport doubles everything.
    const r = scaledToViewport(pos!.rects[0], vp(1200, 1600));
    expect(r).toEqual({ left: 20, top: 1400, width: 200, height: 24, pageNumber: 1 });
  });

  it("boundingRectOf unions rects", () => {
    const b = boundingRectOf([
      { left: 10, top: 10, width: 10, height: 10, pageNumber: 1 },
      { left: 40, top: 30, width: 20, height: 5, pageNumber: 1 },
    ]);
    expect(b).toEqual({ left: 10, top: 10, width: 50, height: 25, pageNumber: 1 });
  });
});

// ── Drawing capture (frame semantics shared with legacy records) ────────────

describe("pdf drawing capture", () => {
  const stroke = (pts: Array<[number, number]>, width = 2.5) => ({
    points: pts.map(([x, y]) => ({ x, y })),
    color: "#7a2e33",
    width,
  });

  it("pads the stroke bbox by maxStrokeWidth×2 and stores frame-local points", () => {
    const rec = drawingRecord("d1", 1, [stroke([[100, 100], [150, 130]])], vp(600, 800));
    expect(rec).not.toBeNull();
    const pad = drawingFramePadding([stroke([[0, 0]])]); // 2.5 * 2 = 5
    expect(pad).toBe(5);
    expect(rec!.content?.frame).toEqual({ w: 50 + 2 * pad, h: 30 + 2 * pad });
    // Points rebased to the padded min corner: first point sits at (pad, pad).
    expect(rec!.content?.strokes?.[0].points[0]).toEqual({ x: pad, y: pad });
    // Position = the padded bbox in capture-viewport px, tagged with the
    // capture viewport.
    expect(rec!.position.boundingRect).toEqual({
      x1: 95, y1: 95, x2: 155, y2: 135, width: 600, height: 800, pageNumber: 1,
    });
  });

  it("clamps the frame at the page origin (top-left strokes)", () => {
    const rec = drawingRecord("d2", 1, [stroke([[2, 2], [10, 10]])], vp(600, 800));
    const b = rec!.position.boundingRect;
    expect(b.x1).toBe(0);
    expect(b.y1).toBe(0);
    // Frame stays consistent with the clamped origin: the first point lands
    // at its true offset (2), not at the pad.
    expect(rec!.content?.strokes?.[0].points[0]).toEqual({ x: 2, y: 2 });
  });

  it("round-trips: a stored frame point lands on the same page px at any zoom", () => {
    const capture = vp(600, 800);
    const rec = drawingRecord("d3", 1, [stroke([[100, 100], [200, 160]])], capture)!;
    // Serialize exactly like persistence does — shape must survive JSON.
    const stored = JSON.parse(JSON.stringify(rec)) as PdfHighlightRecord;
    const frame = stored.content!.frame!;
    const pt = stored.content!.strokes![0].points[0]; // frame-local
    // Render math (PdfInkStrokes): rect = scaledToViewport(bbox), then the
    // SVG maps viewBox(frame) → rect, i.e. px = rect.left + x * rect.w/frame.w.
    for (const zoom of [1, 2, 0.5]) {
      const r = scaledToViewport(stored.position.boundingRect, vp(600 * zoom, 800 * zoom));
      const px = r.left + (pt.x * r.width) / frame.w;
      const py = r.top + (pt.y * r.height) / frame.h;
      expect(px).toBeCloseTo(100 * zoom);
      expect(py).toBeCloseTo(100 * zoom);
    }
  });

  it("returns null for an empty gesture", () => {
    expect(drawingRecord("d4", 1, [], vp(600, 800))).toBeNull();
  });

  it("the same strokes feed the ink doc unchanged (one gesture group)", () => {
    const strokes = [stroke([[100, 100], [150, 130]]), stroke([[10, 10], [20, 20]])];
    const doc = addDrawingToPage(emptyMultiPageDoc(), 1, "g1", strokes);
    expect(doc.pages[1].strokes.map((s) => s.id)).toEqual(["g1:0", "g1:1"]);
    expect(doc.pages[1].strokes[0].points[0]).toEqual([100, 100]);
  });
});

// ── Shape + area capture ─────────────────────────────────────────────────────

describe("pdf shape/area capture", () => {
  it("builds a shape record with the dragged bbox", () => {
    const rec = shapeRecord(
      "s1", 2, { x: 30, y: 40 }, { x: 130, y: 90 },
      { shapeType: "rectangle", strokeColor: "#315f8f", strokeWidth: 2.5 },
      vp(600, 800),
    );
    expect(rec!.type).toBe("shape");
    expect(rec!.content?.shape).toEqual({ shapeType: "rectangle", strokeColor: "#315f8f", strokeWidth: 2.5 });
    expect(rec!.position.boundingRect).toMatchObject({ x1: 30, y1: 40, x2: 130, y2: 90, pageNumber: 2 });
  });

  it("arrows remember direction as bbox fractions (drag up-left)", () => {
    const rec = shapeRecord(
      "s2", 1, { x: 100, y: 80 }, { x: 20, y: 20 },
      { shapeType: "arrow", strokeColor: "#315f8f", strokeWidth: 2.5 },
      vp(600, 800),
    );
    expect(rec!.content?.shape?.startPoint).toEqual({ x: 1, y: 1 });
    expect(rec!.content?.shape?.endPoint).toEqual({ x: 0, y: 0 });
  });

  it("rejects sub-10px shape drags and sub-8px area drags", () => {
    const tiny = shapeRecord("s3", 1, { x: 0, y: 0 }, { x: 9, y: 100 },
      { shapeType: "circle", strokeColor: "#315f8f", strokeWidth: 2.5 }, vp(600, 800));
    expect(tiny).toBeNull();
    expect(areaRecord("a1", 1, { left: 5, top: 5, width: 3, height: 50 }, vp(600, 800))).toBeNull();
    // An Alt-click that twitched a few px is not an area (unification audit R4).
    expect(areaRecord("a1", 1, { left: 5, top: 5, width: 7, height: 50 }, vp(600, 800))).toBeNull();
    expect(areaRecord("a1", 1, { left: 5, top: 5, width: 8, height: 8 }, vp(600, 800))).not.toBeNull();
  });

  it("area records store the bbox only — no screenshot payload", () => {
    const rec = areaRecord("a2", 1, { left: 10, top: 20, width: 100, height: 50 }, vp(600, 800))!;
    expect(rec.type).toBe("area");
    expect(rec.content).toEqual({});
    expect(rec.position.rects).toEqual([]);
    expect(rec.position.boundingRect).toMatchObject({ x1: 10, y1: 20, x2: 110, y2: 70 });
  });
});
