import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { defaultDesignV2, type SiteDesignV2 } from "@onden/site";
import type { Space } from "../../../lib/spaces";
import { blockedNotes, buildEditorMeta, defaultDesignInputs, referencedNoteIds, studioNotes, studioTags } from "./editorData";
import { node, published, tag } from "./fixtures";

const personal = { id: "sp1", kind: "personal", is_default: false, name: "me", capabilities: { publish: false } } as unknown as Space;
const everyone = { id: "sp2", kind: "shared", is_default: true, name: "all", capabilities: { publish: true } } as unknown as Space;
const render = (markdown: string): ReactNode => markdown;

const tagA = tag({ id: "tA", name: "文章" });
const nodes = [
  node({ id: "home", title: "Home", attrs: published, space_id: "sp2", updated_at: "2026-03-05T00:00:00Z" }),
  node({ id: "a1", title: "Alpha", attrs: published, space_id: "sp2", label_tag_ids: ["tA"], updated_at: "2026-03-04T00:00:00Z", markdown: "# Alpha\n\n![](pic.png)\n\nHello." }),
  node({ id: "a2", title: "Draft", space_id: "sp2", label_tag_ids: ["tA"] }),
  node({ id: "a3", title: "Secret", attrs: published, space_id: "sp1", label_tag_ids: ["tA"] }),
  node({ id: "sys", title: "Site Config", source_type: "system" }),
  node({ id: "tg", title: "文章", node_type: "class_tag" }),
];

describe("studioNotes", () => {
  const list = studioNotes(nodes, [personal, everyone]);
  it("lists readable content notes only, newest first", () => {
    expect(list.map((n) => n.id)).toEqual(["home", "a1", "a2"]);
  });
  it("leaves out the notes of a space that cannot publish, marked or not", () => {
    expect(list.map((n) => n.id)).not.toContain("a3");
    const unmarked = [...nodes, node({ id: "a4", title: "Private", space_id: "sp1" })];
    expect(studioNotes(unmarked, [personal, everyone]).map((n) => n.id)).not.toContain("a4");
    // a space the device does not know yet is not reported as closed
    expect(studioNotes(unmarked, []).map((n) => n.id)).toContain("a4");
  });
  it("tells published from unpublished", () => {
    const by = Object.fromEntries(list.map((n) => [n.id, n]));
    expect(by.a1).toMatchObject({ published: true, title: "Alpha", updatedAt: "2026-03-04T00:00:00Z" });
    expect(by.a2).toMatchObject({ published: false });
  });
});

describe("blockedNotes", () => {
  it("names the notes a closed space keeps off the site, with the reason and whether they were marked", () => {
    const unmarked = [...nodes, node({ id: "a4", title: "Private", space_id: "sp1" })];
    const blocked = blockedNotes(unmarked, [personal, everyone]);
    expect(blocked.map((n) => [n.id, n.marked, n.blocker.reason])).toEqual([["a3", true, "space"], ["a4", false, "space"]]);
    expect(blocked[0]!.blocker).toMatchObject({ reason: "space", space: expect.any(String) });
    expect(blockedNotes(nodes, [everyone])).toEqual([]);
  });
});

describe("studioTags / defaultDesignInputs", () => {
  it("counts members, leaves out reserved tags", () => {
    const tags = studioTags(nodes, [tagA, tag({ id: "tR", name: "page", reserved_key: "page" })], [personal, everyone]);
    expect(tags).toEqual([{ id: "tA", name: "文章", memberCount: 2 }]);
  });
  it("counts only the notes that can be published: a closed space's notes are not members", () => {
    expect(studioTags(nodes, [tagA], [personal, everyone])).toEqual([{ id: "tA", name: "文章", memberCount: 2 }]);
    expect(studioTags(nodes, [tagA], [])).toEqual([{ id: "tA", name: "文章", memberCount: 3 }]); // spaces not loaded yet: nothing is known to be closed
    const onlyPrivate = [node({ id: "p1", title: "P", attrs: published, space_id: "sp1", label_tag_ids: ["tA"] })];
    expect(studioTags(onlyPrivate, [tagA], [personal, everyone])).toEqual([{ id: "tA", name: "文章", memberCount: 0 }]);
  });
  it("the default design's inputs: the workspace home when published, the tag with most published members", () => {
    const list = studioNotes(nodes, [personal, everyone]);
    expect(defaultDesignInputs(list, nodes, [tagA], "home")).toEqual({ homeNoteId: "home", topTagId: "tA" });
    // a home that is not on the site falls back to the first untagged published note
    expect(defaultDesignInputs(list, nodes, [tagA], "a2").homeNoteId).toBe("home");
  });
  it("a note in a closed space is never the default home or the top tag's count", () => {
    const only = [
      node({ id: "secret", title: "Secret", attrs: published, space_id: "sp1" }),
      node({ id: "s1", title: "S1", attrs: published, space_id: "sp1", label_tag_ids: ["tA"] }),
      node({ id: "s2", title: "S2", attrs: published, space_id: "sp1", label_tag_ids: ["tA"] }),
      node({ id: "open", title: "Open", attrs: published, space_id: "sp2" }),
    ];
    const list = studioNotes(only, [personal, everyone]);
    expect(defaultDesignInputs(list, only, [tagA], "secret")).toEqual({ homeNoteId: "open", topTagId: null });
  });
});

describe("buildEditorMeta: the canvas shows only what would be published", () => {
  const notes = studioNotes(nodes, [personal, everyone]);
  const design: SiteDesignV2 = {
    ...defaultDesignV2({}),
    home: { root: { props: {} }, content: [
      { type: "stack", props: { id: "s", bg: "none", heading: "auto", cls: "", css: "", items: [
        { type: "note", props: { id: "n-draft", noteId: "a2", blockId: "", display: "full" } },
        { type: "note", props: { id: "n-alpha", noteId: "a1", blockId: "", display: "full" } },
        { type: "tag_view", props: { id: "tv", tagId: "tA", viewId: "", viewKind: "cards", limit: 6, sort: "new" } },
      ] } },
    ] },
  };
  const meta = buildEditorMeta({ nodes, tags: [tagA], notes, design, renderMarkdown: render });
  it("an unpublished note is not among the notes, so it draws as the 未發布 placeholder, never its text", () => {
    expect(Object.keys(meta.notes).sort()).toEqual(["a1", "home"]);
    expect(meta.editing).toBe(true);
    expect(JSON.stringify(meta)).not.toContain("Body of Draft");
  });
  it("an unpublished note the page points at carries its title for the canvas' 未發布 mark, nothing else of it", () => {
    expect(meta.drafts).toEqual({ a2: { title: "Draft" } });
    expect(meta.notes.a2).toBeUndefined();
    // once it counts as published (「一起發布」 preview) it is content, not a draft
    const also = buildEditorMeta({ nodes, tags: [tagA], notes, design, alsoPublished: new Set(["a2"]), renderMarkdown: render });
    expect(also.drafts).toEqual({});
  });
  it("a note moved to a closed space after it was placed is still named (the suggestion tells the owner to pick another)", () => {
    const moved = [...nodes.filter((n) => n.id !== "a2"), node({ id: "a2", title: "Moved", space_id: "sp1" })];
    const movedNotes = studioNotes(moved, [personal, everyone]);
    expect(movedNotes.map((n) => n.id)).not.toContain("a2");
    expect(buildEditorMeta({ nodes: moved, tags: [tagA], notes: movedNotes, design, renderMarkdown: render }).drafts).toEqual({ a2: { title: "Moved" } });
  });
  it("a tag view lists the tag's published members only, with the same row shape", () => {
    expect(meta.resolved.tv!.map((r) => r.id)).toEqual(["a1"]);
    expect(meta.resolved.tv![0]).toMatchObject({ title: "Alpha", slug: "alpha" });
    expect(meta.tagNames).toEqual({ tA: "文章" });
  });
  it("「一起發布」 previews the note as published", () => {
    const also = buildEditorMeta({ nodes, tags: [tagA], notes, design, alsoPublished: new Set(["a2"]), renderMarkdown: render });
    expect(also.notes.a2!.markdown).toContain("Body of Draft");
    expect(also.resolved.tv!.map((r) => r.id).sort()).toEqual(["a1", "a2"]);
  });
  it("dates show only for notes with a date tag", () => {
    expect(meta.resolved.tv![0]!.date).toBe("2026-03-01");
    expect(buildEditorMeta({ nodes, tags: [tagA], notes, design: { ...design, frames: { ...design.frames, date_tags: ["別的"] } }, renderMarkdown: render }).resolved.tv![0]!.date).toBe("");
  });
  it("lists the notes a design points at", () => {
    expect(referencedNoteIds(design)).toEqual(["a2", "a1"]);
  });
});
