import { describe, expect, it } from "vitest";
import { threeWayMergeBody } from "../services/eventLog/bodyMerge.js";

// Two writers insert at the same point and their texts share a head or tail:
// the shared part lands once. `incoming` is the later save, `current` the server body.

const merge = (base: string, incoming: string, current: string) => {
  const r = threeWayMergeBody(base, incoming, current);
  // Which side landed first must not matter.
  expect(threeWayMergeBody(base, current, incoming).merged).toBe(r.merged);
  expect(r).toMatchObject({ clean: true, conflicts: [] });
  return r.merged;
};
const count = (text: string, part: string) => text.split(part).length - 1;

describe("two insertions at one point with a shared head or tail", () => {
  it("a list item both added, plus one more on one side", () => {
    expect(merge("A\n", "A\n- milk\n- eggs\n", "A\n- milk\n")).toBe("A\n- milk\n- eggs\n");
    expect(merge("A\n", "A\n- milk\n", "A\n- milk\n- eggs\n")).toBe("A\n- milk\n- eggs\n");
  });

  it("one side's text continues the other's inside a line", () => {
    expect(merge("hello\n", "hello world!\n", "hello world\n")).toBe("hello world!\n");
    expect(merge("hello\n", "hello world\n", "hello world!\n")).toBe("hello world!\n");
  });

  it("the shared part is at the end", () => {
    expect(merge("A\n", "A\n- eggs\n- milk\n", "A\n- milk\n")).toBe("A\n- eggs\n- milk\n");
    expect(merge("A\n", "A\n- milk\n", "A\n- eggs\n- milk\n")).toBe("A\n- eggs\n- milk\n");
  });

  it("both start the same but neither is a prefix of the other", () => {
    const merged = merge("A\n", "A\n- milk\n- eggs\n", "A\n- milk\n- bread\n");
    expect(count(merged, "- milk\n")).toBe(1);
    expect(merged).toBe("A\n- milk\n- bread\n- eggs\n");
  });

  it("a shared head and a shared tail with different middles", () => {
    const merged = merge("A\n", "A\n- milk\n- eggs\n- tea\n", "A\n- milk\n- bread\n- tea\n");
    expect(merged).toBe("A\n- milk\n- bread\n- eggs\n- tea\n");
  });

  it("one side's list has an extra item in the middle of the shared items", () => {
    const merged = merge("T\n", "T\n- a\n- b\n- c\n- d\n", "T\n- a\n- b\n- x\n- c\n- d\n");
    expect(merged).toBe("T\n- a\n- b\n- x\n- c\n- d\n");
  });

  it("head and tail do not overlap when the shorter insertion repeats a line", () => {
    const merged = merge("A\n", "A\n- x\n", "A\n- x\n- x\n");
    expect(merged).toBe("A\n- x\n- x\n");
  });

  it("a shared head is cut at a line edge, not inside a line", () => {
    const merged = merge("A\n", "A\n- milk\n- eggs\n", "A\n- mixed\n");
    expect(merged).toBe("A\n- milk\n- eggs\n- mixed\n");
  });

  it("replaying the merge gives the same body", () => {
    const first = merge("A\n", "A\n- milk\n- eggs\n", "A\n- milk\n- bread\n");
    expect(threeWayMergeBody("A\n", "A\n- milk\n- eggs\n", first).merged).toBe(first);
  });
});
