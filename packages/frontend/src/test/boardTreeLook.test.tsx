// How the sub-note tree is drawn on the board: parent lines leave the parent's right edge and turn into the
// child's left edge at right angles, the root is marked for a larger title, and the row spacing follows the card height
// the board actually draws (folded cards sit closer).
import { renderHook } from "@testing-library/react";
import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
let displaySettings: CardDisplaySettings = {};
vi.mock("../hooks/useBoardTreeSettings", () => ({ useBoardTreeSettings: () => ({ settings: { mode: "auto" }, save: vi.fn() }) }));
vi.mock("../hooks/useBoardDisplaySettings", () => ({ useBoardDisplaySettings: () => ({ settings: displaySettings, save: vi.fn() }) }));
import { useBoardTree } from "../hooks/useBoardTree";
import type { Canvas, ContentNode } from "../lib/api";
import { EXPANDED_CARD_MAX_H, FOLDED_CARD_H, type CardDisplaySettings } from "../lib/cardDisplay";

const note = (id: string, parent: string | null, minute = 0): ContentNode =>
  ({ id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", parent_id: parent, hidden: false,
    updated_at: `2026-10-29T10:${String(minute).padStart(2, "0")}:00Z` }) as ContentNode;
const nodes = [note("r", null), note("a", "r", 1), note("b", "r", 2), note("a1", "a")];
const canvas: Canvas = { id: "r", title: "r", created_at: "", updated_at: "", data: { nodes: [] } };
const card = (id: string): Node => ({ id, type: "card", position: { x: 0, y: 0 }, data: {} });
const parentLine = (child: string, parent: string): Edge => ({ id: `parent-${child}`, source: parent, target: child, type: "parentEdge", data: {} });

const tree = (display: CardDisplaySettings = {}) => { displaySettings = display; return renderHook(() => useBoardTree({ activeCanvas: canvas, nodes, tags: [], shown: true })).result.current; };

describe("the sub-note tree's look", () => {
  it("lays the tree out left to right: the root at the left, each level one column further right, siblings in a column", () => {
    const at = new Map(tree().canvas!.data.nodes.map((c) => [c.nodeId, c]));
    expect(at.get("a")!.x).toBeGreaterThan(at.get("r")!.x);
    expect(at.get("b")!.x).toBe(at.get("a")!.x);
    expect(at.get("a1")!.x).toBeGreaterThan(at.get("a")!.x);
    expect(at.get("b")!.y).toBeLessThan(at.get("a")!.y);
  });

  it("draws each parent line from the parent's right edge into the child's left edge, at right angles", () => {
    const board = tree();
    const { edges } = board.decorate(nodes.map((n) => card(n.id)), [parentLine("a", "r"), parentLine("b", "r"), parentLine("a1", "a")]);
    for (const edge of edges) {
      expect(edge).toMatchObject({ type: "parentEdge", sourceHandle: "r", targetHandle: "l", data: { step: true } });
    }
  });

  it("leaves a line that is not a parent line of the tree as it was", () => {
    const board = tree();
    const link: Edge = { id: "e1", source: "a", target: "b", type: "default" };
    expect(board.decorate([card("a")], [link]).edges).toEqual([link]);
  });

  it("marks only the root card for the larger title", () => {
    const board = tree();
    const { nodes: drawn } = board.decorate(nodes.map((n) => card(n.id)), []);
    expect(drawn.filter((n) => n.data.treeRoot).map((n) => n.id)).toEqual(["r"]);
  });

  it("spaces siblings by the height each card is drawn at: folded cards sit closer than expanded ones", () => {
    const rowPitch = (display: CardDisplaySettings) => {
      const at = new Map(tree(display).canvas!.data.nodes.map((c) => [c.nodeId, c]));
      return at.get("a")!.y - at.get("b")!.y;
    };
    expect(rowPitch({})).toBe(EXPANDED_CARD_MAX_H + 28);
    expect(rowPitch({ cardDefault: "folded" })).toBe(FOLDED_CARD_H + 28);
    // One card the person folded among expanded ones: the row after it moves up, nothing overlaps.
    expect(rowPitch({ foldedIds: ["b"] })).toBe(FOLDED_CARD_H + 28);
  });
});
