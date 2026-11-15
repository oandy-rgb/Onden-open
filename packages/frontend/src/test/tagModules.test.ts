import { describe, expect, it } from "vitest";
import type { ContentNode, Tag } from "../lib/api";
import { abilitySource, moduleTagOf, nodeHasTagModule, tagHasModule, tagsExtending, tagsProvidingModule } from "../lib/tagModules";

const tag = (id: string, name: string, enabled = true): Tag => ({
  id, name, color: "", schema_id: id,
  effective_modules: enabled ? ["review"] : [],
  functions: enabled ? [{ id: "review", source_tag_id: id, ref_id: `ref-${id}` }] : [],
});
const note: ContentNode = { id: "note", title: "Note", slug: "note", markdown: "#review #toread", source_type: "manual", node_type: "content" };

describe("tag module membership", () => {
  it("uses configuration after a rename and never infers functions from names", () => {
    expect(tagHasModule(tag("a", "Renamed course"), "review")).toBe(true);
    expect(tagHasModule({ effective_modules: [] }, "review")).toBe(false);
    expect(tagHasModule(tag("a", "review", false), "review")).toBe(false);
    expect(nodeHasTagModule(note, [tag("a", "review")], "review")).toBe(false);
  });

  it("collects all direct providers across label and schema membership without duplicates", () => {
    const enrolled = { ...note, class_tag_ids: ["a"], label_tag_ids: ["a", "b", "c"] };
    expect(tagsProvidingModule(enrolled, [tag("a", "Course"), tag("b", "Exam"), tag("c", "Paused", false)], "review").map((t) => t.id)).toEqual(["a", "b"]);
    expect(nodeHasTagModule(enrolled, [tag("a", "Course")], "review")).toBe(true);
  });

  it("does not turn a tag or canvas node into a review card", () => {
    for (const node_type of ["class_tag", "canvas"] as const) {
      expect(tagsProvidingModule({ ...note, node_type, class_tag_ids: ["a"] }, [tag("a", "Course")], "review")).toEqual([]);
    }
  });
});

describe("module tags and extends", () => {
  const plain = (id: string, extra: Partial<Tag> = {}): Tag => ({ id, name: id, color: "", schema_id: null, ...extra });
  const review = plain("review", { schema_module: "review", schema_extends: [] });
  const course = plain("course", { schema_extends: ["review"] });
  const paper = plain("paper", { schema_extends: ["course"] });
  const legacy = plain("legacy", { functions: [{ id: "review", source_tag_id: "legacy", ref_id: "r1" }] });
  // `paper` and `course` hold the function by their own reference, settings coming from the module's tag.
  const reference = { id: "review", source_tag_id: "review", ref_id: "r2" };
  const tags = [review, course, paper, legacy];

  it("an extending tag provides what the server computed through extends", () => {
    expect(tagHasModule({ ...paper, effective_modules: ["review"] }, "review")).toBe(true);
    expect(tagHasModule({ ...paper, effective_modules: [] }, "review")).toBe(false);
    // Without the server's list (an older server), only the tag's own module and its function references count.
    expect(tagHasModule(review, "review")).toBe(true);
    expect(tagHasModule(legacy, "review")).toBe(true);
    expect(tagHasModule(paper, "review")).toBe(false);
  });

  it("finds the module tag, the tags extending a tag at any depth, and where an ability comes from", () => {
    expect(moduleTagOf(tags, "review")?.id).toBe("review");
    expect(moduleTagOf(tags, "skills")).toBeNull();
    expect(tagsExtending(tags, "review").sort()).toEqual(["course", "paper"]);
    expect(tagsExtending(tags, "paper")).toEqual([]);
    expect(abilitySource([review, plain("paper", { functions: [reference] })], "paper", "review")?.id).toBe("review");
    expect(abilitySource(tags, "legacy", "review")?.id).toBe("legacy");
    expect(abilitySource(tags, "course", "skills")).toBeNull();
    // A cycle (refused by the server) cannot loop here.
    const a = plain("a", { schema_extends: ["b"] }), b = plain("b", { schema_extends: ["a"] });
    expect(tagsExtending([a, b], "a")).toEqual(["b"]);
    expect(abilitySource([a, b], "a", "review")).toBeNull();
    // A reference whose settings tag is not in the catalog has no source to show.
    expect(abilitySource([plain("x", { functions: [{ id: "review", source_tag_id: "gone", ref_id: "r" }] })], "x", "review")).toBeNull();
  });
});

