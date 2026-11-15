import { describe, it, expect } from "vitest";
import { upsertManualGraphPosition } from "./manualGraphPositions";
import type { GraphPosition } from "./api";

describe("upsertManualGraphPosition", () => {
  it("inserts a new placement", () => {
    const next = upsertManualGraphPosition(undefined, "a", 3, 4);
    expect(next).toEqual([{ nodeId: "a", x: 3, y: 4 }]);
  });

  it("overwrites an existing placement without duplicating", () => {
    const start: GraphPosition[] = [
      { nodeId: "a", x: 1, y: 1 },
      { nodeId: "b", x: 2, y: 2 },
    ];
    const next = upsertManualGraphPosition(start, "a", 99, 99);
    expect(next).toHaveLength(2);
    expect(next.find((p) => p.nodeId === "a")).toEqual({ nodeId: "a", x: 99, y: 99 });
    expect(next.find((p) => p.nodeId === "b")).toEqual({ nodeId: "b", x: 2, y: 2 });
  });

  it("does not mutate the input array (immutable update)", () => {
    const start: GraphPosition[] = [{ nodeId: "a", x: 1, y: 1 }];
    const next = upsertManualGraphPosition(start, "a", 5, 5);
    expect(start[0]).toEqual({ nodeId: "a", x: 1, y: 1 });
    expect(next).not.toBe(start);
  });
});
