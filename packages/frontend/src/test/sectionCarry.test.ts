import { describe, it, expect } from "vitest";
import { cardsInSection, boundingSectionRect, captureCanvasPositions } from "../lib/sectionCarry";
import type { CanvasSection } from "../lib/api";

const section: CanvasSection = { id: "s1", x: 0, y: 0, width: 400, height: 300, title: "G" };

describe("section carry (群組框)", () => {
  it("captures the union of explicit cards and overlapping group members exactly once", () => {
    const data = {
      nodes: [{ nodeId: "shared", x: 0, y: 0 }, { nodeId: "outer-only", x: 450, y: 0 }, { nodeId: "loose", x: 900, y: 0 }],
      sections: [section, { ...section, id: "outer", width: 800 }],
    };
    const before = structuredClone(data);
    const positions = captureCanvasPositions(data, ["shared", "loose"], ["s1", "outer"]);
    expect(positions.nodes).toEqual(data.nodes);
    expect(positions.sections).toEqual([{ id: "s1", x: 0, y: 0 }, { id: "outer", x: 0, y: 0 }]);
    expect(data).toEqual(before);
    data.nodes[0].x = 500;
    expect(positions.nodes[0].x).toBe(0);
  });

  it("captures unselected stored members, but not cards added after the gesture began", () => {
    const data = { nodes: [{ nodeId: "hidden", x: 0, y: 0 }], sections: [section] };
    const positions = captureCanvasPositions(data, [], ["s1"]);
    data.nodes.push({ nodeId: "later", x: 20, y: 20 });
    expect(positions.nodes).toEqual([{ nodeId: "hidden", x: 0, y: 0 }]);
    expect(captureCanvasPositions(data, ["missing"], ["missing"])).toEqual({ nodes: [], sections: [] });
  });
  it("uses the displayed stored defaults and folded height for membership and grouping", () => {
    const narrow = { ...section, width: 300, height: 80 };
    const normal = { nodeId: "normal", x: 0, y: 0 };
    const folded = { nodeId: "folded", x: 0, y: 0, folded: true };
    expect(cardsInSection(narrow, [normal, folded]).map(n => n.nodeId)).toEqual(["folded"]);
    expect(boundingSectionRect([normal])).toEqual({ x: -40, y: -64, width: 340, height: 304 });
    expect(boundingSectionRect([folded])).toEqual({ x: -40, y: -64, width: 340, height: 148 });
  });
  it("scan 08 #8: a card folded by the board's display settings is short for membership and grouping", () => {
    const narrow = { ...section, width: 300, height: 80 };
    const card = { nodeId: "c", x: 0, y: 0 };
    // The old `folded` flag is not written any more: the fold is the board's settings.
    expect(cardsInSection(narrow, [card]).map(n => n.nodeId)).toEqual([]);
    expect(cardsInSection(narrow, [card], { cardDefault: "folded" }).map(n => n.nodeId)).toEqual(["c"]);
    expect(cardsInSection(narrow, [card], { foldedIds: ["c"] }).map(n => n.nodeId)).toEqual(["c"]);
    expect(cardsInSection(narrow, [card], { cardDefault: "folded", expandedIds: ["c"] }).map(n => n.nodeId)).toEqual([]);
    expect(boundingSectionRect([card], { cardDefault: "folded" })).toEqual({ x: -40, y: -64, width: 340, height: 148 });
    // Dragging the group takes the folded card with it.
    const grab = captureCanvasPositions({ nodes: [card], sections: [narrow] }, [], ["s1"], { cardDefault: "folded" });
    expect(grab.nodes).toEqual([{ nodeId: "c", x: 0, y: 0 }]);
  });
  it("membership is by card CENTER inside the section rect", () => {
    const entries = [
      { nodeId: "in", x: 50, y: 50, width: 200, height: 100 },          // center 150,100 → in
      { nodeId: "edge-out", x: 350, y: 250, width: 200, height: 100 },  // center 450,300 → x out
      { nodeId: "far", x: 900, y: 900 },                                // out
    ];
    expect(cardsInSection(section, entries).map((c) => c.nodeId)).toEqual(["in"]);
  });

  it("boundingSectionRect frames the cards with padding + title room", () => {
    const r = boundingSectionRect([
      { x: 100, y: 100, width: 240, height: 120 },
      { x: 500, y: 400, width: 240, height: 120 },
    ]);
    expect(r).toEqual({ x: 60, y: 36, width: 720, height: 524 });
  });
});
