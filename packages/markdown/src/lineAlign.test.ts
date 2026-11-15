import { describe, expect, it } from "vitest";
import { alignLines } from "./lineAlign.js";

const lines = (s: string): string[] => (s === "" ? [] : s.split(" "));

describe("alignLines", () => {
  it("pairs identical text line by line", () => {
    expect(alignLines(lines("a b c"), lines("a b c"))).toEqual({ from: [0, 1, 2], removed: [] });
  });

  it("marks an inserted line new and keeps the others", () => {
    expect(alignLines(lines("a c"), lines("a b c"))).toEqual({ from: [0, null, 1], removed: [] });
  });

  it("marks a deleted line removed", () => {
    expect(alignLines(lines("a b c"), lines("a c"))).toEqual({ from: [0, 2], removed: [1] });
  });

  it("follows a line that moved", () => {
    const r = alignLines(lines("a b c d"), lines("b c d a"));
    expect(r.from).toEqual([1, 2, 3, 0]);
    expect(r.removed).toEqual([]);
  });

  it("pairs repeated lines in order", () => {
    const r = alignLines(lines("x y x"), lines("x x y x"));
    expect(r.from.filter((f) => f !== null)).toHaveLength(3);
    expect(r.from.filter((f) => f === null)).toHaveLength(1);
    expect(r.removed).toEqual([]);
  });

  it("reads re-indented lines as the same lines", () => {
    expect(alignLines(["x = 1", "y = 2"], ["if (c) {", "  x = 1", "  y = 2", "}"]).from).toEqual([null, 0, 1, null]);
  });

  it("handles empty sides", () => {
    expect(alignLines([], ["a"])).toEqual({ from: [null], removed: [] });
    expect(alignLines(["a"], [])).toEqual({ from: [], removed: [0] });
  });

  it("uses a line once", () => {
    const r = alignLines(["a"], ["a", "a"]);
    expect(r.from.filter((f) => f === 0)).toHaveLength(1);
  });

  it("stays fast on large texts", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i % 50}`);
    const r = alignLines(big, [...big.slice(0, 100), "new", ...big.slice(100)]);
    expect(r.from.filter((f) => f === null).length).toBeGreaterThanOrEqual(1);
  });
});
