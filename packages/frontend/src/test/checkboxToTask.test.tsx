// Checkbox → agenda task: the convert action's entire gating lives in
// `unconvertedTaskAt`. A typed `- [ ]` line must be promotable to a real task
// node; a `- [x]` (already promoted), an empty box, a plain bullet or a box
// inside a code block must NOT be. Checkboxes are the renderer's
// (lib/taskLines.ts), so every list marker and quoted boxes count too.

import { describe, it, expect } from "vitest";
import { unconvertedTaskAt } from "../components/MarkdownEditor";

const label = (markdown: string, line = 0) => unconvertedTaskAt(markdown, line)?.text ?? null;

describe("unconvertedTaskAt", () => {
  it("extracts the label of an unchecked checkbox line", () => {
    expect(label("- [ ] Ship the meeting notes")).toBe("Ship the meeting notes");
  });

  it("accepts * bullets and odd whitespace", () => {
    expect(label("  *  [ ]   Follow up with Sam  ")).toBe("Follow up with Sam");
  });

  it("accepts every list marker the renderer draws a box for, and quotes", () => {
    expect(label("+ [ ] plus")).toBe("plus");
    expect(label("1. [ ] ordered")).toBe("ordered");
    expect(label("3) [ ] paren")).toBe("paren");
    expect(label("> - [ ] quoted")).toBe("quoted");
    expect(label("> > 1. [ ] deep")).toBe("deep");
    expect(label("- outer\n  - [ ] nested", 1)).toBe("nested");
  });

  it("ignores a box inside a code block", () => {
    expect(label("```\n- [ ] code\n```", 1)).toBeNull();
    expect(label("~~~md\n- [ ] code\n~~~", 1)).toBeNull();
    expect(label("> ```\n> - [ ] code\n> ```", 1)).toBeNull();
    expect(label("para\n\n    - [ ] indented code", 2)).toBeNull();
    // After the fence closes it is a checkbox again.
    expect(label("```\nx\n```\n- [ ] real", 3)).toBe("real");
  });

  it("ignores an already-ticked box (treated as already promoted)", () => {
    expect(label("- [x] done thing")).toBeNull();
    expect(label("- [X] done thing")).toBeNull();
  });

  it("ignores an empty checkbox (no task text to mint)", () => {
    expect(label("- [ ] ")).toBeNull();
    expect(label("- [ ]")).toBeNull();
  });

  it("ignores non-checkbox lines", () => {
    expect(label("- a plain bullet")).toBeNull();
    expect(label("just some prose")).toBeNull();
    expect(label("# A heading")).toBeNull();
    expect(label("- [ ] a\n\nprose", 2)).toBeNull();
  });
});
