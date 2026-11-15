import { describe, it, expect } from "vitest";
import { ancestorsOf, indexById, isUnder, subtreeIdsOf } from "../lib/treeWalk";
import type { ContentNode } from "../lib/api";

// Fix #3 (node-switch perf) replaced the NodeInspector Parent picker's O(n²)
// per-candidate ancestor walk with ONE BFS over a childrenByParent map
// (subtreeIdsOf): precompute the focused node's descendant set, then exclude it.
const sub = (id: string, parent_id: string | null = null): ContentNode => ({
  id, title: id, slug: id, source_type: "manual", node_type: "content", markdown: "",
  ...(parent_id ? { parent_id } : {}),
});

describe("subtreeIdsOf", () => {
  it("returns the root plus all transitive descendants (one BFS)", () => {
    //   a → b → d ; a → c
    const nodes = [sub("a"), sub("b", "a"), sub("c", "a"), sub("d", "b"), sub("e")];
    expect(subtreeIdsOf(nodes, "a")).toEqual(new Set(["a", "b", "c", "d"]));
    expect(subtreeIdsOf(nodes, "b")).toEqual(new Set(["b", "d"]));
    expect(subtreeIdsOf(nodes, "e")).toEqual(new Set(["e"]));
  });

  it("is the exact set the Parent picker excludes (self + descendants)", () => {
    // The old O(n²) parent-option filter excluded the node itself and every
    // node whose ancestor chain reached it; subtreeIdsOf gives that set.
    const nodes = [sub("root"), sub("child", "root"), sub("grandchild", "child"), sub("other")];
    const excluded = subtreeIdsOf(nodes, "root");
    const valid = nodes.filter((x) => !excluded.has(x.id)).map((x) => x.id);
    expect(valid).toEqual(["other"]);
  });

  it("terminates on a parent_id cycle (does not loop forever)", () => {
    // Defensive: even with a cycle the BFS visits each id once via the Set.
    const nodes = [sub("a", "b"), sub("b", "a")];
    expect(subtreeIdsOf(nodes, "a")).toEqual(new Set(["a", "b"]));
  });
});

describe("ancestorsOf / isUnder", () => {
  const rows = [sub("a"), sub("b", "a"), sub("c", "b"), sub("x", "gone")];
  const byId = indexById(rows);

  it("lists the rows above, root first and the parent last", () => {
    expect(ancestorsOf(byId, rows[2]!).map((r) => r.id)).toEqual(["a", "b"]);
    expect(ancestorsOf(byId, rows[0]!)).toEqual([]);
  });

  it("stops at a parent that is missing and works for a row that is not in the list", () => {
    expect(ancestorsOf(byId, rows[3]!)).toEqual([]);
    expect(ancestorsOf(byId, sub("new", "c")).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("stops on a loop without counting the start as its own ancestor", () => {
    const loop = indexById([sub("p", "q"), sub("q", "p")]);
    expect(ancestorsOf(loop, loop.get("p")!).map((r) => r.id)).toEqual(["q"]);
  });

  it("isUnder is strict: a row is not under itself", () => {
    expect(isUnder(byId, "c", "a")).toBe(true);
    expect(isUnder(byId, "a", "c")).toBe(false);
    expect(isUnder(byId, "a", "a")).toBe(false);
    expect(isUnder(byId, "nope", "a")).toBe(false);
  });
});
