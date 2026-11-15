// Children are ordered like the backend lists them: sort_order, then creation
// time. Merge used the title as the tie-break, so equal sort_order children
// were folded back in alphabetical rather than creation order.
import { describe, it, expect } from "vitest";
import { planSiblingOrder, sortChildren } from "../lib/childOrder";
import { computeTreeLayout } from "../lib/treeLayout";
import type { ContentNode } from "../lib/api";

const child = (id: string, title: string, sort_order: number, created_at?: string) =>
  ({ id, title, slug: id, parent_id: "root", node_type: "content", source_type: "manual", markdown: "", hidden: false, sort_order, created_at }) as ContentNode;

describe("child order", () => {
  it("ties on sort_order break by creation time, not title", () => {
    const rows = [child("b", "Alpha", 0, "2026-10-02T00:00:00Z"), child("a", "Zulu", 0, "2026-10-01T00:00:00Z"), child("c", "Mid", -1)];
    expect(sortChildren(rows).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps input order among equals without created_at", () => {
    const rows = [child("x", "Zed", 1), child("y", "Abe", 1)];
    expect(sortChildren(rows).map((r) => r.id)).toEqual(["x", "y"]);
  });

  it("the canvas tree layout uses the same order", () => {
    const root = { ...child("root", "Root", 0), parent_id: null } as ContentNode;
    const nodes = [root, child("late", "A late", 0, "2026-10-03T00:00:00Z"), child("early", "B early", 0, "2026-10-01T00:00:00Z")];
    const pos = computeTreeLayout("root", nodes);
    expect(pos.get("early")!.y).toBeLessThan(pos.get("late")!.y);
  });
});

// D64: a reorder renumbers as few siblings as it can.
describe("planSiblingOrder", () => {
  const at = (i: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
  // n children all at sort_order 0, created in order: c0, c1, …
  const fresh = (n: number) => Array.from({ length: n }, (_, i) => child(`c${i}`, `c${i}`, 0, at(i)));
  const apply = (rows: ContentNode[], changes: Map<string, number>) =>
    sortChildren(rows.map((r) => (changes.has(r.id) ? { ...r, sort_order: changes.get(r.id)! } : r))).map((r) => r.id);

  it("moving one note to the top of 200 untouched siblings writes that note only", () => {
    const rows = fresh(200);
    const ids = rows.map((r) => r.id);
    const order = ["c2", ...ids.filter((id) => id !== "c2")];
    const changes = planSiblingOrder(rows, order, "c2");
    expect([...changes.keys()]).toEqual(["c2"]);
    expect(apply(rows, changes)).toEqual(order);
  });

  it("moving a later note between two earlier ties writes at most two notes", () => {
    const rows = fresh(200);
    const ids = rows.map((r) => r.id).filter((id) => id !== "c150");
    const order = [...ids.slice(0, 1), "c150", ...ids.slice(1)];
    const changes = planSiblingOrder(rows, order, "c150");
    expect(changes.size).toBeLessThanOrEqual(2);
    expect(apply(rows, changes)).toEqual(order);
  });

  it("a note coming from another parent always gets a value", () => {
    const rows = [child("a", "a", 0, at(1)), child("b", "b", 1, at(2))];
    const changes = planSiblingOrder(rows, ["a", "x", "b"], "x", [child("x", "x", 5, at(9))]);
    expect(changes.has("x")).toBe(true);
    expect(changes.has("a") || changes.has("b")).toBe(false);
    expect(changes.get("x")).toBeGreaterThanOrEqual(0);
    expect(changes.get("x")).toBeLessThanOrEqual(1);
  });

  it("swapping two neighbours renumbers the dragged one, not its neighbour", () => {
    const rows = [child("a", "a", 0, at(1)), child("b", "b", 1, at(2)), child("c", "c", 2, at(3))];
    const changes = planSiblingOrder(rows, ["a", "c", "b"], "c");
    expect([...changes.keys()]).toEqual(["c"]);
    expect(apply(rows, changes)).toEqual(["a", "c", "b"]);
  });

  it("any order of any siblings comes out as asked", () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 300; round++) {
      const n = 1 + rand(12);
      const rows = Array.from({ length: n }, (_, i) => child(`r${i}`, `r${i}`, rand(4) - 1, rand(5) ? at(rand(30)) : undefined));
      const order = sortChildren(rows).map((r) => r.id);
      // Move one row somewhere else.
      const [movedId] = order.splice(rand(n), 1);
      order.splice(rand(n), 0, movedId);
      const changes = planSiblingOrder(rows, order, movedId);
      // Rows without created_at only keep their place when they differ by
      // sort_order, so compare the planned order with the comparator itself.
      const planned = order.map((id) => ({ ...rows.find((r) => r.id === id)!, sort_order: changes.get(id) ?? rows.find((r) => r.id === id)!.sort_order }));
      for (let i = 1; i < planned.length; i++) {
        const prev = planned[i - 1], cur = planned[i];
        const strictlyAfter = (cur.sort_order ?? 0) > (prev.sort_order ?? 0)
          || ((cur.sort_order ?? 0) === (prev.sort_order ?? 0) && !!prev.created_at && !!cur.created_at && prev.created_at < cur.created_at);
        expect(strictlyAfter, `round ${round}: ${prev.id} before ${cur.id}`).toBe(true);
      }
      expect(changes.size).toBeLessThanOrEqual(n);
    }
  });
});
