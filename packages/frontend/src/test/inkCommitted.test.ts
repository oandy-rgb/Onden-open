// Committed-renderer seam: the board's tiled Canvas 2D renderer fills the same
// polygon set as the handwriting page's, with the nonzero rule (a sharp V, a loop
// and a quick Z overlap themselves; evenodd or a triangulating fill would punch
// holes or fill them solid). Plus the React Flow transform math. jsdom has no 2D
// canvas, so the assertions run against recorded draw calls.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Canvas2dCommittedRenderer,
  createCommittedRenderer,
  type CommittedView,
  type ICommittedRenderer,
} from "../lib/ink/committed";
import { InkEngine } from "../lib/ink/engine";
import { visibleRuns } from "../lib/ink/erase";
import { flowInkTransform } from "../lib/ink/flowTransform";
import { strokeOutline } from "../lib/ink/outline";
import type { EraseInterval, ErasedIntervals, InkDocument, InkStroke } from "../lib/ink/types";

// ── Canvas2D capture: Path2D + 2d-context fakes (jsdom has neither) ─────────

class FakePath2D {
  pts: Array<[number, number]> = [];
  moveTo(x: number, y: number) { this.pts.push([x, y]); }
  lineTo(x: number, y: number) { this.pts.push([x, y]); }
  closePath() { /* polygon already complete */ }
}
// Globals are unstubbed after every test (test/setup.ts): stub per test.
beforeEach(() => { vi.stubGlobal("Path2D", FakePath2D); });

type CtxSink = { polys: Array<Array<[number, number]>>; transforms: number[][]; rules: Array<string | undefined> };

function canvasWithRecordingCtx(sink: CtxSink): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const ctx = {
    save() {}, restore() {},
    setTransform(...args: number[]) { sink.transforms.push(args); },
    clearRect() {},
    drawImage() {},
    fill(p: FakePath2D, rule?: string) { sink.polys.push(p.pts); sink.rules.push(rule); },
    fillStyle: "",
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(canvas, "getContext").mockReturnValue(ctx as never);
  return canvas;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function fixtureStrokes(): { strokes: InkStroke[]; erased: ErasedIntervals } {
  const strokes: InkStroke[] = [
    {
      id: "s1",
      points: [[10, 10], [20, 12], [35, 18], [50, 30], [70, 45], [90, 55]],
      color: "#15130d", size: 4, toolId: "pen",
    },
    {
      id: "s2",
      points: [[5, 80], [40, 82], [80, 85]],
      color: "#c2871d", size: 4, toolId: "highlighter",
    },
  ];
  const erased: ErasedIntervals = { s1: [[2, 3] as EraseInterval] };
  return { strokes, erased };
}

/** The reference polygon set — what BOTH renderers must fill. */
function expectedPolygons(strokes: InkStroke[], erased: ErasedIntervals): number[][] {
  const out: number[][] = [];
  for (const stroke of strokes) {
    for (const [a, b] of visibleRuns(stroke.points.length, erased[stroke.id])) {
      const outline = strokeOutline(stroke.points.slice(a, b + 1), stroke, true);
      if (outline.length < 3) continue;
      out.push(outline.flat());
    }
  }
  return out;
}

const VIEW: CommittedView = { dark: false, scale: 1, offsetX: 0, offsetY: 0, dpr: 1 };

// ── IRenderer contract: identical polygon set from both backends ────────────

describe("ICommittedRenderer contract", () => {
  it("canvas2d fills exactly the engine's visible-run polygons", () => {
    const { strokes, erased } = fixtureStrokes();
    const sink: CtxSink = { polys: [], transforms: [], rules: [] };
    const renderer = new Canvas2dCommittedRenderer(canvasWithRecordingCtx(sink));
    renderer.commitStrokes(strokes, erased, VIEW);
    expect(sink.polys.map((p) => p.flat())).toEqual(expectedPolygons(strokes, erased));
  });

  it("canvas2d honors the view transform (scale × dpr, offset pan)", () => {
    const { strokes, erased } = fixtureStrokes();
    const sink: CtxSink = { polys: [], transforms: [], rules: [] };
    const renderer = new Canvas2dCommittedRenderer(canvasWithRecordingCtx(sink));
    renderer.commitStrokes(strokes, erased, { dark: false, scale: 2, offsetX: 30, offsetY: -10, dpr: 2 });
    // last setTransform before painting: [s, 0, 0, s, ox·dpr, oy·dpr]
    expect(sink.transforms.at(-1)).toEqual([4, 0, 0, 4, 60, -20]);
  });
});

// ── The whiteboard's renderer ────────────────────────────────────────────────

/** Strokes whose outline crosses itself: a sharp V, a circle closing on itself, a quick Z. */
function selfCrossingStrokes(): InkStroke[] {
  const base = { color: "#15130d", size: 6, toolId: "pen" } as const;
  const circle: Array<[number, number]> = Array.from({ length: 40 }, (_, k) => {
    const t = (k / 39) * Math.PI * 2 * 1.05;
    return [200 + Math.cos(t) * 30, 40 + Math.sin(t) * 30];
  });
  return [
    { ...base, id: "v", points: [[10, 10], [40, 70], [41, 10]] },
    { ...base, id: "circle", points: circle },
    { ...base, id: "z", points: [[100, 10], [160, 12], [102, 60], [165, 62], [101, 20]] },
  ];
}

describe("createCommittedRenderer (the whiteboard)", () => {
  it("builds a tiled Canvas 2D renderer on a canvas it owns", () => {
    const container = document.createElement("div");
    const renderer = createCommittedRenderer({ container, cssWidth: 50, cssHeight: 50, dpr: 2 });
    expect(renderer.kind).toBe("canvas2d");
    const canvas = container.querySelector("canvas")!;
    expect(canvas.width).toBe(100); // css × dpr backing store
    expect(canvas.height).toBe(100);
    renderer.destroy();
    expect(container.querySelector("canvas")).toBeNull(); // owned canvas removed
  });

  it("fills V, loop and Z strokes with the same polygons and the nonzero rule, as the handwriting page does", () => {
    const strokes = selfCrossingStrokes();
    const page: CtxSink = { polys: [], transforms: [], rules: [] };
    new Canvas2dCommittedRenderer(canvasWithRecordingCtx(page)).commitStrokes(strokes, {}, VIEW);

    const board: CtxSink = { polys: [], transforms: [], rules: [] };
    const canvas = canvasWithRecordingCtx(board);
    const ctx = canvas.getContext("2d")!;
    // jsdom has no OffscreenCanvas: tiles are drawn on the same recording context.
    const renderer = new Canvas2dCommittedRenderer(canvas, { tiled: true, tileFactory: () => ({ canvas, ctx }) });
    renderer.resize(300, 120, 1);
    renderer.commitStrokes(strokes, {}, VIEW);

    expect(page.polys.map((p) => p.flat())).toEqual(expectedPolygons(strokes, {}));
    // The tiled board paints each polygon once per tile it touches; every one is a page polygon.
    const pagePolys = new Set(page.polys.map((p) => JSON.stringify(p)));
    expect(board.polys.length).toBeGreaterThanOrEqual(page.polys.length);
    for (const poly of board.polys) expect(pagePolys.has(JSON.stringify(poly))).toBe(true);
    for (const rule of [...page.rules, ...board.rules]) expect([undefined, "nonzero"]).toContain(rule);
  });
});

// ── React Flow viewport → InkTransform math ──────────────────────────────────

describe("flowInkTransform", () => {
  it("inverts screen = model·zoom + offset", () => {
    const t = flowInkTransform(() => ({ x: 100, y: 50, zoom: 2 }));
    expect(t.toDoc(100, 50)).toEqual([0, 0]);   // viewport origin → model origin
    expect(t.toDoc(300, 250)).toEqual([100, 100]);
    expect(t.scale()).toBe(2);
    expect(t.offset()).toEqual([100, 50]);
  });

  it("stays live: reads the viewport at call time, not capture time", () => {
    let vp = { x: 0, y: 0, zoom: 1 };
    const t = flowInkTransform(() => vp);
    expect(t.toDoc(10, 10)).toEqual([10, 10]);
    vp = { x: -40, y: 20, zoom: 0.5 };
    expect(t.toDoc(10, 10)).toEqual([100, -20]);
    expect(t.scale()).toBe(0.5);
  });
});

// ── Engine ↔ injected renderer ───────────────────────────────────────────────

describe("InkEngine with an injected committed renderer", () => {
  function stubRenderer() {
    const calls: Array<{ strokeCount: number; view: CommittedView }> = [];
    const renderer: ICommittedRenderer = {
      kind: "canvas2d",
      commitStrokes(strokes, _erased, view) { calls.push({ strokeCount: strokes.length, view }); },
      setView() {},
      resize() {},
      destroy() {},
    };
    return { renderer, calls };
  }

  function docWithOneStroke(): InkDocument {
    return {
      version: 1,
      strokes: [{ id: "a", points: [[0, 0], [10, 10]], color: "#15130d", size: 4, toolId: "pen" }],
      erased: {},
      page: { width: 1000 },
    };
  }

  it("routes commits through the renderer with the transform's scale/offset view", () => {
    const { renderer, calls } = stubRenderer();
    const wet = document.createElement("canvas");
    const engine = new InkEngine({
      committedRenderer: renderer,
      wetCanvas: wet,
      transform: flowInkTransform(() => ({ x: 100, y: 50, zoom: 2 })),
      manageCanvasSize: false,
    });
    engine.load(docWithOneStroke());
    expect(calls.length).toBeGreaterThan(0);
    const last = calls.at(-1)!;
    expect(last.strokeCount).toBe(1);
    expect(last.view.scale).toBe(2);
    expect(last.view.offsetX).toBe(100);
    expect(last.view.offsetY).toBe(50);
    engine.destroy();
  });

  it("manageCanvasSize:false never touches host-owned surface sizes", () => {
    const { renderer } = stubRenderer();
    const wet = document.createElement("canvas");
    wet.width = 777; wet.height = 333;
    const engine = new InkEngine({
      committedRenderer: renderer,
      wetCanvas: wet,
      manageCanvasSize: false,
    });
    engine.load(docWithOneStroke());
    expect(wet.width).toBe(777);
    expect(wet.height).toBe(333);
    engine.destroy();
  });

  it("dark-mode toggle re-commits with view.dark", () => {
    const { renderer, calls } = stubRenderer();
    const engine = new InkEngine({
      committedRenderer: renderer,
      wetCanvas: document.createElement("canvas"),
      manageCanvasSize: false,
    });
    engine.load(docWithOneStroke());
    engine.setDarkMode(true);
    expect(calls.at(-1)!.view.dark).toBe(true);
    engine.destroy();
  });

  it("throws without any committed surface", () => {
    expect(() => new InkEngine({ wetCanvas: document.createElement("canvas") }))
      .toThrow(/committedCanvas or a committedRenderer/);
  });
});
