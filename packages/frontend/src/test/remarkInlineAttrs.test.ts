// Unit tests for remarkInlineAttrs — verify standalone key:: value hiding.

import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { remarkInlineAttrs } from "@onden/markdown";

function process(md: string): string {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkInlineAttrs)
      .use(remarkStringify)
      .processSync(md),
  );
}

describe("remarkInlineAttrs — render-side hiding", () => {
  it("drops a standalone key:: value paragraph", () => {
    const out = process("status:: doing\n\nSome real content.\n");
    expect(out).not.toContain("status::");
    expect(out).toContain("Some real content");
  });

  it("drops multiple standalone attribute lines", () => {
    const md = "status:: doing\npriority:: high\n\nThe rest of the note.\n";
    const out = process(md);
    expect(out).not.toContain("status::");
    expect(out).not.toContain("priority::");
    expect(out).toContain("The rest of the note");
  });

  it("keeps bracketed inline `[key:: value]` form visible", () => {
    // Bracketed lives in prose; stripping would leave a hole.
    const out = process("Reading [author:: Roy] on REST.\n");
    expect(out).toContain("[author:: Roy]");
    expect(out).toContain("REST");
  });

  it("does not drop paragraphs that just MENTION `::`", () => {
    // The :: appears mid-text, not in key:: format → keep it.
    const out = process("See section 2::3 for details.\n");
    expect(out).toContain("section 2::3");
  });

  it("keeps the prose line joined to an attribute line (one paragraph in CommonMark)", () => {
    const out = process("Intro.\n\ndue:: 2026-10-20\nCall the lawyer about the contract.\n\nEnd.\n");
    expect(out).not.toContain("due::");
    expect(out).toContain("Call the lawyer about the contract.");
    expect(out).toContain("Intro.");
    expect(out).toContain("End.");
  });

  it("hides an attribute line in the middle of a paragraph only", () => {
    const out = process("First line.\nstatus:: doing\nLast line.\n");
    expect(out).not.toContain("status::");
    expect(out.trim()).toBe("First line.\nLast line.");
  });

  it("leaves key:: value inside a ~~~ fence visible", () => {
    expect(process("~~~\nstatus:: in-code\n~~~\n")).toContain("status:: in-code");
  });

  it("does not drop paragraphs starting with non-attr-like text", () => {
    expect(process("hello world\n").trim()).toBe("hello world");
  });
});
