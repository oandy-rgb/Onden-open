// The merge of the warm boot's second phase (lib/data/bootRest): what the store
// already holds wins; the rest only fills what is missing.
import { describe, it, expect } from "vitest";
import type { Bootstrap, ContentNode, NodeEdge } from "../lib/api";
import { mergeAttributeRows, mergeBootstrapRelations } from "../lib/data/bootRest";

const note = (id: string, attrs?: Record<string, string>): ContentNode => ({ id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", parent_id: null, hidden: false, order_key: "a0", ...(attrs ? { attrs } : {}) } as ContentNode);
const edge = (id: string, a: string, b: string): NodeEdge => ({ id, source_node_id: a, target_node_id: b, edge_type: "link", status: "active" });
const store = (nodes: ContentNode[], more: Partial<Bootstrap> = {}): Bootstrap => ({ nodes, edges: [], tasks: [], suggestions: [], events: [], pointers: [], graph_positions: [], ...more } as unknown as Bootstrap);
const none = { edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] };

describe("mergeBootstrapRelations", () => {
  it("adds edges between notes the store holds and drops those touching a note it no longer has", () => {
    const prev = store([note("a"), note("b")]);
    const out = mergeBootstrapRelations(prev, { ...none, edges: [edge("e1", "a", "b"), edge("e2", "a", "gone")] });
    expect(out.edges.map(e => e.id)).toEqual(["e1"]);
  });

  it("keeps the store's own edge when both have it, and adds nothing twice", () => {
    const mine = { ...edge("e1", "a", "b"), status: "suggested" };
    const prev = store([note("a"), note("b")], { edges: [mine] });
    const out = mergeBootstrapRelations(prev, { ...none, edges: [edge("e1", "a", "b")] });
    expect(out).toBe(prev);
    expect(out.edges[0]).toBe(mine);
  });

  it("fills graph positions only into an empty store", () => {
    const prev = store([note("a")]);
    const out = mergeBootstrapRelations(prev, { ...none, graph_positions: [{ nodeId: "a", x: 1, y: 2 }, { nodeId: "x", x: 3, y: 4 }] });
    expect(out.graph_positions).toEqual([{ nodeId: "a", x: 1, y: 2 }]);
    const held = store([note("a")], { graph_positions: [{ nodeId: "a", x: 9, y: 9 }] });
    expect(mergeBootstrapRelations(held, { ...none, graph_positions: [{ nodeId: "a", x: 1, y: 2 }] })).toBe(held);
  });
});

describe("mergeAttributeRows", () => {
  it("fills missing keys and never overrides one the store has", () => {
    const prev = store([note("a", { status: "done" }), note("b")]);
    const out = mergeAttributeRows(prev, [
      { node_id: "a", key: "status", value: "open" }, { node_id: "a", key: "priority", value: "1" },
      { node_id: "b", key: "status", value: "open" }, { node_id: "gone", key: "status", value: "x" },
    ]);
    expect(out.nodes.map(n => n.attrs)).toEqual([{ status: "done", priority: "1" }, { status: "open" }]);
  });

  it("returns the store itself when there was nothing to add, and leaves untouched notes as they were", () => {
    const a = note("a", { status: "done" });
    const prev = store([a, note("b")]);
    expect(mergeAttributeRows(prev, [{ node_id: "a", key: "status", value: "open" }])).toBe(prev);
    expect(mergeAttributeRows(prev, [{ node_id: "b", key: "k", value: "v" }]).nodes[0]).toBe(a);
  });
});
