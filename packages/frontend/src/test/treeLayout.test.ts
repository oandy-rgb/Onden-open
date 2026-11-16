import { describe, it, expect } from "vitest";
import { computeTreeLayout } from "../lib/treeLayout";
import type { ContentNode } from "../lib/api";

// Canvas "Auto-arrange as tree" geometry. Pure: depth → x columns, siblings
// stack vertically, a parent centers on its children's span, collapsed
// subtrees prune, hidden + class-tag instance nodes are excluded.
// Constants: NODE_W 280, NODE_H 200, COL_GAP 80, ROW_GAP 60 → column pitch 360.

const COL = 280 + 80; // 360
const node = (id: string, over: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title: id, slug: id, markdown: "", parent_id: null, ...over } as ContentNode);

describe("computeTreeLayout", () => {
  it("places a lone root at the origin", () => {
    const pos = computeTreeLayout("r", [node("r")]);
    expect(pos.get("r")).toEqual({ x: 0, y: 0 });
  });

  it("columns children by depth", () => {
    const pos = computeTreeLayout("r", [
      node("r"),
      node("a", { parent_id: "r" }),
      node("b", { parent_id: "a" }),
    ]);
    expect(pos.get("r")!.x).toBe(0);
    expect(pos.get("a")!.x).toBe(COL);
    expect(pos.get("b")!.x).toBe(2 * COL);
  });

  it("stacks siblings vertically by NODE_H + ROW_GAP", () => {
    const pos = computeTreeLayout("r", [
      node("r"),
      node("c0", { parent_id: "r", order_key: "a0" }),
      node("c1", { parent_id: "r", order_key: "a1" }),
    ]);
    expect(pos.get("c0")!.y).toBe(0);
    expect(pos.get("c1")!.y).toBe(260); // 200 + 60
  });

  it("centers a parent on its children's vertical span", () => {
    const pos = computeTreeLayout("r", [
      node("r"),
      node("c0", { parent_id: "r", order_key: "a0" }),
      node("c1", { parent_id: "r", order_key: "a1" }),
    ]);
    // child centers: 100 and 360 → span center 230 → parentY = 230 - 100
    expect(pos.get("r")!.y).toBe(130);
  });

  it("orders siblings by order_key, not array order", () => {
    const pos = computeTreeLayout("r", [
      node("r"),
      node("late", { parent_id: "r", order_key: "a5" }),
      node("early", { parent_id: "r", order_key: "a1" }),
    ]);
    expect(pos.get("early")!.y).toBeLessThan(pos.get("late")!.y);
  });

  it("prunes a collapsed subtree (children get no position)", () => {
    const pos = computeTreeLayout("r", [
      node("r"),
      node("a", { parent_id: "r" }),
      node("b", { parent_id: "a" }),
    ], new Set(["a"]));
    expect(pos.has("a")).toBe(true);
    expect(pos.has("b")).toBe(false);
  });

  it("excludes hidden nodes and class-tag instances from the tree", () => {
    const pos = computeTreeLayout("r", [
      node("r"),
      node("vis", { parent_id: "r" }),
      node("hid", { parent_id: "r", hidden: true }),
      node("inst", { parent_id: "r", class_tag_ids: ["tag1"] }),
    ]);
    expect(pos.has("vis")).toBe(true);
    expect(pos.has("hid")).toBe(false);
    expect(pos.has("inst")).toBe(false);
    // with only one effective child, the root centers on it (same y)
    expect(pos.get("r")!.y).toBe(pos.get("vis")!.y);
  });
});
