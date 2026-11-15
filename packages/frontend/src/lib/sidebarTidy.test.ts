import { describe, it, expect } from "vitest";
import type { ContentNode, Tag } from "./api";
import { tidySidebarRoots, withoutTasksNote } from "./sidebarTidy";
import { tasksNoteId } from "./dayNode";

const node = (id: string, extra: Partial<ContentNode> = {}) =>
  ({ id, title: id, node_type: "content", source_type: "manual", parent_id: null, ...extra }) as ContentNode;

describe("tidySidebarRoots", () => {
  it("drops RSS sources from the tree and counts them", () => {
    const r = tidySidebarRoots([node("a"), node("feed", { source_type: "rss" })]);
    expect(r.roots.map((n) => n.id)).toEqual(["a"]);
    expect(r.hiddenCount).toBe(1);
  });

  it("lists a row still held as node_type 'canvas' like any note, in order", () => {
    const r = tidySidebarRoots([node("a"), node("b", { node_type: "canvas" }), node("c")]);
    expect(r.roots.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(r.hiddenCount).toBe(0);
  });

  it("has no notion of boards: nesting is the real parent/child only", () => {
    expect(Object.keys(tidySidebarRoots([node("a")])).sort()).toEqual(["hiddenCount", "roots"]);
  });

  const INBOX = { id: "inbox", name: "收件匣", schema_module: "capture" } as unknown as Tag;

  it("leaves captures not yet filed out of the tree; filed ones are notes like any other", () => {
    const waiting = node("waiting", { class_tag_ids: ["inbox"] });
    const filed = node("filed", { attrs: { _captured: "true" } });
    const r = tidySidebarRoots([node("a"), waiting, filed], [INBOX]);
    expect(r.roots.map((n) => n.id)).toEqual(["a", "filed"]);
    expect(r.hiddenCount).toBe(1);
  });

  it("keeps everything while no inbox tag exists yet", () => {
    expect(tidySidebarRoots([node("a"), node("b", { class_tag_ids: ["inbox"] })], []).roots).toHaveLength(2);
  });
});

describe("任務 note", () => {
  const SPACE = "11111111-1111-4111-8111-111111111111";
  const SHARED = "22222222-2222-4222-8222-222222222222";
  const tasksId = tasksNoteId(SPACE);
  const sharedTasksId = tasksNoteId(SHARED);

  it("is not listed at the top level, by derived id", () => {
    const r = tidySidebarRoots([node("a"), node(tasksId, { title: "任務" })], [], [SPACE]);
    expect(r.roots.map((n) => n.id)).toEqual(["a"]);
    expect(r.hiddenCount).toBe(1);
  });

  it("keeps a note someone named 任務 under another id", () => {
    const r = tidySidebarRoots([node("mine", { title: "任務" })], [], [SPACE]);
    expect(r.roots.map((n) => n.id)).toEqual(["mine"]);
    expect(r.hiddenCount).toBe(0);
  });

  it("is not listed for any space, shared ones too", () => {
    const r = tidySidebarRoots([node("a"), node(tasksId), node(sharedTasksId)], [], [SPACE, SHARED]);
    expect(r.roots.map((n) => n.id)).toEqual(["a"]);
    expect(r.hiddenCount).toBe(2);
    const byParent = new Map([["top", [node(sharedTasksId, { parent_id: "top" }), node("n", { parent_id: "top" })]]]);
    expect(withoutTasksNote(byParent, [SPACE, SHARED]).get("top")!.map((n) => n.id)).toEqual(["n"]);
  });

  it("is listed until the spaces is known", () => {
    expect(tidySidebarRoots([node(tasksId)], [], []).roots).toHaveLength(1);
  });

  it("is not listed under the diary parent either", () => {
    const byParent = new Map([["diary", [node(tasksId, { parent_id: "diary" }), node("d1", { parent_id: "diary" })]]]);
    const out = withoutTasksNote(byParent, [SPACE]);
    expect(out.get("diary")!.map((n) => n.id)).toEqual(["d1"]);
    expect(withoutTasksNote(byParent, [])).toBe(byParent);
  });
});
