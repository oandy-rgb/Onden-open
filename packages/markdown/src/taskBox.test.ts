import { describe, expect, it } from "vitest";
import { taskBoxEdit } from "./taskBox.js";

/** The paragraph at `offset` with taskBoxEdit's edit applied, or unchanged. */
const withTaskBox = (markdown: string, offset: number): string => {
  const edit = taskBoxEdit(markdown, offset);
  return edit ? markdown.slice(0, edit.at) + edit.insert + markdown.slice(edit.at) : markdown;
};

const box = (md: string, needle = "text") => withTaskBox(md, md.indexOf(needle));

describe("taskBoxEdit", () => {
  it("adds a box to a plain paragraph", () => expect(box("給你可以 text {task}")).toBe("- [ ] 給你可以 text {task}"));
  it("adds it after the marker of bullets and numbers, keeping indent", () => {
    expect(box("- text {task}")).toBe("- [ ] text {task}");
    expect(box("* text {task}")).toBe("* [ ] text {task}");
    expect(box("1. text {task}")).toBe("1. [ ] text {task}");
    expect(box("- a\n  - text {task}")).toBe("- a\n  - [ ] text {task}");
  });
  it("keeps a quote prefix on a list item", () => expect(box("> - text {task}")).toBe("> - [ ] text {task}"));
  it("leaves headings, tables, code, quotes and multi-line paragraphs alone", () => {
    for (const md of ["# text {task}", "| text {task} |\n| - |", "```\ntext {task}\n```", "> text {task}", "first\ntext {task}"]) {
      expect(box(md)).toBe(md);
    }
  });
  it("leaves a boxed line alone and is idempotent", () => {
    expect(box("- [x] text {task}")).toBe("- [x] text {task}");
    const once = box("text {task}");
    expect(withTaskBox(once, once.indexOf("text"))).toBe(once);
    expect(taskBoxEdit("- [ ] text {task}", 8)).toBeNull();
  });
});
