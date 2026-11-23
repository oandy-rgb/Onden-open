// A board without a remembered viewport fits to everything that is on it, also when its first cards
// arrive after the board opened (the sub-note tree is drawn from notes that may load later).
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node, ReactFlowInstance } from "@xyflow/react";
import { useBoardCamera } from "../hooks/useBoardCamera";
import { writeViewport } from "../lib/canvasViewport";

const card = (id: string): Node => ({ id, type: "card", position: { x: 0, y: 0 }, data: {} });
const fitOptions = { padding: 0.1 };
const openPadding = { top: 64, right: 24, bottom: 96, left: 24 };
function setup(boardId: string, nodes: Node[], wrap: HTMLElement | null = null, readableOpen = true) {
  const rf = { fitView: vi.fn(), setViewport: vi.fn(), setCenter: vi.fn(), getZoom: () => 1, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), getNode: () => undefined } as unknown as ReactFlowInstance;
  const wrapRef = { current: wrap as HTMLDivElement | null };
  const hook = renderHook(
    (props: { nodes: Node[] }) => useBoardCamera({ rfInstance: rf, boardId, selectedNodeId: null, displayNodes: props.nodes, wrapRef, fitOptions, openPadding, readableOpen }),
    { initialProps: { nodes } },
  );
  return { rf, hook };
}
beforeEach(() => { sessionStorage.clear(); });

describe("the board's first fit", () => {
  it("opens fitted to its cards when no viewport was remembered", () => {
    const { rf, hook } = setup("fresh", [card("a")]);
    expect(hook.result.current.fitOnOpen).toBe(true);
    expect(rf.fitView).toHaveBeenCalledTimes(1);
    expect(rf.fitView).toHaveBeenCalledWith(expect.objectContaining({ padding: 0.1 }));
  });

  it("waits for the first cards of a board that opened empty, then fits once", () => {
    const { rf, hook } = setup("late", []);
    expect(rf.fitView).not.toHaveBeenCalled();
    hook.rerender({ nodes: [card("a"), card("b")] });
    expect(rf.fitView).toHaveBeenCalledTimes(1);
    hook.rerender({ nodes: [card("a"), card("b"), card("c")] }); // later changes keep the camera where the person put it
    expect(rf.fitView).toHaveBeenCalledTimes(1);
  });

  // A tablet's centre column is about 435px: a grid of default cards fitted into it came out at 40%, too small to read.
  const wrapOf = (width: number, height: number) => {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) });
    return el;
  };
  const grid = (columns: number, rows: number) => Array.from({ length: columns * rows }, (_, i) => ({
    id: `c${i}`, type: "card", position: { x: (i % columns) * 300, y: Math.floor(i / columns) * 240 }, data: {},
  } as Node));

  it("opens a board that does not fit a narrow pane at a readable scale, at its top-left", () => {
    const { rf } = setup("narrow", grid(4, 3), wrapOf(435, 600));
    expect(rf.fitView).not.toHaveBeenCalled();
    const [viewport] = (rf.setViewport as unknown as { mock: { calls: Array<[{ x: number; y: number; zoom: number }]> } }).mock.calls[0]!;
    expect(viewport.zoom).toBeGreaterThanOrEqual(0.75);
    expect(viewport).toMatchObject({ x: 24, y: 64 }); // the first card sits under the controls' room, not cut off
  });

  it("a mouse keeps React Flow's fit of everything: a tall card the camera did not know about is still in view", () => {
    const tall = { ...grid(2, 1)[0]!, style: { width: 260, height: 900 } } as Node;
    const { rf } = setup("mouse", [tall, ...grid(2, 2).slice(1)], wrapOf(1600, 900), false);
    expect(rf.setViewport).not.toHaveBeenCalled();
    expect(rf.fitView).toHaveBeenCalledTimes(1);
    expect(rf.fitView).toHaveBeenCalledWith(expect.objectContaining({ padding: 0.1 }));
  });

  it("on a touch screen a card taller than the default counts with its own height", () => {
    const tall = { ...grid(1, 1)[0]!, style: { width: 260, height: 2000 } } as Node;
    const { rf } = setup("touch-tall", [tall], wrapOf(435, 600), true);
    const [viewport] = (rf.setViewport as unknown as { mock: { calls: Array<[{ x: number; y: number; zoom: number }]> } }).mock.calls[0]!;
    // 2000px tall at 0.75 does not fit the 600px board: it starts at the top (centred it would cut its top off);
    // its width does fit, so it stays centred across: 24 + (387 − 260 × 0.75) / 2
    expect(viewport.zoom).toBe(0.75);
    expect(viewport).toMatchObject({ x: 120, y: 64 });
  });

  it("does not blow a board with a few cards up past 100%", () => {
    const { rf } = setup("few", grid(1, 1), wrapOf(1200, 700));
    const [viewport] = (rf.setViewport as unknown as { mock: { calls: Array<[{ zoom: number }]> } }).mock.calls[0]!;
    expect(viewport.zoom).toBe(1);
  });

  it("restores a remembered viewport instead of fitting", () => {
    writeViewport("kept", { x: 5, y: 6, zoom: 0.5 });
    const { rf, hook } = setup("kept", [card("a")]);
    expect(hook.result.current.fitOnOpen).toBe(false);
    expect(rf.fitView).not.toHaveBeenCalled();
    expect(rf.setViewport).toHaveBeenCalledWith({ x: 5, y: 6, zoom: 0.5 });
  });
});
