import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { alignCanvasCards, type CanvasAlignment } from "../lib/canvasAlignment";

function cards(): Node[] {
  return [
    { id: "a", type: "card", position: { x: 30, y: 70 }, data: {}, measured: { width: 330, height: 270 }, style: { width: 900, height: 900 } },
    { id: "b", type: "card", position: { x: 450, y: 450 }, data: {}, measured: { width: 260, height: 81 }, width: 900, height: 900 },
    { id: "c", type: "card", position: { x: 1000, y: 1000 }, data: {}, measured: { width: 200, height: 58 } },
  ];
}

function result(nodes: Node[], mode: CanvasAlignment) {
  const updates = alignCanvasCards(nodes, nodes.map(n => n.id), mode);
  return nodes.map(n => ({ ...n, position: updates.find(u => u.nodeId === n.id) ?? n.position }));
}

describe("canvas selection alignment", () => {
  it.each([
    ["left", "x", "width", 0], ["centerX", "x", "width", 0.5], ["right", "x", "width", 1],
    ["top", "y", "height", 0], ["middleY", "y", "height", 0.5], ["bottom", "y", "height", 1],
  ] as const)("%s aligns visible geometry, preserving the other axis and sizes", (mode, axis, dimension, fraction) => {
    const before = cards();
    const after = result(before, mode);
    const edges = after.map(n => n.position[axis] + n.measured![dimension]! * fraction);
    expect(Math.max(...edges) - Math.min(...edges)).toBeLessThanOrEqual(1);
    after.forEach((n, i) => {
      const otherAxis = axis === "x" ? "y" : "x";
      expect(n.position[otherAxis]).toBe(before[i].position[otherAxis]);
      expect(n.measured).toEqual(before[i].measured);
      expect(n.style).toEqual(before[i].style);
    });
    expect(before).toEqual(cards());
  });

  it.each(["distH", "distV"] as const)("%s produces equal edge gaps and preserves both ends", mode => {
    const before = cards();
    const after = result(before, mode);
    const axis = mode === "distH" ? "x" : "y";
    const dimension = mode === "distH" ? "width" : "height";
    const gaps = after.slice(1).map((n, i) => n.position[axis] - after[i].position[axis] - after[i].measured![dimension]!);
    expect(Math.abs(gaps[0] - gaps[1])).toBeLessThanOrEqual(1);
    expect(after[0].position[axis]).toBe(before[0].position[axis]);
    expect(after[2].position[axis]).toBe(before[2].position[axis]);
  });

  it("uses explicit sizes, then defaults, until measurement is available", () => {
    const nodes: Node[] = [
      { id: "a", type: "card", position: { x: 0, y: 0 }, data: {}, style: { width: 330, height: 270 } },
      { id: "b", type: "card", position: { x: 0, y: 0 }, data: {} },
    ];
    expect(alignCanvasCards(nodes, ["a", "b"], "bottom")).toEqual([{ nodeId: "b", x: 0, y: 70 }]);
    expect(alignCanvasCards(nodes, ["a", "b"], "right")).toEqual([{ nodeId: "b", x: 70, y: 0 }]);
  });

  it("ignores unselected cards and sections, returning positions only", () => {
    const nodes = [...cards(), { id: "group", type: "section", position: { x: -1000, y: -1000 }, data: {} }];
    expect(alignCanvasCards(nodes, ["a", "b", "group"], "bottom"))
      .toEqual([{ nodeId: "a", x: 30, y: 261 }]);
    expect(nodes.slice(0, 3)).toEqual(cards());
  });

  it("does not save insufficient selections or already aligned cards", () => {
    const nodes = cards();
    expect(alignCanvasCards(nodes, ["a"], "left")).toEqual([]);
    expect(alignCanvasCards(nodes, ["a", "b"], "distH")).toEqual([]);
    expect(alignCanvasCards(result(nodes, "bottom"), ["a", "b", "c"], "bottom")).toEqual([]);
  });
});
