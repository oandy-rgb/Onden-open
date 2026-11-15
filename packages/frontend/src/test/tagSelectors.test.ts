import { describe, expect, it } from "vitest";
import {
  getAppState, selectOverviewNodes, selectOverviewSelectedNode,
} from "../lib/appStore";
import type { ContentNode, Tag } from "../lib/api";
import { addNodeTag } from "../lib/data/storeOps";

const tag: Tag = { id: "review-tag", name: "review", color: "", schema_id: null };
function node(id: string, props: Partial<ContentNode> = {}): ContentNode {
  return { id, title: id, slug: id, markdown: "", source_type: "manual", node_type: "content", ...props };
}
// The workspace-config tag rows the visibility tests use: known by their
// reserved key in the catalog (a title alone proves nothing — T5).
const configTags: Tag[] = ["system-tag", "hidden-system-tag"].map((id) =>
  ({ id, name: "workspace-config", reserved_key: "workspace-config", color: "", schema_id: null }));
function state(nodes: ContentNode[]) {
  const current = getAppState();
  return { ...current, data: { ...current.data, nodes, tags: [tag, ...configTags] } };
}

describe("note visibility after tag functions are applied", () => {
  it("keeps a note in its list when applying a module tag", () => {
    const before = state([node("course-note")]);
    const moduleTag: Tag = {
      ...tag, schema_id: tag.id,
      schema_behaviour: { modules: { review: { enabled: true } } },
    };
    before.data.tags = [moduleTag, ...configTags];
    const select = selectOverviewNodes;
    expect(select(before).map(row => row.id)).toEqual(["course-note"]);

    // Use the actual optimistic membership projection used by the inspector.
    const after = { ...before, data: addNodeTag(before.data, "course-note", moduleTag.id) };
    expect(after.data.nodes[0].class_tag_ids).toContain(moduleTag.id);
    expect(select(after).map(row => row.id)).toEqual(["course-note"]);
  });

  it("keeps an existing member visible when its tag gains a schema", () => {
    const before = state([node("existing-note", { label_tag_ids: [tag.id] })]);
    const select = selectOverviewNodes;
    expect(select(before).map(row => row.id)).toEqual(["existing-note"]);
    // Enabling a function creates a schema and sync reclassifies the same
    // membership. That projection change must not relocate the note.
    const after = {
      ...before,
      data: {
        ...before.data,
        tags: [{ ...tag, schema_id: tag.id, schema_behaviour: { modules: { review: { enabled: true } } } }, ...configTags],
        nodes: [node("existing-note", { label_tag_ids: [], class_tag_ids: [tag.id] })],
      },
    };
    expect(select(after).map(row => row.id)).toEqual(["existing-note"]);
  });

  it("keeps collection content without removing existing tag and canvas parent navigation", () => {
    const s = state([
      node("tag-parent", { node_type: "class_tag" }),
      node("collection-item", { parent_id: "tag-parent", class_tag_ids: ["old-collection"] }),
      node("ordinary-note"),
      node("board", { node_type: "canvas" }),
      node("board-child", { parent_id: "board", class_tag_ids: [tag.id] }),
      node("system-note", { source_type: "system" }),
      node("system-board", { source_type: "system", node_type: "canvas" }),
      node("system-tag", { node_type: "class_tag", title: "workspace-config" }),
      node("inbox-note", { hidden: true }),
    ]);
    expect(selectOverviewNodes(s).map(row => row.id)).toEqual([
      "tag-parent", "collection-item", "ordinary-note", "board", "board-child",
    ]);
    expect(selectOverviewNodes(s).find(row => row.id === "collection-item")?.parent_id).toBe("tag-parent");
    expect(selectOverviewNodes(s).find(row => row.id === "board-child")?.parent_id).toBe("board");
    expect(selectOverviewNodes(s)).toBe(selectOverviewNodes(s));
  });

  it("keeps a renamed workspace-config tag out of the overview (found by its reserved key)", () => {
    const base = state([
      node("config", { node_type: "class_tag", title: "Workspace settings" }),
      node("ordinary-note"),
    ]);
    const s = { ...base, data: { ...base.data, tags: [tag, ...configTags, { id: "config", name: "Workspace settings", reserved_key: "workspace-config", color: "", schema_id: null }] } };
    expect(selectOverviewNodes(s).map(row => row.id)).toEqual(["ordinary-note"]);
  });

  it("a hidden tag still lists its notes: hiding is a listing choice (D104)", () => {
    const base = state([node("member", { label_tag_ids: [tag.id] })]);
    const s = { ...base, data: { ...base.data, tags: [{ ...tag, hidden: true }, ...configTags] } };
    expect(selectOverviewNodes(s).map((row) => row.id)).toEqual(["member"]);
  });
});

describe("selectOverviewSelectedNode", () => {
  it("is null when nothing is open: the first note is never picked for the user", () => {
    const s = { ...state([node("first"), node("second")]), selectedId: null };
    expect(selectOverviewNodes(s).length).toBeGreaterThan(0);
    expect(selectOverviewSelectedNode(s)).toBeNull();
  });

  it("is the opened note, and null (not another note) while that id is missing", () => {
    const nodes = [node("first"), node("second")];
    expect(selectOverviewSelectedNode({ ...state(nodes), selectedId: "second" })?.id).toBe("second");
    expect(selectOverviewSelectedNode({ ...state(nodes), selectedId: "gone" })).toBeNull();
  });
});
