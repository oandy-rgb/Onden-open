import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Letting go of a fast drag glides the board; its viewport is saved once, when the glide ends,
// not at the move end React Flow reports (on a later tick) for each glide step.

const saved: unknown[] = [];
vi.mock("../lib/canvasViewport", () => ({ readViewport: () => null, writeViewport: (_id: string, v: unknown) => { saved.push(v); } }));

import { useBoardCamera } from "../hooks/useBoardCamera";

describe("useBoardCamera glide", () => {
  let frames: Array<(t: number) => void> = [];
  beforeEach(() => {
    saved.length = 0; frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => { frames.push(cb); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("ignores the move ends of the glide's own steps and saves when it comes to rest", () => {
    let view = { x: 0, y: 0, zoom: 1 };
    const rf = { getViewport: () => view, setViewport: (v: typeof view) => { view = v; return Promise.resolve(true); }, getZoom: () => 1, fitView: vi.fn(), getNode: vi.fn() };
    const { result } = renderHook(() => useBoardCamera({
      rfInstance: rf as never, boardId: "b", selectedNodeId: null, displayNodes: [],
      wrapRef: { current: null }, fitOptions: {}, openPadding: { top: 0, right: 0, bottom: 0, left: 0 }, readableOpen: true,
    }));
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const event = { type: "mousemove" } as MouseEvent;
    act(() => { result.current.onMoveStart(event, { zoom: 1 }); });
    for (const t of [0, 20, 40]) { now = t; act(() => { result.current.onMove(event, { x: t * 3, y: 0 }); }); }
    saved.length = 0;
    act(() => { result.current.onMoveEnd(event, { zoom: 1 }); });
    expect(frames.length).toBeGreaterThan(0); // gliding
    for (let i = 1; i <= 3; i++) {
      act(() => { frames.shift()!(i * 16); });
      act(() => { result.current.onMoveEnd(null, { zoom: 1 }); }); // React Flow's deferred end for that step
    }
    expect(saved).toHaveLength(0);
    for (let i = 4; i <= 2000 && frames.length; i++) act(() => { frames.shift()!(i * 16); });
    expect(saved.length).toBeGreaterThanOrEqual(1);
  });
});
