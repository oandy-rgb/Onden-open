import { describe, expect, it } from "vitest";
import type { ContentNode } from "../api";
import { canPlaceUnder, placementCandidates, placementRefusal } from "./placement";

describe("canPlaceUnder (tag tree and note tree are separate)", () => {
  const note = { node_type: "content" } as const;
  const tag = { node_type: "class_tag" } as const;
  it("the top level takes anything", () => {
    expect(canPlaceUnder(null)).toBe(true);
    expect(canPlaceUnder(undefined, { isTag: true })).toBe(true);
  });
  it("a note goes under a note, never under a tag", () => {
    expect(canPlaceUnder(note)).toBe(true);
    expect(canPlaceUnder(tag)).toBe(false);
  });
  it("a tag goes under a tag, never under a note", () => {
    expect(canPlaceUnder(tag, { isTag: true })).toBe(true);
    expect(canPlaceUnder(note, { isTag: true })).toBe(false);
  });
  it("nothing goes under a trashed node", () => {
    expect(canPlaceUnder({ ...note, deleted_at: "2026-10-19T00:00:00Z" })).toBe(false);
  });
});

// D101: the one rule every surface asks — the Move to… picker, the sidebar
// drag, the pin picker and a board's parent arrow.
describe("placementRefusal / placementCandidates (D101)", () => {
  type N = Pick<ContentNode, "id" | "node_type" | "parent_id" | "space_id"> & { deleted_at?: string | null };
  const n = (id: string, over: Partial<N> = {}): N => ({ id, node_type: "content", parent_id: null, space_id: "s1", ...over });
  const nodes = [
    n("self", { parent_id: "root" }), n("root"), n("kid", { parent_id: "self" }), n("gk", { parent_id: "kid" }),
    n("other"), n("elsewhere", { space_id: "s2" }), n("tag", { node_type: "class_tag", space_id: null }),
    n("trashed", { deleted_at: "2026-10-19T00:00:00Z" }), n("viewer-only", { space_id: "s3" }),
  ];
  const self = nodes[0]!;
  const byId = (id: string) => nodes.find((x) => x.id === id)!;
  const canEdit = (node: { space_id?: string | null }) => node.space_id !== "s3";

  it("answers with the server's code for each refusal", () => {
    const ctx = { nodes, canEdit };
    expect(placementRefusal(byId("other"), self, ctx)).toBeNull();
    expect(placementRefusal(byId("tag"), self, ctx)).toBe("parent_kind_mismatch");
    expect(placementRefusal(self, self, ctx)).toBe("parent_cycle");
    expect(placementRefusal(byId("gk"), self, ctx)).toBe("parent_cycle");
    expect(placementRefusal(byId("elsewhere"), self, ctx)).toBe("parent_in_other_space");
    expect(placementRefusal(byId("trashed"), self, ctx)).toBe("parent_not_found");
    expect(placementRefusal(byId("viewer-only"), { id: "x", node_type: "content" }, ctx)).toBe("forbidden");
  });

  it("a descendant is caught only when the nodes are given; the note itself always", () => {
    expect(canPlaceUnder(byId("gk"), self)).toBe(true);
    expect(canPlaceUnder(self, self)).toBe(false);
  });

  it("a cycle in the data does not hang the walk", () => {
    const loop = [n("a", { parent_id: "b" }), n("b", { parent_id: "a" }), n("c")];
    expect(canPlaceUnder(loop[0], loop[2]!, { nodes: loop })).toBe(true);
  });

  it("candidates for a note: no tag, not itself or a descendant, same space, live, editable", () => {
    expect(placementCandidates(self, nodes, { canEdit }).map((x) => x.id)).toEqual(["root", "other"]);
  });

  it("candidates for a new note: any live, editable note (its space is the caller's to give)", () => {
    expect(placementCandidates(undefined, nodes, { canEdit }).map((x) => x.id)).toEqual(["self", "root", "kid", "gk", "other", "elsewhere"]);
    expect(placementCandidates({ isTag: false, space_id: "s2" }, nodes, { canEdit }).map((x) => x.id)).toEqual(["elsewhere"]);
  });

  // A pin shows the note in a second place; the note stays where it is.
  it("pin candidates: any live, editable note but the note itself — another space and its own descendants too", () => {
    expect(placementCandidates(self, nodes, { canEdit, pin: true }).map((x) => x.id)).toEqual(["root", "kid", "gk", "other", "elsewhere"]);
  });

  it("a pin is never at the top level, under a tag or under the note itself", () => {
    const pin = { nodes, canEdit, pin: true };
    expect(placementRefusal(null, self, pin)).toBe("parent_not_found");
    expect(placementRefusal(byId("tag"), self, pin)).toBe("parent_kind_mismatch");
    expect(placementRefusal(self, self, pin)).toBe("parent_cycle");
    expect(placementRefusal(byId("viewer-only"), self, pin)).toBe("forbidden");
    expect(placementRefusal(byId("gk"), self, pin)).toBeNull();
    expect(placementRefusal(byId("elsewhere"), self, pin)).toBeNull();
  });

  it("a stand-in with no node_type (an RSS article, not a note yet) is placed as a note", () => {
    const standIn = { id: "rss-new-article" } as unknown as ContentNode;
    expect(placementCandidates(standIn, nodes, { canEdit }).map((x) => x.id)).toEqual(["self", "root", "kid", "gk", "other", "elsewhere"]);
  });

  it("candidates for a tag are tags", () => {
    expect(placementCandidates({ isTag: true }, nodes).map((x) => x.id)).toEqual(["tag"]);
  });
});
