// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
vi.mock("@xyflow/react", () => ({ MarkerType: { ArrowClosed: "arrowclosed" } }));
import { useGraphLayout } from "../hooks/useGraphLayout";
import type { ContentNode, Canvas } from "../lib/api";
import { FOLDED_CARD_H } from "../lib/cardDisplay";

const nodes: ContentNode[] = Array.from({ length: 20 }, (_, i) => ({
  id: `n${i}`, title: `Note ${i}`, slug: `n${i}`, markdown: "#text-only is not a tag",
  label_tag_ids: ["t-shared", "t-second"],
  source_type: "manual", node_type: "content", parent_id: i === 1 ? "n0" : null,
}));
const tags = [{ id: "t-shared", name: "shared" }, { id: "t-second", name: "second" }];
const canvas: Canvas = { id: "board", title: "Board", created_at: "", updated_at: "",
  data: { nodes: nodes.map((n, i) => ({ nodeId: n.id, x: i * 300, y: 0, width: 260, height: 200 })) } };
function useLayoutFixture(selectedNode: ContentNode | null, local = false, extraNodes: ContentNode[] = []) {
  return useGraphLayout({ nodes: [...nodes, ...extraNodes], edges: [], activeCanvas: canvas,
    mode: "notes", notesView: "canvas", selectedNode, selectedId: selectedNode?.id ?? null,
    graphLocalMode: local, canvasSearch: "", showTagEdges: true, tags });
}

describe("canvas density and shared-tag hints", () => {
  it("overlapping groups count the same stored members, including filtered cards", () => {
    const board: Canvas = { ...canvas, data: { ...canvas.data, sections: [
      { id: "inner", title: "Inner", x: 0, y: 0, width: 300, height: 250 },
      { id: "outer", title: "Outer", x: 0, y: 0, width: 900, height: 250 },
    ] } };
    const { result } = renderHook(() => useGraphLayout({ nodes, edges: [], activeCanvas: board,
      mode: "notes", notesView: "canvas", selectedNode: nodes[0], selectedId: "n0",
      graphLocalMode: false, canvasSearch: "Note 0", showTagEdges: false }));
    const groups = result.current.displayGraphNodes.filter(n => n.type === "section");
    expect(groups.map(g => g.data.cardCount)).toEqual([1, 3]);

  });
  it("20 peers form 19 hints around the selection, with shared labels combined", () => {
    const before = JSON.stringify(canvas);
    const { result } = renderHook(() => useLayoutFixture(nodes[0]));
    const hints = result.current.displayGraphEdges.filter(e => e.id.startsWith("tag-"));
    expect(hints).toHaveLength(19);
    expect(hints.every(e => e.source === "n0" && e.label === "#shared · #second")).toBe(true);
    expect(hints.every(e => e.selectable === false && e.data?.derived === true)).toBe(true);
    expect(JSON.stringify(canvas)).toBe(before);
  });
  it("a #word in the text makes no hint: only stored tags are shared (T10)", () => {
    const textOnly = nodes.map((n) => ({ ...n, label_tag_ids: [], markdown: "#shared #second" }));
    const { result } = renderHook(() => useGraphLayout({ nodes: textOnly, edges: [], activeCanvas: canvas,
      mode: "notes", notesView: "canvas", selectedNode: textOnly[0], selectedId: "n0",
      graphLocalMode: false, canvasSearch: "", showTagEdges: true, tags }));
    expect(result.current.displayGraphEdges.filter(e => e.id.startsWith("tag-"))).toHaveLength(0);
  });
  it("no selected card means no derived tag web; the board is not a focus target", () => {
    const { result } = renderHook(() => useLayoutFixture({ ...nodes[0], id: "board", node_type: "canvas" }, true));
    expect(result.current.displayGraphNodes).toHaveLength(20);
    expect(result.current.displayGraphEdges.filter(e => e.id.startsWith("tag-"))).toHaveLength(0);
  });
  it("local focus includes tree relationships and never emits a hint to an absent card", () => {
    const { result } = renderHook(() => useLayoutFixture(nodes[1], true, [{ ...nodes[0], id: "off-board" }]));
    expect(result.current.displayGraphNodes.map(n => n.id)).toEqual(["n0", "n1"]);
    const ids = new Set(result.current.displayGraphNodes.map(n => n.id));
    expect(result.current.displayGraphEdges.every(e => ids.has(e.source) && ids.has(e.target))).toBe(true);
  });
});

describe("how the board's cards are folded (lib/cardDisplay)", () => {
  const draw = (display?: Parameters<typeof useGraphLayout>[0]["display"]) =>
    renderHook(() => useGraphLayout({ nodes, edges: [], activeCanvas: canvas, display,
      mode: "notes", notesView: "canvas", selectedNode: null, selectedId: null,
      graphLocalMode: false, canvasSearch: "", showTagEdges: false })).result.current.displayGraphNodes.filter(n => n.type === "card");

  it("a card the person chose for beats the board default; the rest follow it", () => {
    const cards = draw({ cardDefault: "folded", expandedIds: ["n3"] });
    expect(cards.find(c => c.id === "n3")!.data.folded).toBe(false);
    expect(cards.find(c => c.id === "n4")!.data.folded).toBe(true);
  });

  it("a folded card is drawn at the title bar's height; an expanded one keeps the height saved with it", () => {
    const cards = draw({ foldedIds: ["n1"] });
    expect(cards.find(c => c.id === "n1")!.style?.height).toBe(FOLDED_CARD_H);
    expect(cards.find(c => c.id === "n2")!.style?.height).toBe(200);
  });

  it("folding changes nothing saved with the board", () => {
    const before = JSON.stringify(canvas);
    draw({ cardDefault: "folded" });
    expect(JSON.stringify(canvas)).toBe(before);
  });

  it("each card knows how wide its title may grow in far zoom", () => {
    const cards = draw();
    expect(cards.every(c => typeof c.data.maxTitleWidth === "number" && c.data.maxTitleWidth >= 260)).toBe(true);
  });
});
