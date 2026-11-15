import { describe, it, expect } from "vitest";
import type { ContentNode } from "../lib/api";

// Mirror of the layout logic in BuilderApp (kept in sync)
const CARD_W = 260, CARD_H = 160, GAP_X = 40, GAP_Y = 40, COLS = 4, GROUP_GAP = 80;

function computeGlobalPositions(nodes: ContentNode[]): Map<string, { x: number; y: number }> {
  const visible = nodes.filter((n) => !n.hidden);
  const groups = new Map<string | null, ContentNode[]>();
  visible.forEach((n) => {
    const key = n.parent_id ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  });
  const positions = new Map<string, { x: number; y: number }>();
  let cursorX = 0;
  groups.forEach((groupNodes) => {
    groupNodes.forEach((node, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      positions.set(node.id, { x: cursorX + col * (CARD_W + GAP_X), y: row * (CARD_H + GAP_Y) });
    });
    const clusterCols = Math.min(groupNodes.length, COLS);
    cursorX += clusterCols * (CARD_W + GAP_X) + GROUP_GAP;
  });
  return positions;
}

const makeNode = (id: string, overrides: Partial<ContentNode> = {}): ContentNode => ({
  id, title: id, slug: id, markdown: "", node_type: "content",
  source_type: "manual", ...overrides,
});

describe("globalPositions layout", () => {
  it("assigns unique positions to all nodes", () => {
    const nodes = ["a", "b", "c", "d", "e"].map((id) => makeNode(id));
    const pos = computeGlobalPositions(nodes);
    const posSet = new Set(Array.from(pos.values()).map((p) => `${p.x},${p.y}`));
    expect(posSet.size).toBe(nodes.length);
  });

  it("wraps to next row after COLS (4) nodes", () => {
    const nodes = ["a", "b", "c", "d", "e"].map((id) => makeNode(id));
    const pos = computeGlobalPositions(nodes);
    const fifth = pos.get("e")!;
    expect(fifth.x).toBe(0);
    expect(fifth.y).toBe(CARD_H + GAP_Y);
  });

  it("first node is at origin for ungrouped nodes", () => {
    const nodes = [makeNode("n1")];
    const pos = computeGlobalPositions(nodes);
    expect(pos.get("n1")).toEqual({ x: 0, y: 0 });
  });

  it("places second group to the right of the first", () => {
    const group1 = makeNode("g1");
    const g1child = makeNode("c1", { parent_id: "p1" });
    const g2child = makeNode("c2", { parent_id: "p2" });
    const nodes = [group1, g1child, g2child];
    const pos = computeGlobalPositions(nodes);
    // ungrouped comes first, then p1 group, then p2 group
    const c2x = pos.get("c2")?.x ?? 0;
    const c1x = pos.get("c1")?.x ?? 0;
    expect(c2x).toBeGreaterThan(c1x);
  });

  it("excludes hidden nodes", () => {
    const hidden = makeNode("h1", { hidden: true });
    const visible = makeNode("v1");
    const pos = computeGlobalPositions([hidden, visible]);
    expect(pos.has("h1")).toBe(false);
    expect(pos.has("v1")).toBe(true);
  });

  it("handles empty node list", () => {
    expect(computeGlobalPositions([])).toEqual(new Map());
  });

  it("column spacing is CARD_W + GAP_X", () => {
    const nodes = ["a", "b"].map((id) => makeNode(id));
    const pos = computeGlobalPositions(nodes);
    expect(pos.get("b")!.x - pos.get("a")!.x).toBe(CARD_W + GAP_X);
  });

  it("row spacing is CARD_H + GAP_Y", () => {
    const nodes = Array.from({ length: 5 }, (_, i) => makeNode(`n${i}`));
    const pos = computeGlobalPositions(nodes);
    expect(pos.get("n4")!.y).toBe(CARD_H + GAP_Y);
    expect(pos.get("n0")!.y).toBe(0);
  });
});
