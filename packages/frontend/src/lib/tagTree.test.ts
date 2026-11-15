import { describe, expect, it } from "vitest";
import { canMoveTagUnder, filterTagTree, isRemovedModuleTag, splitTagSections, tagTidyReport, tagTreeRows } from "./tagTree";
import { moduleFilterFor } from "../modules";

const tag = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, parent_id: null as string | null, ...extra });

describe("tagTreeRows", () => {
  it("orders each tag before its children, siblings by name, with depth", () => {
    const rows = tagTreeRows([tag("c", "Sci-fi", { parent_id: "b" }), tag("b", "Novel", { parent_id: "a" }), tag("a", "Book"), tag("d", "Art")]);
    expect(rows.map((r) => [r.tag.name, r.depth, r.childCount])).toEqual([["Art", 0, 0], ["Book", 0, 1], ["Novel", 1, 1], ["Sci-fi", 2, 0]]);
  });

  it("leaves out reserved tags and view module tags; a child of a hidden tag is at the top", () => {
    const rows = tagTreeRows([
      tag("sys", "workspace-config", { reserved_key: "workspace-config" }), tag("task", "task", { reserved_key: "task" }),
      tag("board", "看板", { schema_module: "kanban", view_module: true }), tag("x", "Under task", { parent_id: "task" }),
    ]);
    expect(rows.map((r) => [r.tag.name, r.depth])).toEqual([["Under task", 0]]);
  });

  it("lists a parent loop once instead of looping", () => {
    const rows = tagTreeRows([tag("a", "A", { parent_id: "b" }), tag("b", "B", { parent_id: "a" })]);
    expect(rows.map((r) => r.tag.name).sort()).toEqual(["A", "B"]);
  });
});

describe("filterTagTree", () => {
  it("keeps the ancestors of a match; a leading # is ignored", () => {
    const rows = tagTreeRows([tag("a", "Book"), tag("b", "Novel", { parent_id: "a" }), tag("c", "Meeting")]);
    expect(filterTagTree(rows, "#nov").map((r) => r.tag.name)).toEqual(["Book", "Novel"]);
    expect(filterTagTree(rows, " ").length).toBe(3);
  });
});

describe("tagTidyReport", () => {
  it("finds unused leaf tags and near-duplicate names", () => {
    const rows = tagTreeRows([
      tag("a", "Reading"), tag("b", "reading-list"), tag("c", "Readings"), tag("d", "ＡＩ"), tag("e", "ai"),
      tag("f", "Parent"), tag("g", "Kid", { parent_id: "f" }), tag("h", "複習", { schema_module: "review" }),
    ]);
    const report = tagTidyReport(rows, new Map([["a", 1], ["b", 1], ["c", 1], ["d", 1], ["e", 1]]));
    expect(report.unused.map((t) => t.name)).toEqual(["Kid"]);
    expect(report.similar.map(([x, y]) => [x.name, y.name])).toEqual([["ai", "ＡＩ"], ["Reading", "Readings"]]);
  });
});

describe("全部標籤 sections", () => {
  const review = tag("r", "複習", { schema_module: "review" });
  const study = tag("s", "讀書", { schema_extends: ["r"], effective_modules: ["review"] });

  it("a module tag (schema_module) is the module's; every other listed tag is the person's", () => {
    const { own, fromModules } = splitTagSections([study, review, tag("t", "task", { reserved_key: "task" }), tag("k", "看板", { schema_module: "kanban", view_module: true })]);
    expect(own.map((t) => t.name)).toEqual(["讀書"]);
    expect(fromModules.map((t) => t.name)).toEqual(["複習"]);
  });

  it("a tag of a module not imported now is `removed`, not 來自模組; hidden wins over both", () => {
    const skill = tag("k2", "論文", { schema_module: "citations" });
    const hiddenSkill = tag("k3", "skill-old", { schema_module: "citations", hidden: true });
    const hiddenReview = tag("r2", "複習2", { schema_module: "review", hidden: true });
    const split = splitTagSections([study, review, skill, hiddenSkill, hiddenReview], moduleFilterFor(["review", "rss"]));
    expect(split.own.map((t) => t.name)).toEqual(["讀書"]);
    expect(split.fromModules.map((t) => t.name)).toEqual(["複習"]);
    expect(split.removed.map((t) => t.name)).toEqual(["論文"]);
    expect(split.hidden.map((t) => t.name)).toEqual(["skill-old", "複習2"].sort((a, b) => a.localeCompare(b)));
    expect(isRemovedModuleTag({ schema_module: "citations" }, moduleFilterFor(["review"]))).toBe(true);
    expect(isRemovedModuleTag({ schema_module: "review" }, moduleFilterFor(["review"]))).toBe(false);
    expect(isRemovedModuleTag({ schema_module: null }, moduleFilterFor([]))).toBe(false);
    // A workspace from before the module library imports every module.
    expect(splitTagSections([review]).removed).toEqual([]);
  });

  it("canMoveTagUnder never moves a function or puts a tag under one", () => {
    expect(canMoveTagUnder([review, study], "s", "r")).toBe(false);
    expect(canMoveTagUnder([review, study], "r", "s")).toBe(false);
    expect(canMoveTagUnder([review, study, tag("o", "other")], "s", "o")).toBe(true);
  });
});
