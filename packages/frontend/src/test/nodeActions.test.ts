import { describe, expect, it, vi } from "vitest";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { makeNodeActions } from "../lib/data/nodeActions";

const note = { id: "n1", title: "Note", node_type: "content" } as ContentNode;

function harness(selectedId: string | null = "n1", nodes: ContentNode[] = [note], phone = false) {
  const mutations = {
    deleteNode: vi.fn(async () => true),
    duplicateNode: vi.fn(async () => {}),
    promoteNode: vi.fn(async () => {}),
    renameNode: vi.fn(async () => true),
    assignToGroup: vi.fn(async () => {}),
  };
  const selection = {
    selectedId: selectedId as string | null,
    clear: vi.fn(() => { selection.selectedId = null; }),
    select: vi.fn((id: string) => { selection.selectedId = id; }),
    listIsSeparateScreen: phone,
  };
  const actions = makeNodeActions({ data: { ...noWorkspaceData, nodes } }, mutations, selection);
  return { actions, mutations, selection };
}

describe("nodeActions", () => {
  it("delete names the note and clears its focus at once", async () => {
    const h = harness();
    await expect(h.actions.delete("n1")).resolves.toBe(true);
    expect(h.mutations.deleteNode).toHaveBeenCalledExactlyOnceWith("n1", "Note");
    expect(h.selection.clear).toHaveBeenCalledOnce();
  });

  it("a refused delete gives the focus back so the page stays", async () => {
    const h = harness();
    h.mutations.deleteNode.mockResolvedValueOnce(false);
    await expect(h.actions.delete("n1")).resolves.toBe(false);
    expect(h.selection.select).toHaveBeenCalledExactlyOnceWith("n1");
  });

  it("delete keeps another note's focus, and names an unlisted row by its fallback", async () => {
    const h = harness("other");
    await h.actions.delete("tag-1", "book");
    expect(h.mutations.deleteNode).toHaveBeenCalledExactlyOnceWith("tag-1", "book");
    expect(h.selection.clear).not.toHaveBeenCalled();
  });

  describe("the focused note is deleted", () => {
    const at = (id: string, parent_id: string | null, order_key: string) =>
      ({ id, title: id, node_type: "content", parent_id, order_key }) as unknown as ContentNode;
    const tree = [at("p", null, "a0"), at("a", "p", "a0"), at("b", "p", "a1"), at("c", "p", "a2")];

    it("opens the next sibling", async () => {
      const h = harness("b", tree);
      await h.actions.delete("b");
      expect(h.selection.select).toHaveBeenCalledExactlyOnceWith("c");
      expect(h.selection.clear).not.toHaveBeenCalled();
    });

    it("opens the previous sibling when it was the last", async () => {
      const h = harness("c", tree);
      await h.actions.delete("c");
      expect(h.selection.select).toHaveBeenCalledExactlyOnceWith("b");
    });

    it("opens the parent when it had no siblings", async () => {
      const h = harness("a", [at("p", null, "a0"), at("a", "p", "a0")]);
      await h.actions.delete("a");
      expect(h.selection.select).toHaveBeenCalledExactlyOnceWith("p");
    });

    it("stays blank when nothing is left", async () => {
      const h = harness("n1");
      await h.actions.delete("n1");
      expect(h.selection.clear).toHaveBeenCalledOnce();
      expect(h.selection.select).not.toHaveBeenCalled();
    });

    it("a refused delete puts the deleted page back, not the neighbour", async () => {
      const h = harness("b", tree);
      h.mutations.deleteNode.mockResolvedValueOnce(false);
      await h.actions.delete("b");
      expect(h.selection.select).toHaveBeenLastCalledWith("b");
    });

    it("a refused delete leaves a note the user moved to meanwhile", async () => {
      const h = harness("b", tree);
      h.mutations.deleteNode.mockImplementationOnce(async () => { h.selection.selectedId = "a"; return false; });
      await h.actions.delete("b");
      expect(h.selection.select).toHaveBeenCalledExactlyOnceWith("c");
    });

    it("on a phone goes back to the list (no neighbour)", async () => {
      const h = harness("b", tree, true);
      await h.actions.delete("b");
      expect(h.selection.clear).toHaveBeenCalledOnce();
      expect(h.selection.select).not.toHaveBeenCalled();
    });

    it("deleting another note leaves the focus alone", async () => {
      const h = harness("a", tree);
      await h.actions.delete("c");
      expect(h.selection.select).not.toHaveBeenCalled();
      expect(h.selection.clear).not.toHaveBeenCalled();
    });
  });

  it("has no hide: only tags can be hidden (D104)", () => {
    expect("hide" in harness().actions).toBe(false);
  });

  it("duplicate and promote look the note up by id", async () => {
    const h = harness();
    await h.actions.duplicate("n1");
    await h.actions.duplicate("missing");
    await h.actions.promote("n1");
    expect(h.mutations.duplicateNode).toHaveBeenCalledExactlyOnceWith(note);
    expect(h.mutations.promoteNode).toHaveBeenCalledExactlyOnceWith("n1", "Note");
  });
});
