import { describe, expect, it } from "vitest";
import type { ContentNode, NodeEdge, Tag } from "../../lib/api";
import { GRAPH_SHOW_DEFAULT, graphView } from "./graphVisibility";

const note = (id: string, extra: Partial<ContentNode> = {}) => ({ id, title: id, node_type: "content", ...extra }) as ContentNode;
const tagNode = (id: string, extra: Partial<ContentNode> = {}) => note(id, { node_type: "class_tag", ...extra });
const tag = (id: string, extra: Partial<Tag> = {}) => ({ id, name: id, color: null, schema_id: null, ...extra }) as Tag;
const link = (a: string, b: string) => ({ source_node_id: a, target_node_id: b, edge_type: "knowledge_link", status: "active" }) as NodeEdge;
const ids = (v: { nodes: ContentNode[] }) => v.nodes.map((n) => n.id).sort();

describe("graphView: only what has a relationship", () => {
  it("leaves out notes with no line and counts them", () => {
    const v = graphView([note("a"), note("b"), note("lonely")], [link("a", "b")], [], GRAPH_SHOW_DEFAULT);
    expect(ids(v)).toEqual(["a", "b"]);
    expect(v.isolatedNotes).toBe(1);
  });
  it("brings them back on request", () => {
    const v = graphView([note("a"), note("lonely")], [], [], { ...GRAPH_SHOW_DEFAULT, isolatedNotes: true });
    expect(ids(v)).toEqual(["a", "lonely"]);
  });
  it("counts a tag line as a relationship, and leaves out a tag with no notes", () => {
    const nodes = [note("n", { class_tag_ids: ["used"] }), tagNode("used"), tagNode("empty")];
    const tags = [tag("used"), tag("empty")];
    const v = graphView(nodes, [], tags, GRAPH_SHOW_DEFAULT);
    expect(ids(v)).toEqual(["n", "used"]);
    expect(v.emptyTags).toBe(1);
    expect(ids(graphView(nodes, [], tags, { ...GRAPH_SHOW_DEFAULT, emptyTags: true }))).toEqual(["empty", "n", "used"]);
  });
  it("keeps a tag that only holds tags with notes", () => {
    const nodes = [note("n", { label_tag_ids: ["child"] }), tagNode("child", { parent_id: "root" }), tagNode("root")];
    expect(ids(graphView(nodes, [], [tag("child"), tag("root")], GRAPH_SHOW_DEFAULT))).toEqual(["child", "n", "root"]);
  });
  it("never draws system rows, module tags, reserved tags or hidden tags, even with 「顯示」 on", () => {
    const nodes = [
      note("n", { class_tag_ids: ["mod", "res", "hid", "own"] }), note("sys", { source_type: "system" }), note("gone", { hidden: true }),
      tagNode("mod"), tagNode("res"), tagNode("hid"), tagNode("own"),
    ];
    const tags = [tag("mod", { schema_module: "tasks" }), tag("res", { reserved_key: "task" }), tag("hid", { hidden: true }), tag("own")];
    const all = { isolatedNotes: true, emptyTags: true };
    expect(ids(graphView(nodes, [], tags, all))).toEqual(["n", "own"]);
    expect(graphView(nodes, [], tags, all).lines.map((l) => l.target)).toEqual(["own"]);
  });
  it("a note whose only line went to a left-out empty tag is isolated, not drawn with a dangling line", () => {
    const v = graphView([note("n", { parent_id: "t" }), tagNode("t")], [], [tag("t")], GRAPH_SHOW_DEFAULT);
    expect(ids(v)).toEqual([]);
    expect(v.lines).toEqual([]);
  });
  it("the neighbourhood view (all) keeps the unlinked centre and every neighbour", () => {
    const v = graphView([note("c"), note("x")], [], [], GRAPH_SHOW_DEFAULT, { keepId: "c", all: true });
    expect(ids(v)).toEqual(["c", "x"]);
  });
  it("keeps the open note even with no line, but not when it is system machinery", () => {
    const v = graphView([note("a"), note("open"), note("sys", { source_type: "system" })], [], [], GRAPH_SHOW_DEFAULT, { keepId: "open" });
    expect(ids(v)).toEqual(["open"]);
    expect(ids(graphView([note("sys", { source_type: "system" })], [], [], GRAPH_SHOW_DEFAULT, { keepId: "sys" }))).toEqual([]);
  });
});
