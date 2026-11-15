import { describe, it, expect } from "vitest";
import { flattenSidebarTree, groupRootsBySpace, sidebarWindow } from "../lib/sidebarFlatten";
import type { ContentNode, NotePointer } from "../lib/api";

const n = (id: string, parent: string | null = null) =>
  ({ id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", parent_id: parent, hidden: false, sort_order: 0 }) as unknown as ContentNode;

describe("flattenSidebarTree (④ virtualization)", () => {
  const a = n("a"), b = n("b", "a"), c = n("c", "a"), d = n("d", "b"), e = n("e");
  const kids = new Map([["a", [b, c]], ["b", [d]]]);
  const ptr = { id: "p1", parent_id: "a", target_id: "e" } as unknown as NotePointer;
  const ptrs = new Map([["a", [ptr]]]);

  it("collapsed groups emit only their own row", () => {
    const flat = flattenSidebarTree([a, e], kids, ptrs, new Set());
    expect(flat.map((r) => (r.kind === "node" ? r.item.id : "ptr"))).toEqual(["a", "e"]);
  });

  it("expansion mirrors the recursive DOM order: node, children, pointers", () => {
    const flat = flattenSidebarTree([a, e], kids, ptrs, new Set(["a", "b"]));
    expect(flat.map((r) => (r.kind === "node" ? r.item.id : "ptr"))).toEqual(["a", "b", "d", "c", "ptr", "e"]);
    expect(flat.map((r) => r.depth)).toEqual([0, 1, 2, 1, 1, 0]);
  });

  it("cycles cannot loop the walk", () => {
    const loopKids = new Map([["a", [b]], ["b", [a]]]);
    const flat = flattenSidebarTree([a], loopKids, new Map(), new Set(["a", "b"]));
    expect(flat.map((r) => (r.kind === "node" ? r.item.id : "ptr"))).toEqual(["a", "b"]);
  });
});

describe("space headings (spaces on)", () => {
  it("groups top-level notes under their space, in the given order, with unknown spaces last", () => {
    const a = { id: "a", title: "A", space_id: "mine" } as ContentNode;
    const b = { id: "b", title: "B", space_id: "lab" } as ContentNode;
    const c = { id: "c", title: "C", space_id: "gone" } as ContentNode;
    const groups = groupRootsBySpace([b, a, c], [{ id: "mine", label: "Only me" }, { id: "lab", label: "Lab" }, { id: "empty", label: "Empty" }], "Other");
    expect(groups.map((g) => [g.label, g.roots.map((r) => r.id)])).toEqual([["Only me", ["a"]], ["Lab", ["b"]], ["Other", ["c"]]]);
    const rows = flattenSidebarTree([a, b, c], new Map(), new Map(), new Set(), groups);
    expect(rows.map((r) => (r.kind === "space" ? `# ${r.label}` : r.kind === "node" ? r.item.id : "p"))).toEqual(
      ["# Only me", "a", "# Lab", "b", "# Other", "c"]);
  });
});

describe("sidebarWindow", () => {
  it("starts at the top while the list begins below the visible area", () => {
    expect(sidebarWindow(1000, 0, 800, 40, 12)).toEqual({ start: 0, end: 44 });
  });

  it("follows the scrolled offset with overscan on both sides", () => {
    // 4,000 px past the list top = row 100; 800 px = 20 rows.
    expect(sidebarWindow(1000, 4000, 800, 40, 12)).toEqual({ start: 88, end: 132 });
  });

  it("clamps at the end of the list and never goes negative", () => {
    expect(sidebarWindow(50, 100_000, 800, 40, 12)).toEqual({ start: 50, end: 50 });
    expect(sidebarWindow(50, -300, 800, 40, 12)).toEqual({ start: 0, end: 44 });
  });

  it("treats an unmeasured pitch as 1 px instead of dividing by zero", () => {
    expect(sidebarWindow(10, 0, 5, 0, 0)).toEqual({ start: 0, end: 5 });
  });
});
