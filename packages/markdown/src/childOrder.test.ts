import { describe, expect, it } from "vitest";
import { compareChildren, sortChildren } from "./childOrder";

const row = (id: string, sort_order: number, created_at?: string) => ({ id, sort_order, created_at });

describe("child order", () => {
  it("sorts by sort_order, then creation time, then id", () => {
    const rows = [row("b", 0, "2026-10-02T00:00:00Z"), row("z", 0, "2026-10-01T00:00:00Z"), row("a", 0, "2026-10-01T00:00:00Z"), row("first", -1, "2026-12-01T00:00:00Z")];
    expect(sortChildren(rows).map((r) => r.id)).toEqual(["first", "a", "z", "b"]);
  });

  it("does not depend on the order the rows arrive in", () => {
    const rows = [row("b", 1, "2026-01-02T00:00:00Z"), row("a", 1, "2026-01-02T00:00:00Z"), row("c", 1, "2026-01-01T00:00:00Z")];
    expect(sortChildren([...rows].reverse()).map((r) => r.id)).toEqual(sortChildren(rows).map((r) => r.id));
  });

  it("never lets a title decide, and keeps rows without created_at where they were", () => {
    expect(sortChildren([row("x", 1), row("y", 1)]).map((r) => r.id)).toEqual(["x", "y"]);
    expect(compareChildren({ id: "1", sort_order: null }, { id: "2" })).toBe(0);
  });
});
