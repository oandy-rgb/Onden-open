import { describe, it, expect } from "vitest";
import { appendBlock, tickTaskAt } from "../components/MarkdownEditor";

// Where an insert's text goes when it finished after the editor left its note.
describe("edits for a note the editor left", () => {
  it("appends as its own block", () => {
    expect(appendBlock("para\n\n", "![x](u)")).toBe("para\n\n![x](u)");
    expect(appendBlock("", "![x](u)")).toBe("![x](u)");
  });

  it("ticks the box on the line it started on, and nothing else", () => {
    const body = "- [ ] buy milk\n- [x] buy milk\n- [ ] call";
    expect(tickTaskAt(body, 0, "buy milk")).toBe("- [x] buy milk\n- [x] buy milk\n- [ ] call");
    expect(tickTaskAt(body, 2, "gone")).toBe(body);
    expect(tickTaskAt(body, 1, "buy milk")).toBe(body); // already ticked
  });

  it("finds the line by position, not by its text", () => {
    const body = "- [ ] buy milk\n- [ ] buy milk";
    expect(tickTaskAt(body, 1, "buy milk")).toBe("- [ ] buy milk\n- [x] buy milk");
  });

  it("ticks any marker the renderer draws, but not a box in a code fence", () => {
    expect(tickTaskAt("> 1. [ ] call", 0, "call")).toBe("> 1. [x] call");
    expect(tickTaskAt("+ [ ] call", 0, "call")).toBe("+ [x] call");
    const fenced = "```\n- [ ] call\n```";
    expect(tickTaskAt(fenced, 1, "call")).toBe(fenced);
  });
});
