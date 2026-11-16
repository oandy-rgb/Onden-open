// Children are ordered like the backend lists them: order_key (by byte), then the stamp of the write that set it,
// then id. Moving one note between two others writes one note: its key goes between theirs.
import { describe, it, expect } from "vitest";
import { evenOrderKey, evenOrderKeys } from "@onden/markdown/contract";
import { planSiblingOrder, sortChildren } from "../lib/childOrder";
import { computeTreeLayout } from "../lib/treeLayout";
import type { ContentNode } from "../lib/api";

const child = (id: string, order_key: string | undefined, order_stamp = "") =>
  ({ id, title: id, slug: id, parent_id: "root", node_type: "content", source_type: "manual", markdown: "", hidden: false, order_key, order_stamp }) as ContentNode;

describe("child order", () => {
  it("sorts by key, then stamp, then id; never by title or creation time", () => {
    const rows = [child("b", "a0", "2"), child("a", "a0", "2"), child("z", "a0", "1"), child("first", "Zz"), child("late", "a1")];
    expect(sortChildren(rows).map((r) => r.id)).toEqual(["first", "z", "a", "b", "late"]);
  });

  it("does not depend on the order rows arrive in", () => {
    const rows = [child("b", "a1"), child("a", "a1"), child("c", "a0")];
    expect(sortChildren([...rows].reverse()).map((r) => r.id)).toEqual(sortChildren(rows).map((r) => r.id));
  });

  it("a note the server has not answered yet (no key) sorts last", () => {
    expect(sortChildren([child("new", undefined), child("a", "a0"), child("b", "a1")]).map((r) => r.id)).toEqual(["a", "b", "new"]);
  });

  it("the canvas tree layout uses the same order", () => {
    const root = { ...child("root", "a0"), parent_id: null } as ContentNode;
    const nodes = [root, child("late", "a5"), child("early", "a1")];
    const pos = computeTreeLayout("root", nodes);
    expect(pos.get("early")!.y).toBeLessThan(pos.get("late")!.y);
  });
});

// A reorder writes as few siblings as it can: one, for a move.
describe("planSiblingOrder", () => {
  const fresh = (n: number) => evenOrderKeys(n).map((key, i) => child(`c${i}`, key));
  const apply = (rows: ContentNode[], changes: Map<string, string>) =>
    sortChildren(rows.map((r) => (changes.has(r.id) ? { ...r, order_key: changes.get(r.id)! } : r))).map((r) => r.id);

  it.each([100, 2000])("moving one note to the top of %i siblings writes that note only", (n) => {
    const rows = fresh(n);
    const order = ["c2", ...rows.map((r) => r.id).filter((id) => id !== "c2")];
    const changes = planSiblingOrder(rows, order, "c2");
    expect([...changes.keys()]).toEqual(["c2"]);
    expect(apply(rows, changes)).toEqual(order);
  });

  it("moving a later note between two earlier ones writes that note only", () => {
    const rows = fresh(200);
    const ids = rows.map((r) => r.id).filter((id) => id !== "c150");
    const order = [...ids.slice(0, 1), "c150", ...ids.slice(1)];
    const changes = planSiblingOrder(rows, order, "c150");
    expect([...changes.keys()]).toEqual(["c150"]);
    expect(apply(rows, changes)).toEqual(order);
  });

  it("a note coming from another parent always gets a key, and nobody else changes", () => {
    const rows = [child("a", "a0"), child("b", "a1")];
    const changes = planSiblingOrder(rows, ["a", "x", "b"], "x");
    expect([...changes.keys()]).toEqual(["x"]);
    expect(changes.get("x")! > "a0" && changes.get("x")! < "a1").toBe(true);
  });

  it("swapping two neighbours rekeys the dragged one, not its neighbour", () => {
    const rows = [child("a", "a0"), child("b", "a1"), child("c", "a2")];
    const changes = planSiblingOrder(rows, ["a", "c", "b"], "c");
    expect([...changes.keys()]).toEqual(["c"]);
    expect(apply(rows, changes)).toEqual(["a", "c", "b"]);
  });

  it("siblings with the same key (two devices inserted at one place) are separated once", () => {
    const rows = [child("a", "a0"), child("b", "a0"), child("c", "a0")];
    const order = sortChildren(rows).map((r) => r.id);
    const changes = planSiblingOrder(rows, order);
    expect(changes.size).toBe(2);
    expect(apply(rows, changes)).toEqual(order);
  });

  it("any order of any siblings comes out as asked", () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 300; round++) {
      const n = 1 + rand(12);
      const rows = Array.from({ length: n }, (_, i) => child(`r${i}`, rand(5) ? evenOrderKey(rand(6)) : undefined, String(rand(3))));
      const order = sortChildren(rows).map((r) => r.id);
      const [movedId] = order.splice(rand(n), 1);
      order.splice(rand(n), 0, movedId!);
      const changes = planSiblingOrder(rows, order, movedId);
      const planned = order.map((id) => ({ ...rows.find((r) => r.id === id)!, order_key: changes.get(id) ?? rows.find((r) => r.id === id)!.order_key }));
      for (let i = 1; i < planned.length; i++) {
        expect(planned[i - 1]!.order_key! < planned[i]!.order_key!, `round ${round}: ${planned[i - 1]!.id} before ${planned[i]!.id}`).toBe(true);
      }
      expect(changes.size).toBeLessThanOrEqual(n);
    }
  });
});
