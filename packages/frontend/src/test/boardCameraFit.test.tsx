// A board without a remembered viewport fits to everything that is on it, also when its first cards
// arrive after the board opened (the sub-note tree is drawn from notes that may load later).
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node, ReactFlowInstance } from "@xyflow/react";
import { useBoardCamera } from "../hooks/useBoardCamera";
import { writeViewport } from "../lib/canvasViewport";

const card = (id: string): Node => ({ id, type: "card", position: { x: 0, y: 0 }, data: {} });
const fitOptions = { padding: 0.1 };
function setup(boardId: string, nodes: Node[]) {
  const rf = { fitView: vi.fn(), setViewport: vi.fn(), setCenter: vi.fn(), getZoom: () => 1, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), getNode: () => undefined } as unknown as ReactFlowInstance;
  const wrapRef = { current: null };
  const hook = renderHook(
    (props: { nodes: Node[] }) => useBoardCamera({ rfInstance: rf, boardId, selectedNodeId: null, displayNodes: props.nodes, wrapRef, fitOptions }),
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

  it("restores a remembered viewport instead of fitting", () => {
    writeViewport("kept", { x: 5, y: 6, zoom: 0.5 });
    const { rf, hook } = setup("kept", [card("a")]);
    expect(hook.result.current.fitOnOpen).toBe(false);
    expect(rf.fitView).not.toHaveBeenCalled();
    expect(rf.setViewport).toHaveBeenCalledWith({ x: 5, y: 6, zoom: 0.5 });
  });
});
