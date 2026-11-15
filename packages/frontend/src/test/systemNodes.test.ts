// Reserved tags are known by their reserved_key only (T5): renaming the
// workspace-config tag does not make it appear in lists, and an ordinary tag
// that happens to carry a reserved title (#reading/task, #workspace-config) is
// an ordinary tag.
import { describe, it, expect } from "vitest";
import { isReservedTag, isSystemNode, isSystemTag, tagsById, SYSTEM_TAG_KEY } from "../lib/systemNodes";
import type { Tag } from "../lib/api";

const tag = (id: string, name: string, reserved_key?: string | null) =>
  ({ id, name, reserved_key, color: "", schema_id: null }) as Tag;

describe("reserved tag identity", () => {
  it("follows the reserved key, whatever the title", () => {
    expect(isSystemTag(tag("a", "設定", SYSTEM_TAG_KEY))).toBe(true);
    expect(isSystemTag(tag("b", SYSTEM_TAG_KEY, null))).toBe(false);
    expect(isSystemTag(tag("c", "task", "page"))).toBe(false);
    expect(isReservedTag(tag("c", "待辦", "page"), "page")).toBe(true);
    expect(isReservedTag(tag("c", "待辦", "page"))).toBe(true);
    expect(isReservedTag(tag("d", "page", null), "page")).toBe(false);
  });

  it("never falls back to the title (a key-less copy is an ordinary tag)", () => {
    expect(isSystemTag(tag("a", SYSTEM_TAG_KEY))).toBe(false);
    expect(isReservedTag(tag("b", "task"))).toBe(false);
  });

  it("looks a tag node up in the catalog by id", () => {
    const index = tagsById([tag("renamed", "Workspace settings", SYSTEM_TAG_KEY), tag("plain", SYSTEM_TAG_KEY, null)]);
    expect(isSystemNode({ id: "renamed", node_type: "class_tag" }, index)).toBe(true);
    expect(isSystemNode({ id: "plain", node_type: "class_tag" }, index)).toBe(false);
    // Not in the catalog: nothing says it is the config tag.
    expect(isSystemNode({ id: "unknown", node_type: "class_tag" }, index)).toBe(false);
    expect(isSystemNode({ id: "note", node_type: "content" }, index)).toBe(false);
    expect(isSystemNode({ id: "site", node_type: "content", source_type: "system" }, index)).toBe(true);
  });
});
