// Shapes in the ink engine: the shape tool, the eraser, undo / redo, and
// "draw, then hold still" through the real pointer pipeline.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkEngine } from "../lib/ink/engine";
import type { ICommittedRenderer } from "../lib/ink/committed";
import { InkModel } from "../lib/ink/model";
import type { InkDocument, InkStroke } from "../lib/ink/types";

const drawn: InkStroke[][] = [];
const renderer = (): ICommittedRenderer => ({
  kind: "canvas2d", commitStrokes(strokes) { drawn.push([...strokes]); }, setView() {}, resize() {}, destroy() {},
});

function setup(options: { autoShape?: boolean } = {}) {
  const el = document.createElement("div");
  Object.assign(el, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
  document.body.appendChild(el);
  const engine = new InkEngine({
    committedRenderer: renderer(), wetCanvas: document.createElement("canvas"), manageCanvasSize: false,
    gestures: { pan() {}, zoom() {} },
  });
  engine.addPointerHandlers(el);
  engine.setAutoShape(options.autoShape ?? false);
  let t = 0;
  const fire = (type: string, id: number, x: number, y: number, kind = "mouse") => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { pointerId: id, pointerType: kind, button: 0, buttons: 1, clientX: x, clientY: y, pressure: 0.5, getCoalescedEvents: () => [] });
    Object.defineProperty(e, "timeStamp", { value: (t += 10) });
    el.dispatchEvent(e);
  };
  const down = (x: number, y: number, kind = "mouse") => fire("pointerdown", 1, x, y, kind);
  const move = (x: number, y: number, kind = "mouse") => fire("pointermove", 1, x, y, kind);
  const up = (x: number, y: number, kind = "mouse") => fire("pointerup", 1, x, y, kind);
  const trace = (pts: Array<[number, number]>, kind = "mouse") => { down(...pts[0]!, kind); pts.slice(1).forEach(([x, y]) => move(x, y, kind)); };
  return { engine, trace, down, move, up };
}

const rectangle = (): Array<[number, number]> => {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= 20; i++) pts.push([100 + i * 10, 100]);
  for (let i = 1; i <= 12; i++) pts.push([300, 100 + i * 10]);
  for (let i = 1; i <= 20; i++) pts.push([300 - i * 10, 220]);
  for (let i = 1; i <= 12; i++) pts.push([100, 220 - i * 10]);
  return pts;
};

beforeEach(() => {
  drawn.length = 0;
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the shape tool", () => {
  it("a drag makes one shape of the chosen kind, in the pen colour and width", () => {
    const { engine, trace, up } = setup();
    engine.setTool("shape");
    engine.setShapeKind("diamond");
    engine.setColor("#315f8f");
    engine.setSize(4);
    trace([[50, 60], [120, 100], [200, 160]]);
    up(200, 160);
    const { shapes, strokes } = engine.serialize();
    expect(strokes).toHaveLength(0);
    expect(shapes).toHaveLength(1);
    expect(shapes![0]).toMatchObject({ kind: "diamond", start: [50, 60], end: [200, 160], color: "#315f8f", size: 1 + 4 * 1.2 });
    // and it is on the committed surface as strokes the renderers can draw
    expect(drawn.at(-1)!.length).toBeGreaterThan(0);
  });

  it("a tap makes nothing", () => {
    const { engine, down, up } = setup();
    engine.setTool("shape");
    down(10, 10);
    up(12, 11);
    expect(engine.serialize().shapes).toBeUndefined();
    expect(engine.canUndo()).toBe(false);
  });

  it("undo removes it, redo brings it back", () => {
    const { engine, trace, up } = setup();
    engine.setTool("shape");
    trace([[10, 10], [100, 90]]);
    up(100, 90);
    engine.undo();
    expect(engine.serialize().shapes).toEqual([]);
    engine.redo();
    expect(engine.serialize().shapes).toHaveLength(1);
  });

  it("the eraser takes a shape whole it passes over, and undo gives it back", () => {
    const { engine, trace, up } = setup();
    engine.setTool("shape");
    engine.setShapeKind("rectangle");
    trace([[100, 100], [300, 220]]);
    up(300, 220);
    engine.setTool("eraser");
    trace([[90, 160], [110, 160]]); // across the left edge
    up(110, 160);
    expect(engine.serialize().shapes).toEqual([]);
    engine.undo();
    expect(engine.serialize().shapes).toHaveLength(1);
    engine.redo();
    expect(engine.serialize().shapes).toEqual([]);
  });

  it("the eraser far from a shape leaves it", () => {
    const { engine, trace, up } = setup();
    engine.setTool("shape");
    trace([[100, 100], [300, 220]]);
    up(300, 220);
    engine.setTool("eraser");
    trace([[180, 160], [220, 160]]); // inside the box, off the outline
    up(220, 160);
    expect(engine.serialize().shapes).toHaveLength(1);
  });
});

describe("shape fill", () => {
  it("with fill on, a dragged shape is stored filled and its inside is drawn under its outline", () => {
    const { engine, trace, up } = setup();
    engine.setTool("shape");
    engine.setShapeKind("rectangle");
    engine.setShapeFill("solid");
    trace([[100, 100], [300, 220]]);
    up(300, 220);
    expect(engine.serialize().shapes![0]).toMatchObject({ kind: "rectangle", fill: "solid" });
    // the inside comes first, so the outline is painted over it
    expect(drawn.at(-1)!.map((s) => s.toolId)).toEqual(["shape-fill", "shape"]);
  });

  it("with fill off (the default) the shape has no fill field at all, as before fills existed", () => {
    const { engine, trace, up } = setup();
    engine.setTool("shape");
    trace([[100, 100], [300, 220]]);
    up(300, 220);
    expect(engine.serialize().shapes![0]).not.toHaveProperty("fill");
    expect(drawn.at(-1)!.map((s) => s.toolId)).toEqual(["shape"]);
    engine.setShapeFill("solid");
    engine.setShapeFill("none");
    trace([[400, 100], [500, 200]]);
    up(500, 200);
    expect(engine.serialize().shapes![1]).not.toHaveProperty("fill");
  });

  it("a line or arrow is never filled, whatever the setting", () => {
    const { engine, trace, up } = setup();
    engine.setTool("shape");
    engine.setShapeFill("solid");
    engine.setShapeKind("arrow");
    trace([[100, 100], [300, 200]]);
    up(300, 200);
    expect(drawn.at(-1)!.map((s) => s.toolId)).toEqual(["shape", "shape"]); // shaft and head
  });

  it("the eraser takes a filled shape by its inside, but leaves an empty one alone there", () => {
    const { engine, trace, up } = setup();
    engine.setTool("shape");
    engine.setShapeFill("solid");
    trace([[100, 100], [300, 220]]);
    up(300, 220);
    engine.setShapeFill("none");
    trace([[400, 100], [600, 220]]);
    up(600, 220);
    engine.setTool("eraser");
    trace([[180, 160], [220, 160]]); // inside the filled one
    up(220, 160);
    trace([[480, 160], [520, 160]]); // inside the empty one
    up(520, 160);
    expect(engine.serialize().shapes!.map((shape) => shape.start)).toEqual([[400, 100]]);
  });

  it("a stored filled shape (and one from an older drawing without the field) are drawn as stored", () => {
    const engine = new InkEngine({ committedRenderer: renderer(), wetCanvas: document.createElement("canvas"), manageCanvasSize: false });
    engine.load({ version: 1, strokes: [], erased: {}, page: { width: 1000 }, shapes: [
      { id: "f", kind: "star", start: [0, 0], end: [50, 50], color: "#c43c3c", size: 2, fill: "solid" },
      { id: "o", kind: "star", start: [60, 0], end: [110, 50], color: "#c43c3c", size: 2 },
      { id: "x", kind: "star", start: [120, 0], end: [170, 50], color: "#c43c3c", size: 2, fill: "hatched" },
    ] });
    expect(drawn.at(-1)!.map((s) => s.id)).toEqual(["f:fill", "f:0", "o:0", "x:0"]);
  });
});

describe("draw, then hold still", () => {
  // The frame loop runs on the fake clock: the pen's moves are read one frame
  // (16 ms) after they arrive, and the half second is counted from there.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
  });
  const frame = () => vi.advanceTimersByTime(20);

  it("a rectangle held for half a second becomes a rectangle with the pen's colour and width", () => {
    const { engine, trace, up } = setup({ autoShape: true });
    engine.setColor("#7a2e33");
    engine.setSize(7);
    trace(rectangle());
    frame();
    vi.advanceTimersByTime(480);
    up(100, 100); // too early: lifted at about 0.5 s of holding
    const early = engine.serialize();
    expect(early.strokes).toHaveLength(1);
    engine.undo();
    trace(rectangle());
    frame();
    vi.advanceTimersByTime(520);
    up(100, 100);
    const doc = engine.serialize();
    expect(doc.strokes).toHaveLength(0);
    expect(doc.shapes).toHaveLength(1);
    expect(doc.shapes![0]).toMatchObject({ kind: "rectangle", color: "#7a2e33", size: 1 + 7 * 1.2 });
  });

  it("a stroke held still becomes a filled shape when fill is on", () => {
    const { engine, trace, up } = setup({ autoShape: true });
    engine.setShapeFill("solid");
    trace(rectangle());
    frame();
    vi.advanceTimersByTime(520);
    up(100, 100);
    expect(engine.serialize().shapes![0]).toMatchObject({ kind: "rectangle", fill: "solid" });
  });

  it("released before half a second, the stroke stays a stroke", () => {
    const { engine, trace, up } = setup({ autoShape: true });
    trace(rectangle());
    frame();
    vi.advanceTimersByTime(300);
    up(100, 100);
    expect(engine.serialize().strokes).toHaveLength(1);
    expect(engine.serialize().shapes).toBeUndefined();
  });

  it("moving on after the shape showed keeps the stroke", () => {
    const { engine, trace, move, up } = setup({ autoShape: true });
    trace(rectangle());
    frame();
    vi.advanceTimersByTime(600);
    move(60, 300);
    frame();
    vi.advanceTimersByTime(100);
    up(60, 300);
    expect(engine.serialize().strokes).toHaveLength(1);
    expect(engine.serialize().shapes).toBeUndefined();
  });

  it("with the setting off, nothing snaps", () => {
    const { engine, trace, up } = setup({ autoShape: false });
    trace(rectangle());
    frame();
    vi.advanceTimersByTime(900);
    up(100, 100);
    expect(engine.serialize().strokes).toHaveLength(1);
  });

  it("handwriting-like strokes are left alone however long they are held", () => {
    const { engine, trace, up } = setup({ autoShape: true });
    trace([[0, 0], [60, 80], [10, 120], [70, 200], [0, 260]]);
    frame();
    vi.advanceTimersByTime(900);
    up(0, 260);
    expect(engine.serialize().strokes).toHaveLength(1);
  });

  it("a held highlighter stroke stays a stroke (only the pen snaps)", () => {
    const { engine, trace, up } = setup({ autoShape: true });
    engine.setTool("highlighter");
    trace(rectangle());
    frame();
    vi.advanceTimersByTime(900);
    up(100, 100);
    expect(engine.serialize().strokes).toHaveLength(1);
  });

  it("one undo gives back the stroke as drawn; one more removes it; redo walks forward", () => {
    const { engine, trace, up } = setup({ autoShape: true });
    trace(rectangle());
    frame();
    vi.advanceTimersByTime(600);
    up(100, 100);
    const original = engine.serialize().strokes;
    expect(original).toHaveLength(0);

    engine.undo();
    let doc = engine.serialize();
    expect(doc.shapes).toEqual([]);
    expect(doc.strokes).toHaveLength(1);
    expect(doc.strokes[0]!.points.length).toBeGreaterThan(50);

    engine.undo();
    expect(engine.serialize().strokes).toHaveLength(0);

    engine.redo();
    expect(engine.serialize().strokes).toHaveLength(1);
    engine.redo();
    doc = engine.serialize();
    expect(doc.strokes).toHaveLength(0);
    expect(doc.shapes).toHaveLength(1);
    expect(engine.canRedo()).toBe(false);
  });
});

describe("shapes in a stored drawing", () => {
  const base: InkDocument = { version: 1, strokes: [], erased: {}, page: { width: 1000 } };

  it("a drawing without shapes is written back without them", () => {
    const model = new InkModel();
    model.load(base);
    expect(model.serialize()).not.toHaveProperty("shapes");
  });

  it("a shape of a kind this version cannot draw is kept as stored, and draws nothing", () => {
    const future = { id: "f", kind: "spiral", points: [[0, 0]], color: "#000", size: 2 } as unknown as NonNullable<InkDocument["shapes"]>[number];
    const model = new InkModel();
    model.load({ ...base, shapes: [future] });
    expect(model.serialize().shapes).toEqual([future]);
    const engine = new InkEngine({ committedRenderer: renderer(), wetCanvas: document.createElement("canvas"), manageCanvasSize: false });
    engine.load({ ...base, shapes: [future] });
    expect(drawn.at(-1)).toEqual([]);
  });

  it("shapes of an older drawing (rectangle, circle, arrow) are drawn", () => {
    const engine = new InkEngine({ committedRenderer: renderer(), wetCanvas: document.createElement("canvas"), manageCanvasSize: false });
    engine.load({ ...base, shapes: [
      { id: "r", kind: "rectangle", start: [0, 0], end: [50, 50], color: "#000", size: 2 },
      { id: "c", kind: "circle", start: [0, 0], end: [50, 50], color: "#000", size: 2 },
      { id: "a", kind: "arrow", start: [0, 0], end: [50, 0], color: "#000", size: 2 },
    ] });
    expect(drawn.at(-1)!.map((s) => s.id.split(":")[0])).toEqual(["r", "c", "a", "a"]);
  });

  it("a drawing that needs a newer version is not edited", () => {
    const engine = new InkEngine({ committedRenderer: renderer(), wetCanvas: document.createElement("canvas"), manageCanvasSize: false });
    engine.load({ ...base, requires: ["future-thing"] });
    expect(engine.readOnly).toBe(true);
    const model = new InkModel();
    model.load({ ...base, requires: ["future-thing"] });
    model.addShape({ id: "s", kind: "line", start: [0, 0], end: [9, 9], color: "#000", size: 2 });
    expect(model.shapes).toEqual([]);
  });

  it("the page grows to hold a shape near the bottom", () => {
    const model = new InkModel();
    model.load({ ...base, shapes: [{ id: "s", kind: "line", start: [0, 0], end: [9, 3000], color: "#000", size: 2 }] });
    expect(model.contentHeight(1400, 200)).toBe(3200);
  });
});
