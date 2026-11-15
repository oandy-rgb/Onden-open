import { describe, expect, it } from "vitest";
import { stepForKey, swipeStep } from "./stepsNav.js";

describe("stepForKey", () => {
  it("moves with the arrow keys within bounds", () => {
    expect(stepForKey("ArrowRight", 0, 3)).toBe(1);
    expect(stepForKey("ArrowLeft", 2, 3)).toBe(1);
    expect(stepForKey("ArrowLeft", 0, 3)).toBeNull();
    expect(stepForKey("ArrowRight", 2, 3)).toBeNull();
  });
  it("jumps with Home and End, ignores other keys", () => {
    expect(stepForKey("End", 0, 4)).toBe(3);
    expect(stepForKey("Home", 3, 4)).toBe(0);
    expect(stepForKey("a", 1, 4)).toBeNull();
  });
});

describe("swipeStep", () => {
  it("a clear swipe left goes forward, right goes back", () => {
    expect(swipeStep(-80, 5)).toBe(1);
    expect(swipeStep(80, -5)).toBe(-1);
  });
  it("short or mostly vertical moves are left to the page", () => {
    expect(swipeStep(-20, 0)).toBe(0);
    expect(swipeStep(-60, 90)).toBe(0);
  });
});
