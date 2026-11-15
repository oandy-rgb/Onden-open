import { describe, expect, it } from "vitest";
import { createLabelPlacer, labelBudget, neighbourhoodOf, nodeRadius, showsLabel, tapStep } from "./graphInteraction";

describe("names by zoom level", () => {
  it("names more points the closer you are", () => {
    expect(labelBudget(0.3)).toBeLessThan(labelBudget(1));
    expect(labelBudget(1)).toBeLessThan(labelBudget(3));
    expect(labelBudget(0.1)).toBeGreaterThanOrEqual(5);
  });
  it("far out only the best-linked are named; a lit point always is", () => {
    expect(showsLabel(0, 0.3, false)).toBe(true);
    expect(showsLabel(40, 0.3, false)).toBe(false);
    expect(showsLabel(40, 0.3, true)).toBe(true);
    expect(showsLabel(40, 3, false)).toBe(true);
  });
  it("skips a name that would cover one already written", () => {
    const placer = createLabelPlacer();
    expect(placer.tryPlace({ x: 0, y: 0, w: 40, h: 10 })).toBe(true);
    expect(placer.tryPlace({ x: 30, y: 4, w: 40, h: 10 })).toBe(false);
    expect(placer.tryPlace({ x: 30, y: 12, w: 40, h: 10 })).toBe(true);
    placer.reset();
    expect(placer.tryPlace({ x: 30, y: 4, w: 40, h: 10 })).toBe(true);
  });
});

it("a point grows with its lines, but not without bound", () => {
  expect(nodeRadius(1)).toBeGreaterThan(nodeRadius(0));
  expect(nodeRadius(9)).toBeGreaterThan(nodeRadius(1));
  expect(nodeRadius(10_000)).toBeLessThanOrEqual(13);
});

describe("tap once to light, again to open", () => {
  it("first tap lights without opening; tapping the lit one opens it; another one moves the light", () => {
    expect(tapStep(null, "a")).toEqual({ lit: "a", open: null });
    expect(tapStep("a", "a")).toEqual({ lit: null, open: "a" });
    expect(tapStep("a", "b")).toEqual({ lit: "b", open: null });
  });
  it("lights the point and the other end of its lines, whether ends are ids or node objects", () => {
    const lines = [{ source: "a", target: "b" }, { source: { id: "c" }, target: { id: "a" } }, { source: "x", target: "y" }];
    expect([...neighbourhoodOf("a", lines)].sort()).toEqual(["a", "b", "c"]);
  });
});
