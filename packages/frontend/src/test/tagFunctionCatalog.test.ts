// @vitest-environment node
// The function catalog is one list (modules' `tagFunction` registrations) that
// every surface reads: the tag page's 「功能」 row, the paragraph panel's 「試試功能」,
// the info panel's 「還能用在這則」 and the paragraph tools. These tests keep it
// whole (技能 is in it; guards/tag-function-catalog.guard keeps modules from
// being left out), and pin the one answer to "which kind of tag is this".
import { describe, expect, it } from "vitest";
import type { Tag } from "../lib/api";
import { tagFunctionModel } from "../components/tagPage/functionModel";
import { blockFunctions, functionCatalog, functionsOfModuleTag, tagDisplayName } from "../lib/tagFunctions";
import { tagKind } from "../lib/nodeTags";
import { t } from "../lib/i18n";
import { exampleOf } from "../components/functionCatalog/examples";

const tag = (id: string, extra: Partial<Tag> = {}): Tag => ({ id, name: id, color: "", schema_id: id, ...extra });
const all = () => true;

describe("function catalog", () => {
  it("lists the skills function, and not review (a card is a note's or paragraph's own reference, no tag function)", () => {
    const ids = functionCatalog().map((fn) => fn.id);
    expect(ids).toEqual(expect.arrayContaining(["skills"]));
    expect(ids).not.toContain("review");
    const byId = (id: string) => functionCatalog().find((fn) => fn.id === id);
    expect(ids).not.toContain("citations");
    expect(byId("skills")?.description).toMatch(/AI/);
  });

  it("gives every function a name, an icon and one sentence, and an example for the preview card", () => {
    for (const fn of functionCatalog()) {
      expect(fn.title, fn.id).toBeTruthy();
      expect(fn.description, fn.id).toBeTruthy();
      expect(fn.Icon, fn.id).toBeTruthy();
      expect(exampleOf(fn)?.result, fn.id).toBeTruthy();
    }
  });

  it("offers a paragraph the actions a paragraph can take (a review card, a task line), once, on or off", () => {
    const status = (id: string) => (id === "review" ? "on" : "off") as "on" | "off";
    // The words are the server's (workspace.line_words), not worked out from the tags here.
    const lineWords = { tasks: { words: ["task"], on: false }, review: { words: ["review", "複習"], on: true } };
    const rows = blockFunctions([], status, { canImport: true, lineWords });
    // Both are the module's own paragraph action (not tag functions): each writes the workspace's word, with no tag to make.
    expect(rows.map((row) => [row.fn.id, row.tagName, row.off, row.canTurnOn])).toEqual([
      ["review_block", "review", false, true],
      ["tasks_line", "task", true, true],
    ]);
    // The first word the server sends is the one written (a renamed tag's name, or 任務 when the user's own `task` tag holds the word).
    const renamed = { ...lineWords, tasks: { words: ["待辦", "task"], on: true } };
    expect(blockFunctions([], status, { canImport: true, lineWords: renamed }).map((row) => row.tagName)).toEqual(["review", "待辦"]);
    // With no words from the server (an older server) the paragraph offers no word-writing action.
    expect(blockFunctions([], status, { canImport: true }).map((row) => row.fn.id)).toEqual([]);
    // A person who can't decide still sees the example (canTurnOn false).
    expect(blockFunctions([], status, { canImport: false, used: ["review_block"], lineWords }).map((row) => [row.fn.id, row.canTurnOn]))
      .toEqual([["tasks_line", false], ["review_block", false]]);
    // Every row has an example for the card shown before it is on.
    for (const row of rows) expect(exampleOf(row.fn), row.fn.id).toBeTruthy();
  });
});

describe("one registration for the paragraph's action and the tag page's row (2026-11-12)", () => {
  it("review is a paragraph action only: the catalog of tag functions lists none for it", () => {
    expect(functionCatalog().filter((fn) => fn.blockAction).map((fn) => fn.id)).not.toContain("review");
    expect(blockFunctions([], () => "on", { canImport: true, lineWords: { review: { words: ["review"], on: true } } }).map((row) => row.fn.id)).toContain("review_block");
  });
});

describe("tagKind: own / function / system", () => {
  it("is own for a tag the person named, function for a module's tag, system for reserved and view layout tags", () => {
    expect(tagKind(tag("a", { name: "書" }))).toBe("own");
    for (const module of ["review", "skills", "tasks"]) expect(tagKind(tag("m", { schema_module: module })), module).toBe("function");
    expect(tagKind(tag("c", { reserved_key: "workspace-config" }))).toBe("system");
    expect(tagKind(tag("p", { reserved_key: "page" }))).toBe("system");
    expect(tagKind(tag("v", { schema_module: "table", view_module: true }))).toBe("system");
  });

  it("shows a function's tag by the function's name, never by `skill`", () => {
    expect(functionsOfModuleTag(tag("s", { schema_module: "skills" })).map((fn) => fn.id)).toEqual(["skills"]);
    // Through t(): the zh-TW dictionary may already hold a name ("Skills" is a boot string).
    expect(tagDisplayName(tag("s", { name: "skill", schema_module: "skills" }))).toBe(t("Skills"));
    expect(tagDisplayName(tag("b", { name: "書" }))).toBe("書");
    // The task module gives two functions; its tag shows the module's name.
    expect(tagDisplayName(tag("t", { name: "task", schema_module: "tasks" }))).toBe(t("Tasks"));
  });
});

describe("the old #技能 inheritance is the 技能 function", () => {
  it("a tag that extends the skill tag has the function directly, and can take it off", () => {
        const mine = tag("mine", { schema_extends: ["skill"], effective_modules: ["skills"], functions: [{ id: "skills", source_tag_id: "skill", ref_id: "ref" }] });
    const model = tagFunctionModel(mine, all);
    expect(model.abilities.map((fn) => fn.id)).toEqual(["skills"]);
    expect(model.routeOf("skills")).toBe("direct");
  });

  it("a held function whose module is off is dormant (還沒開)", () => {
    const mine = tag("mine", { schema_extends: ["rl"], effective_modules: ["skills"], functions: [{ id: "skills", source_tag_id: "rl", ref_id: "ref" }] });
    expect(tagFunctionModel(mine, all).routeOf("skills")).toBe("direct");
    const off = tagFunctionModel(mine, (id) => id !== "skills");
    expect(off.abilities.map((fn) => fn.id)).toEqual([]);
    expect(off.dormant.map((fn) => fn.id)).toEqual(["skills"]);
  });
});
