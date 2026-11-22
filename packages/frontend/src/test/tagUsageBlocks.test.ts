// @vitest-environment node
// A tag used only on paragraphs is used: the sidebar's number, 「沒在用」 and the tidy line read one usage
// (directTagUsage: the notes that carry it plus the catalog's block_usage_count), so a tag that sits on one
// paragraph shows 1, not 0, and is not offered for tidying.
import { describe, expect, it } from "vitest";
import { directTagUsage } from "../lib/nodeTags";
import { tagTidyReport, tagTreeRows } from "../lib/tagTree";
import type { Tag } from "../lib/api";

const tag = (id: string, name: string, block_usage_count?: number): Tag => ({ id, name, color: null, ...(block_usage_count === undefined ? {} : { block_usage_count }) }) as Tag;

describe("directTagUsage counts paragraphs", () => {
  it("a tag on one paragraph and no note is used once", () => {
    const tags = [tag("a", "作業", 1), tag("b", "沒人用")];
    expect(directTagUsage([], tags).get("a")).toBe(1);
    expect(directTagUsage([], tags).get("b") ?? 0).toBe(0);
  });

  it("notes and paragraphs add up", () => {
    const notes = [{ id: "n1", node_type: "note", class_tag_ids: ["a"], tag_ids: ["a"] }] as never[];
    const usage = directTagUsage(notes, [tag("a", "作業", 2)]);
    expect(usage.get("a")).toBe(3);
  });

  it("the tidy line does not call a paragraph-only tag unused", () => {
    const tags = [tag("a", "作業", 1), tag("b", "沒人用")];
    const report = tagTidyReport(tagTreeRows(tags), directTagUsage([], tags));
    expect(report.unused.map((row) => row.id)).toEqual(["b"]);
  });

  it("an older server sends no count: usage is the notes alone", () => {
    expect(directTagUsage([], [tag("a", "作業")]).get("a") ?? 0).toBe(0);
  });
});
