import { describe, expect, it } from "vitest";
import type { Tag } from "../lib/api";
import { isTagDefinitionLocked } from "../lib/systemNodes";
import { noteActionsFor } from "../lib/data/noteActionList";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

// The server refuses to delete or merge away a reserved tag, the tasks module's tag, and any other module's own tag
// while that module is on (backend reservedTags.assertTagDefinitionChange). The client offers neither; this is its one predicate.
const tag = (over: Partial<Tag>): Tag => ({ id: "t", name: "x", color: "", schema_id: null, ...over });
const on = (...ids: string[]) => (id: string) => ids.includes(id);

describe("isTagDefinitionLocked", () => {
  it("is false for an ordinary tag", () => {
    expect(isTagDefinitionLocked(tag({}), on("capture", "skills"))).toBe(false);
  });
  it("is true for a module's own tag while the module is on, false once it is off", () => {
    const skills = tag({ schema_module: "skills" });
    expect(isTagDefinitionLocked(skills, on("skills"))).toBe(true);
    expect(isTagDefinitionLocked(skills, on())).toBe(false);
  });
  it("is true for a reserved tag and for the tasks tag whatever the module state (the server's unconditional rules)", () => {
    expect(isTagDefinitionLocked(tag({ reserved_key: "workspace-config" }), on())).toBe(true);
    expect(isTagDefinitionLocked(tag({ schema_module: "tasks" }), on())).toBe(true);
  });
  it("is false for a view module's leftover tag: nothing reads it and the module cannot be turned off", () => {
    expect(isTagDefinitionLocked(tag({ schema_module: "calendar", view_module: true }), on("calendar"))).toBe(false);
  });
});

describe("a note's action list", () => {
  const node = (id: string) => ({ id, title: "x", slug: id, markdown: "", node_type: TAG_NODE_TYPE, source_type: "manual" as const });
  const inbox = tag({ id: "inbox", name: "收件匣", schema_module: "capture" });
  const plain = tag({ id: "plain", name: "plain" });
  const delta = (n: string, tags: Tag[], isImported?: (id: string) => boolean) =>
    noteActionsFor(node(n), { canEdit: true, online: true, tags, isImported }).has("delete");
  it("offers Delete for an ordinary tag and for an off module's tag, not for an on module's tag", () => {
    expect(delta("plain", [inbox, plain], on("capture"))).toBe(true);
    expect(delta("inbox", [inbox, plain], on("capture"))).toBe(false);
    expect(delta("inbox", [inbox, plain], on())).toBe(true);
  });
});
