// T1-0: the editing model must not drop what it does not manage. An old app
// loads a drawing a newer one wrote (shapes, a future tool, `clips`,
// `page.template`, ...), the user adds a stroke, the engine saves — and the
// server merge reads every missing field as "deleted on this side".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkModel } from "../lib/ink/model";
import { InkEngine } from "../lib/ink/engine";
import type { ICommittedRenderer } from "../lib/ink/committed";
import { decodeInk, encodeInk } from "@onden/markdown/ink";
import { emptyInkDocument, type InkDocument, type InkStroke } from "../lib/ink/types";

const pen = (id: string): InkStroke => ({ id, points: [[0, 0], [5, 5]], color: "#000", size: 2, toolId: "pen" });

const future = {
  version: 1,
  features: ["clips"],
  clips: [{ id: "c1", box: [0, 0, 10, 10] }],
  strokes: [{ id: "p1", points: [[1, 1], [2, 2]], color: "#123", size: 3, toolId: "pencil", grain: 2 }],
  erased: {},
  page: { width: 800, background: "#fff", template: "grid" },
  shapes: [
    { id: "r1", kind: "rectangle", start: [0, 0], end: [4, 4], color: "#f00", size: 2 },
    { id: "spiral1", kind: "spiral", points: [[0, 0], [3, 6], [6, 0]], color: "#0f0", size: 2 },
  ],
};
const load = (raw: object) => {
  const d = decodeInk(JSON.stringify(raw));
  if (d.kind !== "page") throw new Error("page expected");
  return d.doc;
};

describe("InkModel keeps what it does not manage", () => {
  it("load → add stroke → serialize keeps shapes and every unknown field", () => {
    const m = new InkModel();
    m.load(load(future));
    m.addStroke(pen("n1"));
    const out = m.serialize() as unknown as typeof future;
    expect(out.shapes).toEqual(future.shapes);
    expect(out.clips).toEqual(future.clips);
    expect(out.features).toEqual(["clips"]);
    expect(out.page).toEqual(future.page);
    expect(out.strokes[0]).toEqual(future.strokes[0]); // pencil + grain intact
    expect(out.strokes.map((s) => s.id)).toEqual(["p1", "n1"]);
  });

  it("load → serialize with no edit is the identity", () => {
    const m = new InkModel();
    m.load(load(future));
    expect(m.serialize()).toEqual(load(future));
  });

  it("a note's further pages ride along while its first page is edited", () => {
    const more = { version: 1 as const, order: ["page", "u"], pages: { u: { key: "u", background: { kind: "blank" }, size: { width: 1000, height: 1400 }, doc: { version: 1 as const, strokes: [pen("u1")], erased: {}, page: { width: 1000 } } } } };
    const m = new InkModel();
    m.load(load({ version: 1, strokes: [], erased: {}, page: { width: 1000 }, morePages: more }));
    m.addStroke(pen("n1"));
    expect(m.serialize().morePages).toEqual(more);
  });

  it("loading another drawing does not leak the previous one's extras", () => {
    const m = new InkModel();
    m.load(load(future));
    m.load(emptyInkDocument());
    expect(m.serialize()).toEqual(emptyInkDocument());
  });

  it("serialize deep-copies the extras", () => {
    const m = new InkModel();
    m.load(load(future));
    const snap = m.serialize() as unknown as { clips: Array<{ box: number[] }>; shapes: Array<{ start: number[] }> };
    snap.clips[0]!.box[0] = 99;
    snap.shapes[0]!.start[0] = 99;
    const again = m.serialize() as unknown as typeof snap;
    expect(again.clips[0]!.box[0]).toBe(0);
    expect(again.shapes[0]!.start[0]).toBe(0);
  });

  it("readOnly follows the document's required features", () => {
    const m = new InkModel();
    m.load(load(future));
    expect(m.readOnly).toBe(false); // `features` alone does not gate editing
    m.load(load({ ...future, requires: ["clips"] }));
    expect(m.readOnly).toBe(true);
    m.load(emptyInkDocument());
    expect(m.readOnly).toBe(false);
  });

  it("a read-only model refuses edits and still serializes unchanged", () => {
    const raw = load({ ...future, requires: ["clips"] });
    const m = new InkModel();
    m.load(raw);
    m.addStroke(pen("n1"));
    m.applyErase({ p1: [[0, 0]] });
    expect(m.canUndo()).toBe(false);
    expect(m.serialize()).toEqual(raw);
  });
});

describe("InkEngine on a read-only drawing", () => {
  const renderer = (): ICommittedRenderer => ({ kind: "canvas2d", commitStrokes() {}, setView() {}, resize() {}, destroy() {} });
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

  it("draws nothing and never calls onChange", () => {
    const el = document.createElement("div");
    (el as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    document.body.appendChild(el);
    const onChange = vi.fn();
    const engine = new InkEngine({ committedRenderer: renderer(), wetCanvas: document.createElement("canvas"), manageCanvasSize: false, onChange, changeDebounceMs: 0 });
    engine.load(load({ ...future, requires: ["clips"] }));
    expect(engine.readOnly).toBe(true);
    const dispose = engine.addPointerHandlers(el);
    const ev = (type: string) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerId: 1, pointerType: "pen", button: 0, clientX: 10, clientY: 10, pressure: 0.5, getCoalescedEvents: () => [] });
    el.dispatchEvent(ev("pointerdown"));
    el.dispatchEvent(ev("pointermove"));
    el.dispatchEvent(ev("pointerup"));
    engine.flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(engine.serialize().strokes).toHaveLength(1);
    dispose();
    engine.destroy();
  });
});

it("the encode the hosts use keeps the same bytes", () => {
  const doc = load(future) as InkDocument;
  expect(JSON.parse(encodeInk(doc))).toEqual(future);
});
