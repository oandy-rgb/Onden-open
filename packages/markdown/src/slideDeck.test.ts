import { describe, expect, it } from "vitest";
import { pagesOf } from "./slidePages.js";

describe("pagesOf locates each page in the note", () => {
  const note = "---\ntitle: x\n---\n# Plan\n\nWhat we do\n\n---\n\n## Steps\n\n- one\n- two\n- three\n";
  it("gives each page's text range, in the note's own offsets", () => {
    const pages = pagesOf(note);
    expect(pages.map((p) => p.autoLayout)).toEqual(["cover", "three"]);
    for (const p of pages) expect(note.slice(p.range!.from, p.range!.to)).toContain(p.parts.heading!);
    expect(pages[0]!.range!.to).toBeLessThanOrEqual(pages[1]!.range!.from);
  });
  it("reads CRLF text as LF offsets", () => {
    const pages = pagesOf("# A\r\n\r\nline\r\n\r\n---\r\n\r\n## B\r\n\r\n- x\r\n");
    const text = "# A\n\nline\n\n---\n\n## B\n\n- x\n";
    expect(text.slice(pages[1]!.range!.from, pages[1]!.range!.to)).toBe("## B\n\n- x");
  });
});
