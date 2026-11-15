// PDF drawing mode on the handwriting engine: a page's drawing (page units) is
// loaded into its engine as it is, the pen / highlighter / eraser edit it there,
// and the session writes the page back — both forms — into the one ink_data
// envelope.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkEngine } from "../lib/ink";
import type { ICommittedRenderer } from "../lib/ink/committed";
import { drawingRecord } from "../lib/pdf/capture";
import { pdfPageDoc, setPdfPageDoc, withUnits } from "../lib/pdf/pageUnits";
import { createPdfDrawSession, type PdfDrawSession } from "../lib/pdf/drawSession";
import { drawingStrokesToInk, emptyMultiPageDoc, addDrawingToPage, type InkMultiPageDoc } from "../lib/pdf/pdfAdapter";
import type { PdfDrawingStroke, PdfHighlightRecord } from "../lib/pdf/coords";

const stubRenderer = (): ICommittedRenderer =>
  ({ kind: "canvas2d", commitStrokes() {}, setView() {}, resize() {}, destroy() {} });

type Kind = "pen" | "touch" | "mouse";
function pointer(type: string, o: { id: number; kind: Kind; x: number; y: number; t: number; pressure?: number }): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, {
    pointerId: o.id, pointerType: o.kind, button: 0, clientX: o.x, clientY: o.y,
    pressure: o.pressure ?? 0.5, getCoalescedEvents: () => [],
  });
  Object.defineProperty(e, "timeStamp", { value: o.t });
  return e;
}

/** One PDF page surface as PageInkSurface builds it: the page in page units
 *  (1000 wide), the transform the page's px size gives it (`px` wide). */
function surface(session: PdfDrawSession, doc: InkMultiPageDoc, page: number, px = { width: 1000, ratio: 4 / 3 }) {
  const el = document.createElement("div");
  Object.assign(el, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
  document.body.appendChild(el);
  const view = { scale: px.width / 1000 };
  const engine = new InkEngine({
    committedRenderer: stubRenderer(),
    wetCanvas: document.createElement("canvas"),
    manageCanvasSize: false,
    transform: { toDoc: (x, y) => [x / view.scale, y / view.scale], scale: () => view.scale },
    gestures: { pan() {}, zoom() {} },
    eraserRadius: () => 12 / view.scale, // as PageInkSurface: 12 px on screen at any zoom
    onHistoryChange: () => session.historyChanged(),
  });
  engine.load(pdfPageDoc(doc, page) ?? null);
  engine.addPointerHandlers(el);
  session.attach(`pdf:${page}`, engine, px.ratio);
  let t = 0;
  const drag = (kind: Kind, pts: Array<[number, number]>, pressure?: number) => {
    const id = 1;
    t += 1000; // clear of the palm grace between strokes
    el.dispatchEvent(pointer("pointerdown", { id, kind, x: pts[0][0], y: pts[0][1], t, pressure }));
    pts.slice(1).forEach(([x, y], i) => el.dispatchEvent(pointer("pointermove", { id, kind, x, y, t: t + 10 * (i + 1), pressure })));
    const [lx, ly] = pts[pts.length - 1];
    el.dispatchEvent(pointer("pointerup", { id, kind, x: lx, y: ly, t: t + 10 * pts.length, pressure }));
  };
  /** A zoom: only the transform changes; the engine, its history and drawing stay. */
  const zoomTo = (width: number) => { view.scale = width / 1000; engine.viewChanged(); };
  return { engine, drag, zoomTo };
}

/** A drawing as an earlier session stored it: captured at 600 wide, no pressure. */
function storedDrawing(id: string, page = 1): { doc: InkMultiPageDoc; record: PdfHighlightRecord } {
  const strokes: PdfDrawingStroke[] = [{ points: [{ x: 100, y: 100 }, { x: 150, y: 100 }, { x: 200, y: 100 }], color: "#7a2e33", width: 2.5 }];
  const record = drawingRecord(id, page, strokes, { width: 600, height: 800 })!;
  const doc = addDrawingToPage({ ...emptyMultiPageDoc(), annotations: [record] }, page, id, record.content!.strokes!);
  return { doc, record };
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const strokesOf = (env: InkMultiPageDoc, page = 1) => pdfPageDoc(env, page)?.strokes ?? [];

describe("strokes drawn in the PDF", () => {
  it("keep pressure, colour, size and the highlighter, in the page and in the older fields", () => {
    const session = createPdfDrawSession();
    const { engine, drag } = surface(session, emptyMultiPageDoc(), 2);
    engine.setTool("highlighter");
    engine.setColor("#315f8f");
    engine.setSize(7);
    drag("pen", [[40, 50], [80, 60], [120, 70]], 0.7);
    const doc = session.apply(emptyMultiPageDoc());
    const [stroke] = strokesOf(doc, 2);
    expect(stroke).toMatchObject({ color: "#315f8f", size: 7, toolId: "highlighter" });
    expect(stroke!.points.every((p) => p[2] === 0.7)).toBe(true);
    // the older form, for an older app: one record named by the stroke id
    expect(doc.annotations?.map((a) => a.id)).toEqual([stroke!.id]);
    const stored = doc.annotations![0].content!.strokes![0];
    expect(stored).toMatchObject({ color: "#315f8f", width: 7, toolId: "highlighter" });
    expect(stored.points.every((p) => p.p === 0.7)).toBe(true);
    expect(doc.pages[2].strokes[0]).toMatchObject({ id: stroke!.id, toolId: "highlighter", size: 7 });
  });

  it("a mouse stroke carries no pressure but still names its tool", () => {
    const session = createPdfDrawSession();
    const { drag } = surface(session, emptyMultiPageDoc(), 1);
    drag("mouse", [[10, 10], [60, 40]]);
    const [stroke] = strokesOf(session.apply(emptyMultiPageDoc()));
    expect(stroke!.toolId).toBe("pen");
    expect(stroke!.points.some((p) => p.length > 2)).toBe(false);
  });

  it("applying again with nothing new changes nothing (one edit, one save)", () => {
    const session = createPdfDrawSession();
    const { drag } = surface(session, emptyMultiPageDoc(), 1);
    drag("mouse", [[10, 10], [60, 40]]);
    const once = session.apply(emptyMultiPageDoc());
    expect(session.apply(once)).toBe(once);
  });

  it("later strokes on the same page are the same page: one record each in the older form", () => {
    const session = createPdfDrawSession();
    const { drag } = surface(session, emptyMultiPageDoc(), 1);
    drag("mouse", [[10, 10], [60, 40]]);
    const first = session.apply(emptyMultiPageDoc());
    drag("mouse", [[200, 200], [260, 240]]);
    const second = session.apply(first);
    expect(strokesOf(second)).toHaveLength(2);
    expect(second.annotations).toHaveLength(2);
    expect(second.annotations![0]).toBe(first.annotations![0]); // untouched
    expect(second.pages[1].strokes.map((s) => s.id)).toEqual(strokesOf(second).map((s) => s.id));
  });

  it("in page units whatever the zoom: drawn at 1500 px wide, stored 1.5 times smaller", () => {
    const session = createPdfDrawSession();
    const { engine, drag } = surface(session, emptyMultiPageDoc(), 1, { width: 1500, ratio: 4 / 3 });
    engine.setSize(9); // units: a 9 px pen at this zoom is set by the host as 9 / scale
    drag("mouse", [[300, 600], [600, 900]]);
    const [stroke] = strokesOf(session.apply(emptyMultiPageDoc()));
    expect(stroke!.points[0]).toEqual([200, 400]);
    expect(stroke!.points[stroke!.points.length - 1]).toEqual([400, 600]);
  });
});

describe("a page in the engine", () => {
  it("loads as it is: the document the engine holds is the page", () => {
    const { doc } = storedDrawing("d1");
    const page = pdfPageDoc(doc, 1)!;
    const session = createPdfDrawSession();
    const { engine } = surface(session, doc, 1);
    expect(engine.serialize().strokes).toEqual(page.strokes);
    expect(engine.serialize().page.width).toBe(1000);
  });

  it("a zoom moves the transform and repaints: the engine, its undo history and its drawing stay", () => {
    const session = createPdfDrawSession();
    const { engine, drag, zoomTo } = surface(session, emptyMultiPageDoc(), 1, { width: 500, ratio: 4 / 3 });
    drag("mouse", [[100, 100], [200, 200]]); // 500 px wide: units ×2
    zoomTo(1000);
    expect(engine.canUndo()).toBe(true);
    drag("mouse", [[600, 600], [800, 800]]); // now 1:1
    const [first, second] = strokesOf(session.apply(emptyMultiPageDoc()));
    expect(first!.points[0]).toEqual([200, 200]);
    expect(second!.points[0]).toEqual([600, 600]);
    session.undo();
    session.undo();
    expect(strokesOf(session.apply(session.apply(emptyMultiPageDoc())))).toHaveLength(0);
    session.redo();
    expect(engine.serialize().strokes).toHaveLength(1);
  });

  it("the eraser reaches a stroke saved earlier, saved at another zoom, and only that span is written", () => {
    const { doc } = storedDrawing("d1"); // captured at 600 wide: units ×1000/600
    const session = createPdfDrawSession();
    const { engine, drag } = surface(session, doc, 1, { width: 1200, ratio: 4 / 3 });
    engine.setTool("eraser");
    drag("mouse", [[290, 200], [310, 200]]); // the middle point (250, 166.7 units) at 1200 px: (300, 200)
    const next = session.apply(doc);
    expect(pdfPageDoc(next, 1)!.erased).toEqual({ d1: [[1, 1]] });
    expect(next.pages[1].erased).toEqual({ d1: [[1, 1]] });
    expect(next.annotations).toEqual(withUnits(doc).annotations); // the record is untouched
    expect(next.pages[1].strokes).toEqual(doc.pages[1].strokes); // strokes untouched
  });

  it("the eraser is 12 px on screen at any zoom: the same reach in px, not in page units", () => {
    // a horizontal stroke at y = 200 units; the eraser passes 8 px above it
    const stroke = { id: "s", points: [[100, 200], [150, 200], [200, 200]] as Array<[number, number]>, color: "#000", size: 2, toolId: "pen" };
    const doc = setPdfPageDoc(emptyMultiPageDoc(), 1, { version: 1, strokes: [stroke], erased: {}, page: { width: 1000 } }, 4 / 3);
    for (const [width, touched] of [[1000, true], [2000, true]] as const) {
      const session = createPdfDrawSession();
      const { engine, drag } = surface(session, doc, 1, { width, ratio: 4 / 3 });
      engine.setTool("eraser");
      const k = width / 1000;
      drag("mouse", [[140 * k, 200 * k - 8], [160 * k, 200 * k - 8]]); // 8 px above the stroke's middle
      expect(Object.keys(session.apply(doc).units!.pages["pdf:1"]!.doc.erased).length > 0, `${width}px`).toBe(touched);
    }
    // 16 px away misses at both zooms (it would hit at 2000 px wide if the reach were 12 units)
    for (const width of [1000, 2000]) {
      const session = createPdfDrawSession();
      const { engine, drag } = surface(session, doc, 1, { width, ratio: 4 / 3 });
      engine.setTool("eraser");
      const k = width / 1000;
      drag("mouse", [[140 * k, 200 * k - 16], [160 * k, 200 * k - 16]]);
      expect(session.apply(doc)).toBe(doc);
    }
  });

  it("a drawing erased to nothing is still there for undo; undo brings it back, redo erases again", () => {
    const { doc } = storedDrawing("d1");
    const session = createPdfDrawSession();
    const { engine, drag } = surface(session, doc, 1, { width: 600, ratio: 4 / 3 });
    engine.setTool("eraser");
    drag("mouse", [[90, 100], [210, 100]]);
    const gone = session.apply(doc);
    expect(pdfPageDoc(gone, 1)!.erased).toEqual({ d1: [[0, 2]] });
    session.undo();
    const back = session.apply(gone);
    expect(pdfPageDoc(back, 1)!.erased).toEqual({});
    expect(back.annotations?.map((a) => a.id)).toEqual(["d1"]);
    session.redo();
    expect(pdfPageDoc(session.apply(back), 1)!.erased).toEqual({ d1: [[0, 2]] });
  });

  it("erases strokes drawn in this very session too, and undo returns them", () => {
    const session = createPdfDrawSession();
    const { engine, drag } = surface(session, emptyMultiPageDoc(), 1);
    drag("mouse", [[10, 10], [50, 10], [90, 10]]);
    const drawn = session.apply(emptyMultiPageDoc());
    engine.setTool("eraser");
    drag("mouse", [[0, 10], [100, 10]]);
    const erased = session.apply(drawn);
    const [stroke] = strokesOf(erased);
    expect(pdfPageDoc(erased, 1)!.erased[stroke!.id]).toEqual([[0, stroke!.points.length - 1]]);
    session.undo();
    expect(pdfPageDoc(session.apply(erased), 1)!.erased).toEqual({});
  });

  it("only the drawing that was hit changes; the other keeps its strokes and record", () => {
    const a = storedDrawing("a");
    const b = drawingRecord("b", 1, [{ points: [{ x: 300, y: 300 }, { x: 350, y: 300 }], color: "#000", width: 2.5 }], { width: 600, height: 800 })!;
    const doc = addDrawingToPage({ ...a.doc, annotations: [...a.doc.annotations!, b] }, 1, "b", b.content!.strokes!);
    const session = createPdfDrawSession();
    const { engine, drag } = surface(session, doc, 1, { width: 600, ratio: 4 / 3 });
    engine.setTool("eraser");
    drag("mouse", [[90, 100], [210, 100]]);
    const next = session.apply(doc);
    expect(Object.keys(pdfPageDoc(next, 1)!.erased)).toEqual(["a"]);
    expect(next.annotations?.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("a page that unmounts mid-session", () => {
  it("keeps its edits for the next apply and asks for it at once", () => {
    const session = createPdfDrawSession();
    const settled = vi.fn();
    session.onSettled = settled;
    const { engine, drag } = surface(session, emptyMultiPageDoc(), 4);
    drag("mouse", [[10, 10], [60, 40]]);
    session.detach("pdf:4", engine);
    expect(settled).toHaveBeenCalledTimes(1);
    const written = session.apply(emptyMultiPageDoc());
    expect(strokesOf(written, 4)).toHaveLength(1);
    expect(strokesOf(session.apply(emptyMultiPageDoc()), 4)).toHaveLength(0); // not applied twice
  });

  it("a surface with nothing to write does not ask", () => {
    const session = createPdfDrawSession();
    const settled = vi.fn();
    session.onSettled = settled;
    const { engine } = surface(session, emptyMultiPageDoc(), 1);
    session.detach("pdf:1", engine);
    expect(settled).not.toHaveBeenCalled();
  });
});

describe("undo and redo across pages", () => {
  it("go to the page last worked on first", () => {
    const session = createPdfDrawSession();
    const one = surface(session, emptyMultiPageDoc(), 1);
    const two = surface(session, emptyMultiPageDoc(), 2);
    one.drag("mouse", [[10, 10], [60, 40]]);
    session.touched("pdf:1");
    two.drag("mouse", [[10, 10], [60, 40]]);
    session.touched("pdf:2");
    session.undo();
    expect(two.engine.serialize().strokes).toHaveLength(0);
    expect(one.engine.serialize().strokes).toHaveLength(1);
    session.undo();
    expect(one.engine.serialize().strokes).toHaveLength(0);
    session.redo();
    expect(one.engine.serialize().strokes).toHaveLength(1);
  });

  it("report availability to the toolbar", () => {
    const session = createPdfDrawSession();
    const seen: Array<[boolean, boolean]> = [];
    session.onHistoryChange = (u, r) => seen.push([u, r]);
    const { drag } = surface(session, emptyMultiPageDoc(), 1);
    drag("mouse", [[10, 10], [60, 40]]);
    expect(seen[seen.length - 1]).toEqual([true, false]);
    session.undo();
    expect(seen[seen.length - 1]).toEqual([false, true]);
  });
});

describe("storage helpers", () => {
  it("drawings saved without pressure or tool read back unchanged", () => {
    const legacy: PdfDrawingStroke[] = [{ points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], color: "#7a2e33", width: 2.5 }];
    const ink = drawingStrokesToInk("g", legacy);
    expect(ink[0]).toMatchObject({ points: [[1, 2], [3, 4]], toolId: "pen" });
  });
});
