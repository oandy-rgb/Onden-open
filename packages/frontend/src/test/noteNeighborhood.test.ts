import { describe, expect, it } from "vitest";
import { graphRoles, noteLinks, noteNeighborhood } from "../lib/noteNeighborhood";
import type { ContentNode, NodeEdge, Tag } from "../lib/api";

const mk = (id: string, extra: Partial<ContentNode> = {}): ContentNode => ({
  id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", ...extra,
});
const edge = (id: string, source: string, target: string, edge_type = "knowledge_link", status = "active"): NodeEdge =>
  ({ id, source_node_id: source, target_node_id: target, edge_type, status, origin: "manual" });

describe("noteNeighborhood", () => {
  const me = mk("me", { parent_id: "up" });
  const nodes = [me, mk("up"), mk("to"), mk("from"), mk("kid", { parent_id: "me" }), mk("far"), mk("secret", { hidden: true })];

  it("tells the two link directions apart, then the parent and the children", () => {
    const { relations } = noteNeighborhood(me, nodes, [edge("1", "me", "to"), edge("2", "from", "me")]);
    expect(relations.map((r) => [r.direction, r.node.id])).toEqual([
      ["out", "to"], ["in", "from"], ["parent", "up"], ["child", "kid"],
    ]);
    expect(relations[0]!.edgeType).toBe("knowledge_link");
    expect(relations[2]!.edgeType).toBeUndefined();
  });

  it("keeps hidden notes out of the relations and the drawn nodes", () => {
    const { relations, localNodes } = noteNeighborhood(me, nodes, [edge("1", "me", "secret")]);
    expect(relations.map((r) => r.node.id)).toEqual(["up", "kid"]);
    expect(localNodes.map((n) => n.id)).not.toContain("secret");
  });

  it("ignores edges the graph does not draw and edges between other notes", () => {
    const { relations, localEdges } = noteNeighborhood(me, nodes, [
      edge("rejected", "me", "to", "suggested_link", "rejected"), edge("other", "to", "far"),
    ]);
    expect(relations.map((r) => r.node.id)).toEqual(["up", "kid"]);
    expect(localEdges).toEqual([]);
  });

  it("returns the nodes and the edges among them for drawing", () => {
    const { localNodes, localEdges } = noteNeighborhood(me, nodes, [edge("1", "me", "to"), edge("2", "to", "from"), edge("3", "to", "far")]);
    expect(localNodes.map((n) => n.id).sort()).toEqual(["kid", "me", "to", "up"]);
    expect(localEdges.map((e) => e.id)).toEqual(["1"]);
  });
});

describe("graphRoles", () => {
  it("gives each neighbour one role: parent and child over out over in", () => {
    const me = mk("me", { parent_id: "up" });
    const nodes = [me, mk("up"), mk("both"), mk("from"), mk("kid", { parent_id: "me" })];
    const { relations } = noteNeighborhood(me, nodes, [
      edge("1", "from", "me"), edge("2", "both", "me"), edge("3", "me", "both"), edge("4", "me", "kid"), edge("5", "me", "up"),
    ]);
    expect(graphRoles(relations)).toEqual({ from: "in", both: "out", kid: "child", up: "parent" });
  });
});

describe("noteLinks (the lists under the note body)", () => {
  const me = mk("me");
  const nodes = [me, mk("a"), mk("b"), mk("c"), mk("kid", { parent_id: "me" }), mk("secret", { hidden: true })];
  const links = (edges: NodeEdge[], from: ContentNode = me) => noteLinks(noteNeighborhood(from, nodes, edges).relations);

  it("lists plain links in and out, in edge order, and the children", () => {
    const got = links([edge("1", "a", "me"), edge("2", "me", "b"), edge("3", "c", "me")]);
    expect(got.backlinks.map((n) => n.id)).toEqual(["a", "c"]);
    expect(got.outgoing.map((n) => n.id)).toEqual(["b"]);
    expect(got.children.map((n) => n.id)).toEqual(["kid"]);
  });

  it("a typed relation or a suggestion is no backlink, and a pair linked twice is listed once", () => {
    const got = links([
      edge("1", "a", "me"), edge("2", "a", "me"), edge("3", "b", "me", "supports"),
      edge("4", "c", "me", "suggested_link", "suggested"), edge("5", "me", "secret"),
    ]);
    expect(got.backlinks.map((n) => n.id)).toEqual(["a"]);
    expect(got.outgoing).toEqual([]);
  });

  it("drops edges whose other end is missing", () => {
    expect(links([edge("1", "ghost", "me"), edge("2", "me", "ghost")])).toMatchObject({ backlinks: [], outgoing: [] });
  });
});

describe("tags in the neighbourhood", () => {
  const tagNode = (id: string, extra: Partial<ContentNode> = {}) => mk(id, { node_type: "class_tag", ...extra });
  const tag = (id: string, extra: Partial<Tag> = {}) => ({ id, name: id, color: null, schema_id: null, ...extra }) as Tag;
  const tags = [tag("windows"), tag("book"), tag("hid", { hidden: true })];
  const nodes = [tagNode("windows"), tagNode("book"), tagNode("hid")];

  it("lists each shown tag of the note, after parent and sub-notes, and draws the tag nodes", () => {
    const me = mk("me", { class_tag_ids: ["windows"], label_tag_ids: ["book", "hid"] });
    const { relations, localNodes } = noteNeighborhood(me, [me, ...nodes], [], tags);
    expect(relations.map((r) => [r.direction, r.node.id])).toEqual([["tag", "windows"], ["tag", "book"]]);
    expect(localNodes.map((n) => n.id).sort()).toEqual(["book", "me", "windows"]);
    expect(graphRoles(relations)).toEqual({ windows: "tag", book: "tag" });
  });

  it("lists the notes carrying a centre tag as members, laid out with the sub-notes", () => {
    const windows = nodes[0]!;
    const a = mk("a", { class_tag_ids: ["windows"] });
    const { relations } = noteNeighborhood(windows, [...nodes, a, mk("b")], [], tags);
    expect(relations.map((r) => [r.direction, r.node.id])).toEqual([["member", "a"]]);
    expect(graphRoles(relations)).toEqual({ a: "child" });
  });

  it("keeps a tag that is also the parent as the parent only", () => {
    const me = mk("me", { class_tag_ids: ["windows"], parent_id: "windows" });
    const { relations } = noteNeighborhood(me, [me, ...nodes], [], tags);
    expect(relations.map((r) => [r.direction, r.node.id])).toEqual([["parent", "windows"]]);
  });

  it("is unchanged without a tag catalog", () => {
    const me = mk("me", { class_tag_ids: ["windows"] });
    expect(noteNeighborhood(me, [me, ...nodes], []).relations).toEqual([]);
  });
});
