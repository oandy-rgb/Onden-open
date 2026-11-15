// T1-1 through the real InkEngine pointer pipeline: the input policy's
// actions reach the drawing, the host's gesture callbacks and the undo stack.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkEngine, type InkGestureHost, type InkEngineOptions } from "../lib/ink/engine";
import type { ICommittedRenderer } from "../lib/ink/committed";
import { PALM_GRACE_MS } from "../lib/ink/inputPolicy";
import { pageInkTransform, pageLayout, type PageCamera } from "../lib/ink/pageZoom";

function stubRenderer(): ICommittedRenderer {
  return { kind: "canvas2d", commitStrokes() {}, setView() {}, resize() {}, destroy() {} };
}

type Kind = "pen" | "touch" | "mouse";
function pointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  o: { id: number; kind: Kind; x?: number; y?: number; t: number },
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, {
    pointerId: o.id, pointerType: o.kind, button: 0,
    clientX: o.x ?? 0, clientY: o.y ?? 0, pressure: 0.5, getCoalescedEvents: () => [],
  });
  Object.defineProperty(e, "timeStamp", { value: o.t });
  return e;
}

function setup(extra: Partial<InkEngineOptions> = {}, withGestures = true) {
  const el = document.createElement("div");
  Object.assign(el, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
  document.body.appendChild(el);
  const gestures = { pan: vi.fn(), zoom: vi.fn(), fling: vi.fn() } satisfies InkGestureHost;
  const engine = new InkEngine({
    committedRenderer: stubRenderer(),
    wetCanvas: document.createElement("canvas"),
    manageCanvasSize: false,
    ...(withGestures ? { gestures } : {}),
    ...extra,
  });
  const dispose = engine.addPointerHandlers(el);
  const fire = (type: Parameters<typeof pointer>[0], o: Parameters<typeof pointer>[1]) => el.dispatchEvent(pointer(type, o));
  const stroke = (id: number, kind: Kind, t: number, pts: Array<[number, number]>) => {
    fire("pointerdown", { id, kind, x: pts[0][0], y: pts[0][1], t });
    pts.slice(1).forEach(([x, y], i) => fire("pointermove", { id, kind, x, y, t: t + 10 * (i + 1) }));
    const [lx, ly] = pts[pts.length - 1];
    fire("pointerup", { id, kind, x: lx, y: ly, t: t + 10 * pts.length });
  };
  return { engine, el, gestures, fire, stroke, dispose };
}

describe("InkEngine finger / pen split", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("no pen: a finger draws a stroke", () => {
    const { engine, stroke } = setup();
    stroke(1, "touch", 0, [[10, 10], [40, 30], [80, 30]]);
    expect(engine.serialize().strokes).toHaveLength(1);
  });

  it("with the Hand tool, a one-finger drag pans instead of drawing", () => {
    const { engine, gestures, stroke, fire } = setup();
    stroke(1, "pen", 0, [[10, 10], [30, 30]]);
    engine.setTool("hand");
    const t = 1000 + PALM_GRACE_MS;
    fire("pointerdown", { id: 2, kind: "touch", x: 100, y: 400, t });
    fire("pointermove", { id: 2, kind: "touch", x: 100, y: 300, t: t + 20 });
    fire("pointerup", { id: 2, kind: "touch", x: 100, y: 300, t: t + 500 });
    expect(gestures.pan).toHaveBeenCalledWith(0, -100);
    expect(engine.serialize().strokes).toHaveLength(1);
  });

  it("stylus mode: a drawing tool's one-finger drag pans, the pen still draws", () => {
    const { engine, gestures, stroke, fire } = setup({ stylusOnly: true });
    fire("pointerdown", { id: 2, kind: "touch", x: 100, y: 400, t: 0 });
    fire("pointermove", { id: 2, kind: "touch", x: 100, y: 300, t: 20 });
    fire("pointerup", { id: 2, kind: "touch", x: 100, y: 300, t: 500 });
    expect(gestures.pan).toHaveBeenCalledWith(0, -100);
    stroke(3, "pen", 2000, [[10, 10], [30, 30]]);
    expect(engine.serialize().strokes).toHaveLength(1);
    engine.setInputPrefs({ stylusOnly: false });
    stroke(4, "touch", 4000, [[10, 60], [30, 80]]);
    expect(engine.serialize().strokes).toHaveLength(2);
  });

  it("Hand tool → back to a pen tool: the finger draws again", () => {
    const { engine, stroke } = setup();
    engine.setTool("hand");
    stroke(1, "touch", 0, [[10, 10], [40, 30]]);
    expect(engine.serialize().strokes).toHaveLength(0);
    engine.setTool("pen");
    stroke(2, "touch", 1000, [[10, 10], [40, 30]]);
    expect(engine.serialize().strokes).toHaveLength(1);
  });

  it("a second finger cancels the finger stroke (nothing saved) and zooms", () => {
    const onChange = vi.fn();
    const { engine, gestures, fire } = setup({ onChange, changeDebounceMs: 0 });
    fire("pointerdown", { id: 1, kind: "touch", x: 100, y: 100, t: 0 });
    fire("pointermove", { id: 1, kind: "touch", x: 104, y: 100, t: 10 });
    fire("pointerdown", { id: 2, kind: "touch", x: 200, y: 100, t: 20 });
    fire("pointermove", { id: 2, kind: "touch", x: 300, y: 100, t: 40 });
    fire("pointerup", { id: 1, kind: "touch", x: 104, y: 100, t: 400 });
    fire("pointerup", { id: 2, kind: "touch", x: 300, y: 100, t: 410 });
    engine.flush();
    expect(engine.serialize().strokes).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(gestures.zoom).toHaveBeenCalled();
    const [factor] = gestures.zoom.mock.calls[0];
    expect(factor).toBeCloseTo(196 / 96, 5);
  });

  it("a two-finger tap undoes and a three-finger tap redoes", () => {
    const { engine, stroke, fire } = setup();
    stroke(1, "touch", 0, [[10, 10], [40, 30]]);
    stroke(2, "touch", 100, [[10, 60], [40, 90]]);
    expect(engine.serialize().strokes).toHaveLength(2);

    fire("pointerdown", { id: 3, kind: "touch", x: 300, y: 300, t: 1000 });
    fire("pointerdown", { id: 4, kind: "touch", x: 360, y: 300, t: 1010 });
    fire("pointerup", { id: 3, kind: "touch", t: 1100 });
    fire("pointerup", { id: 4, kind: "touch", t: 1110 });
    expect(engine.serialize().strokes).toHaveLength(1);

    for (const [i, id] of [5, 6, 7].entries()) fire("pointerdown", { id, kind: "touch", x: 300 + 50 * i, y: 300, t: 2000 + i });
    for (const id of [5, 6, 7]) fire("pointerup", { id, kind: "touch", t: 2100 });
    expect(engine.serialize().strokes).toHaveLength(2);
  });

  it("read-only: fingers still pan, nothing draws and taps don't undo", () => {
    const { engine, gestures, fire, stroke } = setup();
    engine.load({ version: 1, strokes: [{ id: "a", points: [[1, 1], [2, 2]], color: "#000", size: 2, toolId: "pen" }], erased: {}, page: { width: 1000 }, requires: ["future"] } as never);
    expect(engine.readOnly).toBe(true);
    stroke(1, "pen", 0, [[10, 10], [30, 80]]);
    fire("pointerdown", { id: 2, kind: "touch", x: 10, y: 400, t: 1000 });
    fire("pointermove", { id: 2, kind: "touch", x: 10, y: 300, t: 1020 });
    fire("pointerup", { id: 2, kind: "touch", x: 10, y: 300, t: 1500 });
    fire("pointerdown", { id: 3, kind: "touch", x: 300, y: 300, t: 3000 });
    fire("pointerdown", { id: 4, kind: "touch", x: 360, y: 300, t: 3010 });
    fire("pointerup", { id: 3, kind: "touch", t: 3100 });
    fire("pointerup", { id: 4, kind: "touch", t: 3110 });
    expect(gestures.pan).toHaveBeenCalled();
    expect(engine.serialize().strokes.map((s) => s.id)).toEqual(["a"]);
  });

  it("without a gesture host (PDF) touch after a pen is still ignored entirely", () => {
    const { engine, stroke } = setup({}, false);
    stroke(1, "pen", 0, [[10, 10], [30, 30]]);
    stroke(2, "touch", 5000, [[100, 100], [140, 140]]);
    expect(engine.serialize().strokes).toHaveLength(1);
  });
});

describe("InkEngine on the zoomed handwriting page", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const camera = (zoom: number, scrollTop: number): PageCamera => ({
    viewportWidth: 824, viewportHeight: 600, pageWidth: 1000, pageHeight: 1400,
    zoom, scrollLeft: 0, scrollTop,
  });

  it("stores strokes in document coordinates whatever the zoom", () => {
    const cam = camera(2, 400);
    const { engine, stroke } = setup({ growPage: true, transform: pageInkTransform(() => cam) });
    const l = pageLayout(cam);
    const at = (x: number, y: number): [number, number] => [l.pageLeft + x * l.scale, l.pageTop - cam.scrollTop + y * l.scale];
    stroke(1, "mouse", 0, [at(100, 300), at(200, 320)]);
    const [p0, p1] = engine.serialize().strokes[0].points;
    expect(p0[0]).toBeCloseTo(100, 6);
    expect(p0[1]).toBeCloseTo(300, 6);
    expect(p1[0]).toBeCloseTo(200, 6);
    expect(p1[1]).toBeCloseTo(320, 6);
  });

  it("a stroke can't start in the gutter outside the page", () => {
    const cam = camera(0.5, 0);
    const { engine, stroke } = setup({ growPage: true, transform: pageInkTransform(() => cam) });
    stroke(1, "mouse", 0, [[5, 50], [60, 80]]); // x=5 is left of the centred page
    expect(engine.serialize().strokes).toHaveLength(0);
  });

  it("drawing near the bottom grows the page (also when zoomed)", () => {
    const cam = camera(3, 0);
    const heights: number[] = [];
    const { engine, stroke } = setup({
      growPage: true, transform: pageInkTransform(() => cam), onPageHeightChange: (h) => heights.push(h),
    });
    engine.load(null);
    const l = pageLayout(cam);
    const y = (docY: number) => l.pageTop + docY * l.scale;
    stroke(1, "mouse", 0, [[100, y(1300)], [120, y(1390)]]);
    expect(engine.getPageSize().height).toBeGreaterThan(1400);
    expect(heights.at(-1)).toBe(engine.getPageSize().height);
  });
});

describe("InkEngine below the page bottom (phone: a finger keeps drawing)", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  // 390 px phone, 115 % zoom, scrolled so the paper's bottom edge is mid-screen.
  const cam: PageCamera = {
    viewportWidth: 390, viewportHeight: 600, pageWidth: 1000, pageHeight: 1400,
    zoom: 1.15, scrollLeft: 0, scrollTop: 0,
  };
  const belowBottom = () => {
    const l = pageLayout(cam);
    return { l, y: l.pageTop + 1400 * l.scale + 80 - cam.scrollTop };
  };

  it("REGRESSION: a finger starting below the old page bottom draws (and the page grows) instead of panning", () => {
    // Scroll so 80 css px past the paper's bottom is on screen.
    const l0 = pageLayout(cam);
    cam.scrollTop = l0.pageTop + 1400 * l0.scale - 400;
    const heights: number[] = [];
    const { engine, gestures, stroke } = setup({
      growPage: true, transform: pageInkTransform(() => cam), onPageHeightChange: (h) => heights.push(h),
    });
    const { l, y } = belowBottom();
    const x = l.pageLeft + 200 * l.scale;
    stroke(1, "touch", 0, [[x, y], [x + 30, y + 20], [x + 60, y + 10]]);
    expect(gestures.pan).not.toHaveBeenCalled();
    expect(engine.serialize().strokes).toHaveLength(1);
    expect(engine.getPageSize().height).toBeGreaterThan(1400);
  });
});
