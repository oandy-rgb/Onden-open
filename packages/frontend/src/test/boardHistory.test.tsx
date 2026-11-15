// 白板只有一條復原紀錄：卡片移動、移除、連線與手寫（筆畫、形狀、擦除、移動）依時間順序一起退回，
// 不分筆模式內外。這裡用真的 InkEngine 與 useCanvasUndo。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { InkEngine } from "../lib/ink/engine";
import { registerInkEdit } from "../lib/ink/boardHistory";
import type { ICommittedRenderer } from "../lib/ink/committed";
import type { InkDocument } from "../lib/ink/types";
import { useCanvasUndo } from "../hooks/useCanvasUndo";

const renderer = (): ICommittedRenderer => ({ kind: "canvas2d", commitStrokes() {}, setView() {}, resize() {}, destroy() {} });
const card = (nodeId: string, x: number, y: number) => [{ nodeId, x, y }];

function setup(doc?: InkDocument) {
  const save = vi.fn();
  const board = renderHook(() => useCanvasUndo({ canvasId: "c1", onRestorePositions: save }));
  const el = document.createElement("div");
  Object.assign(el, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
  document.body.appendChild(el);
  let engine!: InkEngine;
  engine = new InkEngine({
    committedRenderer: renderer(), wetCanvas: document.createElement("canvas"), manageCanvasSize: false,
    gestures: { pan() {}, zoom() {} },
    onRecord: (op) => registerInkEdit(board.result.current.history, () => engine, op),
    onUndoRequest: () => void board.result.current.history.undo(),
  });
  if (doc) engine.load(doc);
  engine.addPointerHandlers(el);
  let t = 0;
  const fire = (type: string, x: number, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: x, clientY: y, pressure: 0.5, getCoalescedEvents: () => [] });
    Object.defineProperty(e, "timeStamp", { value: (t += 10) });
    el.dispatchEvent(e);
  };
  const draw = (...pts: Array<[number, number]>) => {
    fire("pointerdown", ...pts[0]!);
    pts.slice(1).forEach(([x, y]) => fire("pointermove", x, y));
    fire("pointerup", ...pts.at(-1)!);
  };
  const press = (shiftKey = false) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey })); });
  return { board, save, engine, draw, press };
}

const stroke = { id: "s1", points: [[10, 10], [20, 20], [30, 30]] as [number, number][], color: "#000", size: 4, toolId: "pen" as const };
const inkDoc = (): InkDocument => ({ version: 1, strokes: [{ ...stroke, points: stroke.points.map((p) => [...p] as [number, number]) }], erased: {}, page: { width: 800 } });

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("the board's one history", () => {
  it("a stroke, then a card move: Ctrl+Z twice undoes both, newest first; Ctrl+Shift+Z puts them back in order", async () => {
    const { board, save, engine, draw, press } = setup();
    draw([5, 5], [15, 15], [25, 25]);
    expect(engine.serialize().strokes).toHaveLength(1);
    act(() => board.result.current.recordPositions(card("a", 10, 20), [], { nodes: card("a", 50, 60), sections: [] }));

    await press();
    expect(save).toHaveBeenLastCalledWith(card("a", 10, 20), []);
    expect(engine.serialize().strokes).toHaveLength(1); // the card came back first, the stroke is still there
    await press();
    expect(engine.serialize().strokes).toHaveLength(0);

    await press(true);
    expect(engine.serialize().strokes).toHaveLength(1);
    expect(save).toHaveBeenCalledTimes(1);
    await press(true);
    expect(save).toHaveBeenLastCalledWith(card("a", 50, 60), []);
  });

  it("the finger taps (engine undo request) take the same step the key takes", async () => {
    const { board, engine, draw } = setup();
    draw([5, 5], [15, 15], [25, 25]);
    draw([100, 5], [115, 15], [125, 25]);
    await act(async () => { await board.result.current.undo(); });
    expect(engine.serialize().strokes).toHaveLength(1);
    expect(board.result.current.canUndo).toBe(true);
    expect(board.result.current.canRedo).toBe(true);
  });

  it("drag-select over a card and a stroke, move both: one Ctrl+Z puts both back; one Ctrl+Shift+Z moves both again", async () => {
    const { board, save, engine, press } = setup(inkDoc());
    const picked = engine.itemsInRect({ x1: 0, y1: 0, x2: 40, y2: 40 });
    expect(picked.strokeIds).toEqual(["s1"]);
    act(() => board.result.current.history.batch(() => {
      board.result.current.recordPositions(card("a", 10, 20), [], { nodes: card("a", 110, 120), sections: [] });
      engine.moveItems(picked, 100, 100);
    }));
    expect(engine.serialize().strokes[0]!.points[0]).toEqual([110, 110]);

    await press();
    expect(save).toHaveBeenLastCalledWith(card("a", 10, 20), []);
    expect(engine.serialize().strokes[0]!.points[0]).toEqual([10, 10]);
    expect(board.result.current.canUndo).toBe(false);

    await press(true);
    expect(save).toHaveBeenLastCalledWith(card("a", 110, 120), []);
    expect(engine.serialize().strokes[0]!.points[0]).toEqual([110, 110]);
  });

  it("deleting the selected card and stroke together, then Ctrl+Z, brings both back", async () => {
    const { board, engine, press } = setup(inkDoc());
    let onBoard = true;
    act(() => board.result.current.history.batch(() => {
      board.result.current.history.push({ undo: () => { onBoard = true; return true; }, redo: () => { onBoard = false; return true; } });
      onBoard = false;
      engine.removeItems(engine.itemsInRect({ x1: 0, y1: 0, x2: 40, y2: 40 }));
    }));
    expect(engine.itemsInRect({ x1: 0, y1: 0, x2: 40, y2: 40 }).strokeIds).toEqual([]);

    await press();
    expect(onBoard).toBe(true);
    expect(engine.itemsInRect({ x1: 0, y1: 0, x2: 40, y2: 40 }).strokeIds).toEqual(["s1"]);
  });

  it("removing the selected ink is one undoable step, and it is no longer selectable once gone", async () => {
    const { engine, board } = setup(inkDoc());
    const all = engine.itemsInRect({ x1: 0, y1: 0, x2: 100, y2: 100 });
    act(() => engine.removeItems(all));
    expect(engine.itemsInRect({ x1: 0, y1: 0, x2: 100, y2: 100 }).strokeIds).toEqual([]);
    expect(board.result.current.canUndo).toBe(true);
    await act(async () => { await board.result.current.undo(); });
    expect(engine.itemsInRect({ x1: 0, y1: 0, x2: 100, y2: 100 }).strokeIds).toEqual(["s1"]);
  });

  it("a held-still stroke that became a shape registers two steps, like the engine's own stack", () => {
    const push = vi.fn();
    registerInkEdit({ push }, () => null, { type: "snap", stroke, shape: { id: "x", kind: "rectangle", start: [0, 0], end: [1, 1], color: "#000", size: 4 } });
    expect(push).toHaveBeenCalledTimes(2);
    push.mockClear();
    registerInkEdit({ push }, () => null, { type: "add", stroke });
    expect(push).toHaveBeenCalledTimes(1);
  });
});
