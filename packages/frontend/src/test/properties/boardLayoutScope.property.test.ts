// Random screens through the board's layout hook (hooks/useGraphLayout): the cards and arrows are the board's, never the workspace's.
//
//   1 no board on screen (another mode, or a view that is not a board): no cards, no arrows, however many notes there are
//   2 a board on screen: one card per placed note that exists, nothing for a note the board does not hold
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/boardLayoutScope.property.test.ts

import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import fc from "fast-check";
vi.mock("@xyflow/react", () => ({ MarkerType: { ArrowClosed: "arrowclosed" } }));
import { useGraphLayout } from "../../hooks/useGraphLayout";
import type { Canvas, ContentNode } from "../../lib/api";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const note = (i: number): ContentNode => ({
  id: `n${i}`, title: `Note ${i}`, slug: `n${i}`, markdown: "", source_type: "manual", node_type: "content", parent_id: i % 3 === 0 && i > 0 ? `n${i - 1}` : null,
} as ContentNode);

const screen = fc.record({
  mode: fc.constantFrom("notes", "tasks", "timeline", "graph"),
  notesView: fc.constantFrom("canvas", "editor", "list"),
  openBoardId: fc.constantFrom<string | null>(null, "board"),
  withBoard: fc.boolean(),
});

describe("the board layout is the board's", () => {
  it("draws nothing without a board on screen, and only placed notes with one", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 60 }), fc.uniqueArray(fc.integer({ min: 0, max: 80 }), { maxLength: 15 }), screen, (count, placed, s) => {
      const nodes = Array.from({ length: count }, (_, i) => note(i));
      const board: Canvas = { id: "board", title: "B", created_at: "", updated_at: "", data: { nodes: placed.map((i) => ({ nodeId: `n${i}`, x: i * 10, y: 0 })) } };
      const { result } = renderHook(() => useGraphLayout({ nodes, edges: [], activeCanvas: s.withBoard ? board : null,
        mode: s.mode, notesView: s.notesView, openBoardId: s.openBoardId, selectedNode: null, selectedId: null,
        graphLocalMode: false, canvasSearch: "", showTagEdges: false }));
      const shown = s.mode === "notes" && (s.notesView === "canvas" || (s.notesView === "editor" && !!s.openBoardId)) && s.withBoard;
      const cards = result.current.displayGraphNodes.filter((n) => n.type === "card").map((n) => n.id).sort();
      if (!shown) {
        expect(result.current.displayGraphNodes).toEqual([]);
        expect(result.current.displayGraphEdges).toEqual([]);
      } else {
        expect(cards).toEqual(placed.filter((i) => i < count).map((i) => `n${i}`).sort());
      }
    }), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, 150) });
  });

  it("scan 08 #11: a task or timeline screen with 5000 notes gets no cards (it used to lay out every note)", () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => note(i));
    const { result } = renderHook(() => useGraphLayout({ nodes, edges: [], activeCanvas: null, mode: "tasks", notesView: "canvas",
      selectedNode: null, selectedId: null, graphLocalMode: false, canvasSearch: "", showTagEdges: false }));
    expect(result.current.displayGraphNodes).toEqual([]);
  });
});
