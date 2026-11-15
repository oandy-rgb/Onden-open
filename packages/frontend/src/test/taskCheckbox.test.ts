// Pure helper behind the interactive rendered task checkbox: flip the Nth
// (document order) `[ ]`/`[x]` source line, preserving everything else.

import { describe, it, expect } from "vitest";
import { toggleTaskLine } from "../lib/taskCheckbox";

describe("toggleTaskLine", () => {
  const md = [
    "# Heading",
    "- [ ] first",
    "- [x] second",
    "  - [ ] nested third",
    "regular line",
    "1. [ ] ordered fourth",
  ].join("\n");

  it("checks an unchecked box at its document-order index", () => {
    expect(toggleTaskLine(md, 0).split("\n")[1]).toBe("- [x] first");
  });

  it("unchecks a checked box", () => {
    expect(toggleTaskLine(md, 1).split("\n")[2]).toBe("- [ ] second");
  });

  it("preserves indentation and marker for nested items", () => {
    expect(toggleTaskLine(md, 2).split("\n")[3]).toBe("  - [x] nested third");
  });

  it("handles ordered-list task markers", () => {
    expect(toggleTaskLine(md, 3).split("\n")[5]).toBe("1. [x] ordered fourth");
  });

  it("leaves trailing content (text after the box) intact", () => {
    expect(toggleTaskLine("- [ ] buy milk #grocery", 0)).toBe("- [x] buy milk #grocery");
  });

  it("returns the original markdown unchanged for an out-of-range index", () => {
    expect(toggleTaskLine(md, 99)).toBe(md);
    expect(toggleTaskLine(md, -1)).toBe(md);
  });

  it("does not touch other task lines", () => {
    const out = toggleTaskLine(md, 0);
    const lines = out.split("\n");
    expect(lines[2]).toBe("- [x] second"); // untouched
    expect(lines[3]).toBe("  - [ ] nested third"); // untouched
  });
});
