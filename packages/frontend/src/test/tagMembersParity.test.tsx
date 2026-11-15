// 「標籤 X 的筆記」 has one answer (T4): the tag page (SchemaLens), the
// sidebar's counts and lib/nodeTags.ts tagMembers all list the notes of a tag
// BY ID — itself, its child tags and the tags extending it — the way the
// backend's saved views do (tagHierarchy.memberTagIds; the same fixture's
// `members` is checked there in
// packages/backend/src/test/tagMembershipParity.integration.test.ts).
// Same-named tags under different parents stay apart.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import fixture from "./fixtures/tagMembershipParity.json";
import SchemaLens from "../components/tagPage";
import { tagMembers, tagMemberCounts } from "../lib/nodeTags";
import { resetAppState } from "../lib/appStore";
import type { ContentNode, Tag } from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  api: vi.fn(async () => ({})),
}));

const id = (key: string) => `id-${key}`;
const tags: Tag[] = fixture.tags.map((t) => ({
  id: id(t.key), name: t.name, color: "", schema_id: null,
  parent_id: "parent" in t && t.parent ? id(t.parent) : null,
  schema_extends: "extends" in t && t.extends ? t.extends.map(id) : [],
  view_module: "viewModule" in t && !!t.viewModule,
  reserved_key: "reserved" in t ? t.reserved : null,
}));
const nodes: ContentNode[] = [
  ...fixture.notes.map((n) => ({
    id: id(n.key), title: n.key, slug: n.key, markdown: "", node_type: "content" as const,
    source_type: ("system" in n && n.system ? "system" : "manual") as ContentNode["source_type"],
    label_tag_ids: n.tags.map(id),
  })),
  // A tag row carrying tags (the workspace-config tag) is never a member.
  ...fixture.tags.flatMap((t) => "tags" in t && t.tags ? [{
    id: id(t.key), title: t.key, slug: t.key, markdown: "", node_type: "class_tag" as const,
    source_type: "manual" as const, label_tag_ids: t.tags.map(id),
  }] : []),
];
const keyOf = (rowId: string) => rowId.replace(/^id-/, "");

describe("the notes of a tag, by id", () => {
  beforeEach(() => resetAppState());
  const counts = tagMemberCounts(tags, nodes);

  for (const [key, expected] of Object.entries(fixture.members)) {
    it(`#${key}: tagMembers, tagMemberCounts and the tag page agree`, () => {
      expect(tagMembers(tags, nodes, id(key)).map((n) => keyOf(n.id)).sort()).toEqual([...expected].sort());
      expect(counts.get(id(key)) ?? 0).toBe(expected.length);

      const tag = tags.find((t) => t.id === id(key))!;
      const { container, unmount } = render(<SchemaLens tag={tag} online nodes={nodes} allTags={tags} />);
      const listed = [...container.querySelectorAll(".tag-member-list button")].map((b) => b.textContent ?? "");
      expect(listed.sort()).toEqual([...expected].sort());
      unmount();
    });
  }

  it("a #name written in a note's body or title is never a member (T10)", () => {
    const written: ContentNode[] = [
      { id: "w1", title: "w1", slug: "w1", markdown: "see #Draft", node_type: "content", source_type: "manual" },
      { id: "w2", title: "w2", slug: "w2", markdown: "#Lab notes", node_type: "content", source_type: "manual" },
      { id: "w3", title: "讀書 #Draft", slug: "w3", markdown: "# 讀書 #Draft", node_type: "content", source_type: "manual" },
    ];
    const all = [...nodes, ...written];
    for (const key of ["draftRoot", "draftNested", "lab", "course"]) {
      expect(tagMembers(tags, all, id(key)).some((n) => n.id.startsWith("w"))).toBe(false);
      const tag = tags.find((t) => t.id === id(key))!;
      const { container, unmount } = render(<SchemaLens tag={tag} online nodes={all} allTags={tags} />);
      const listed = [...container.querySelectorAll(".tag-member-list button")].map((b) => b.textContent ?? "");
      expect(listed.some((title) => title.startsWith("w") || title.includes("讀書"))).toBe(false);
      expect(listed.length).toBe(tagMemberCounts(tags, nodes).get(id(key)) ?? 0);
      unmount();
    }
  });
});
