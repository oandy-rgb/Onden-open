import { describe, expect, it } from "vitest";
import { clampNoteTitle, NODE_MARKDOWN_MAX, NODE_TITLE_MAX, noteSizeProblem } from "./noteLimits.js";

describe("note size caps (D67)", () => {
  it("names the cap a note breaks", () => {
    expect(noteSizeProblem({ title: "t".repeat(NODE_TITLE_MAX), markdown: "m".repeat(NODE_MARKDOWN_MAX) })).toBeNull();
    expect(noteSizeProblem({ title: "t".repeat(NODE_TITLE_MAX + 1) })).toBe("title_too_long");
    expect(noteSizeProblem({ markdown: "m".repeat(NODE_MARKDOWN_MAX + 1) })).toBe("too_large");
    expect(noteSizeProblem({})).toBeNull();
  });

  it("cuts a derived title to the cap without splitting a surrogate pair", () => {
    expect(clampNoteTitle("short")).toBe("short");
    expect(clampNoteTitle("x".repeat(600))).toBe("x".repeat(500));
    const emoji = "x".repeat(499) + "😀" + "y";
    expect(clampNoteTitle(emoji)).toBe("x".repeat(499));
    expect(clampNoteTitle("abcdef", 3)).toBe("abc");
  });
});
