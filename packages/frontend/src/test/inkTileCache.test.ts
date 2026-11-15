// Tiled committed strokes: scrolling copies cached tiles, and a change repaints
// only the tiles it touches. jsdom has no 2D canvas, so tiles and the main
// canvas are recording fakes; what is asserted is WHICH tiles get painted.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Canvas2dCommittedRenderer, ZOOM_SETTLE_MS, type CommittedView } from "../lib/ink/committed";
import { MAX_TILE_PIXELS, TILE_PX, TileCache, tileBudget, type TileSurface } from "../lib/ink/tileCache";
import { InkEngine } from "../lib/ink/engine";
import type { ErasedIntervals, InkDocument, InkStroke } from "../lib/ink/types";

class FakePath2D {
  moveTo() {}
  lineTo() {}
  closePath() {}
}

function recordingCtx() {
  const calls = { fills: 0, draws: [] as number[][], transforms: [] as number[][] };
  const ctx = {
    save() {}, restore() {},
    setTransform(...args: number[]) { calls.transforms.push(args); },
    clearRect() {},
    fill() { calls.fills += 1; },
    drawImage(_img: unknown, ...args: number[]) { calls.draws.push(args); },
    fillStyle: "",
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const SIZE = 1000; // 2 × 2 visible tiles at scale 1
const VIEW: CommittedView = { dark: false, scale: 1, offsetX: 0, offsetY: 0, dpr: 1 };

function setup(options: { noTiles?: boolean } = {}) {
  const main = recordingCtx();
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getContext").mockReturnValue(main.ctx as never);
  canvas.width = SIZE;
  canvas.height = SIZE;
  // Counts assignments: writing width / height clears a real canvas.
  let sizeWrites = 0;
  let width = SIZE, height = SIZE;
  Object.defineProperty(canvas, "width", { get: () => width, set: (v: number) => { width = v; sizeWrites += 1; } });
  Object.defineProperty(canvas, "height", { get: () => height, set: (v: number) => { height = v; sizeWrites += 1; } });

  /** Origin (device px) of every tile painted so far, in paint order. */
  const painted: Array<[number, number]> = [];
  const renderer = new Canvas2dCommittedRenderer(canvas, {
    tiled: true,
    tileFactory: (): TileSurface | null => {
      if (options.noTiles) return null;
      const { ctx } = recordingCtx();
      // A tile paint is clearRect then the document transform; surfaces are reused, so watch every paint.
      let armed = false;
      ctx.clearRect = (() => { armed = true; }) as never;
      ctx.setTransform = ((...args: number[]) => {
        if (armed) painted.push([0 - args[4]! + 0, 0 - args[5]! + 0]);
        armed = false;
      }) as never;
      return { canvas: {} as CanvasImageSource, ctx };
    },
  });
  return { renderer, canvas, main, painted, sizeWrites: () => sizeWrites };
}

const stroke = (id: string, x: number, y: number): InkStroke => ({
  id, color: "#15130d", size: 4, toolId: "pen",
  points: [[x, y], [x + 10, y + 3], [x + 20, y + 5], [x + 30, y + 6]],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Path2D", FakePath2D);
});
afterEach(() => { vi.useRealTimers(); });

describe("tiled committed strokes", () => {
  it("paints each visible tile once; scrolling inside them paints nothing", () => {
    const { renderer, main, painted } = setup();
    renderer.commitStrokes([stroke("a", 100, 100), stroke("b", 700, 700)], {}, VIEW);
    expect(painted).toEqual([[0, 0], [512, 0], [0, 512], [512, 512]]);
    expect(main.calls.draws).toHaveLength(4);
    expect(main.calls.fills).toBe(0); // nothing filled on the visible canvas itself

    painted.length = 0;
    main.calls.draws.length = 0;
    for (const y of [-5, -12, -20]) renderer.setView({ ...VIEW, offsetY: y });
    expect(painted).toEqual([]);
    expect(main.calls.draws.length).toBeGreaterThan(0);
  });

  it("scrolling to a new row paints only the tiles not cached yet", () => {
    const { renderer, painted } = setup();
    renderer.commitStrokes([stroke("a", 100, 100)], {}, VIEW);
    painted.length = 0;
    renderer.setView({ ...VIEW, offsetY: -600 }); // rows 1..3 visible; 2 and 3 are new
    expect(painted).toEqual([[0, 1024], [512, 1024], [0, 1536], [512, 1536]]);
  });

  it("a new stroke repaints only the tiles it touches", () => {
    const { renderer, painted } = setup();
    const a = stroke("a", 100, 100);
    renderer.commitStrokes([a], {}, VIEW);
    painted.length = 0;
    renderer.commitStrokes([a, stroke("b", 700, 100)], {}, VIEW);
    expect(painted).toEqual([[512, 0]]);
  });

  it("a stroke across a tile edge repaints both tiles", () => {
    const { renderer, painted } = setup();
    renderer.commitStrokes([], {}, VIEW);
    painted.length = 0;
    renderer.commitStrokes([stroke("edge", 495, 100)], {}, VIEW);
    expect(painted.sort()).toEqual([[0, 0], [512, 0]]);
  });

  it("erasing part of a stroke and restoring it repaint that stroke's tiles only", () => {
    const { renderer, painted } = setup();
    const a = stroke("a", 100, 100);
    const b = stroke("b", 700, 700);
    renderer.commitStrokes([a, b], {}, VIEW);
    painted.length = 0;
    const erased: ErasedIntervals = { b: [[0, 1]] };
    renderer.commitStrokes([a, b], erased, VIEW);
    expect(painted).toEqual([[512, 512]]);
    painted.length = 0;
    renderer.commitStrokes([a, b], {}, VIEW); // undo
    expect(painted).toEqual([[512, 512]]);
  });

  it("removing a stroke (undo) repaints the tiles it was on", () => {
    const { renderer, painted } = setup();
    const a = stroke("a", 100, 100);
    const b = stroke("b", 100, 700);
    renderer.commitStrokes([a, b], {}, VIEW);
    painted.length = 0;
    renderer.commitStrokes([a], {}, VIEW);
    expect(painted).toEqual([[0, 512]]);
  });

  it("an unchanged commit repaints nothing", () => {
    const { renderer, painted } = setup();
    const a = stroke("a", 100, 100);
    renderer.commitStrokes([a], {}, VIEW);
    painted.length = 0;
    renderer.commitStrokes([a], {}, VIEW);
    expect(painted).toEqual([]);
  });

  it("switching theme repaints every visible tile", () => {
    const { renderer, painted } = setup();
    renderer.commitStrokes([stroke("a", 100, 100)], {}, VIEW);
    painted.length = 0;
    renderer.setView({ ...VIEW, dark: true });
    expect(painted).toHaveLength(4);
  });

  it("a device pixel ratio change repaints every visible tile", () => {
    const { renderer, painted } = setup();
    renderer.commitStrokes([stroke("a", 100, 100)], {}, VIEW);
    painted.length = 0;
    renderer.setView({ ...VIEW, dpr: 2 });
    expect(painted.length).toBeGreaterThan(0);
  });

  it("zooming stretches the old tiles, then repaints at the new scale once it pauses", () => {
    const { renderer, painted, main } = setup();
    renderer.commitStrokes([stroke("a", 100, 100)], {}, VIEW);
    painted.length = 0;
    main.calls.draws.length = 0;

    renderer.setView({ ...VIEW, scale: 1.1 });
    renderer.setView({ ...VIEW, scale: 1.2 });
    expect(painted).toEqual([]);
    expect(main.calls.draws.length).toBeGreaterThan(0);
    // stretched: tile (0,0) is drawn 1.2× larger
    expect(main.calls.draws.at(-1)).toContain(Math.round(TILE_PX * 1.2));

    vi.advanceTimersByTime(ZOOM_SETTLE_MS - 1);
    expect(painted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(painted.length).toBeGreaterThan(0);
    // painted at 1.2 × 512 doc units per tile edge
    painted.length = 0;
    renderer.setView({ ...VIEW, scale: 1.2, offsetY: -3 });
    expect(painted).toEqual([]);
  });

  it("a scroll never rewrites the canvas size; resize rewrites it only when it changed", () => {
    const { renderer, sizeWrites } = setup();
    renderer.commitStrokes([stroke("a", 100, 100)], {}, VIEW);
    for (let y = 0; y > -240; y--) renderer.setView({ ...VIEW, offsetY: y });
    expect(sizeWrites()).toBe(0);
    renderer.resize(SIZE, SIZE, 1);
    expect(sizeWrites()).toBe(0);
    renderer.resize(SIZE + 10, SIZE, 1);
    expect(sizeWrites()).toBe(1);
  });

  it("paints directly when no tile surface exists", () => {
    const { renderer, main } = setup({ noTiles: true });
    renderer.commitStrokes([stroke("a", 100, 100)], {}, VIEW);
    expect(main.calls.fills).toBe(1);
    expect(main.calls.draws).toHaveLength(0);
  });

  it("paints directly when the view needs more tiles than the budget", () => {
    const { renderer, main, painted } = setup();
    renderer.commitStrokes([stroke("a", 100, 100)], {}, { ...VIEW, scale: 0.02 }); // far zoomed out: still 4 tiles
    expect(painted.length).toBeGreaterThan(0);
    // a stretched view of 40 × 40 tiles is over the budget
    renderer.setView({ ...VIEW, scale: 0.02 / 20 });
    expect(main.calls.fills).toBeGreaterThan(0);
  });

  it("does not repaint after destroy", () => {
    const { renderer, painted } = setup();
    renderer.commitStrokes([stroke("a", 100, 100)], {}, VIEW);
    painted.length = 0;
    renderer.destroy();
    expect(painted).toEqual([]);
  });
});

describe("tile surfaces", () => {
  it("reuses the surfaces of dropped tiles instead of making new canvases", () => {
    let made = 0;
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(recordingCtx().ctx as never);
    canvas.width = SIZE; canvas.height = SIZE;
    const renderer = new Canvas2dCommittedRenderer(canvas, {
      tiled: true,
      tileFactory: () => { made += 1; return { canvas: {} as CanvasImageSource, ctx: recordingCtx().ctx }; },
    });
    renderer.commitStrokes([stroke("a", 100, 100)], {}, VIEW);
    const first = made;
    for (let y = 0; y > -6000; y -= 40) renderer.setView({ ...VIEW, offsetY: y });
    // ~12 rows scrolled through, 2 tiles each: surfaces made stay at the budget (+1: the first eviction happens as the tile past it is stored)
    expect(made).toBeLessThanOrEqual(tileBudget(SIZE, SIZE) + 1);
    expect(made).toBeGreaterThan(first);
  });
});

describe("InkEngine camera moves", () => {
  function engineWith(strokeCount: number) {
    const commits: number[] = [];
    let views = 0;
    const renderer = {
      kind: "canvas2d" as const,
      commitStrokes: (strokes: ReadonlyArray<InkStroke>) => { commits.push(strokes.length); },
      setView: () => { views += 1; },
      resize() {}, destroy() {},
    };
    const wet = document.createElement("canvas");
    wet.width = 300; wet.height = 200;
    const engine = new InkEngine({ committedRenderer: renderer, wetCanvas: wet, manageCanvasSize: false });
    const doc: InkDocument = {
      version: 1, erased: {}, page: { width: 1000 },
      strokes: Array.from({ length: strokeCount }, (_, i) => stroke(`s${i}`, i, 10)),
    };
    engine.load(doc);
    return { engine, commits, views: () => views, wet };
  }

  it("a scroll frame moves the camera only: strokes are not collected and committed again", () => {
    const { engine, commits, views } = engineWith(5);
    const before = commits.length;
    for (let i = 0; i < 30; i++) engine.viewChanged();
    expect(commits.length).toBe(before);
    expect(views()).toBe(30);
  });

  it("a scroll frame leaves an empty wet canvas alone", () => {
    const { engine, wet } = engineWith(1);
    const ctx = recordingCtx();
    const clears = vi.fn();
    vi.spyOn(wet, "getContext").mockReturnValue({ ...ctx.ctx, clearRect: clears } as never);
    for (let i = 0; i < 10; i++) engine.viewChanged();
    expect(clears).not.toHaveBeenCalled();
  });

  it("engine-owned canvases keep their size across scroll frames", () => {
    const committed = document.createElement("canvas");
    const wet = document.createElement("canvas");
    let writes = 0;
    for (const c of [committed, wet]) {
      let w = 0;
      Object.defineProperty(c, "width", { get: () => w, set: (v: number) => { w = v; writes += 1; } });
    }
    const engine = new InkEngine({ committedCanvas: committed, wetCanvas: wet });
    engine.setDisplayWidth(500);
    const afterSetup = writes;
    for (let i = 0; i < 20; i++) engine.viewChanged();
    expect(writes).toBe(afterSetup);
  });
});

describe("TileCache", () => {
  const surface = (): TileSurface => ({ canvas: {} as CanvasImageSource, ctx: {} as CanvasRenderingContext2D });

  it("evicts the oldest tiles but never the ones used in the current frame", () => {
    const cache = new TileCache();
    cache.capacity = 3;
    cache.put(0, 0, surface(), 1);
    cache.put(1, 0, surface(), 1);
    cache.put(2, 0, surface(), 2);
    cache.put(3, 0, surface(), 3);
    expect(cache.size).toBe(3);
    expect(cache.has(0, 0)).toBe(false); // oldest went
    cache.put(4, 0, surface(), 3);
    cache.put(5, 0, surface(), 3);
    expect(cache.has(3, 0) && cache.has(4, 0) && cache.has(5, 0)).toBe(true);
  });

  it("invalidate drops only tiles whose pixels meet the box", () => {
    const cache = new TileCache();
    cache.capacity = 10;
    for (const [i, j] of [[0, 0], [1, 0], [0, 1], [2, 2]] as const) cache.put(i, j, surface(), 1);
    cache.invalidate([10, 10, 20, 20], 1);
    expect(cache.has(0, 0)).toBe(false);
    expect(cache.has(1, 0) && cache.has(0, 1) && cache.has(2, 2)).toBe(true);
  });

  it("the budget grows with the viewport but stays under the pixel cap", () => {
    expect(tileBudget(1000, 1000)).toBe(12);
    expect(tileBudget(20000, 20000) * TILE_PX * TILE_PX).toBeLessThanOrEqual(MAX_TILE_PIXELS);
  });
});
