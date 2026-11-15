// Unit tests for stripFrontmatter — verify YAML hiding behaviour.

import { describe, it, expect } from "vitest";
import { stripFrontmatter } from "@onden/markdown";

describe("stripFrontmatter", () => {
  it("drops a typical Obsidian-style frontmatter block", () => {
    const md = "---\ntitle: foo\ntags: [a, b]\n---\n\nReal content.\n";
    const out = stripFrontmatter(md);
    expect(out).not.toContain("title:");
    expect(out).not.toContain("tags:");
    expect(out).toContain("Real content");
  });

  it("leaves docs without frontmatter untouched", () => {
    const md = "# Heading\n\nbody text.\n";
    expect(stripFrontmatter(md)).toBe(md);
  });

  it("only strips at top — mid-doc `---title:---` block stays", () => {
    const md = "Some leading text.\n\n---\ntitle: hidden\n---\n";
    const out = stripFrontmatter(md);
    expect(out).toContain("Some leading text");
    // The `---title:---` part is not at top, so the regex anchor `^---`
    // won't match and the block stays as-is.
    expect(out).toContain("title: hidden");
  });

  it("handles an empty fence (---\\n---)", () => {
    const md = "---\n---\n\nbody\n";
    const out = stripFrontmatter(md);
    expect(out.trim()).toBe("body");
  });

  it("handles CRLF line endings", () => {
    const md = "---\r\ntitle: Win\r\n---\r\nbody\r\n";
    const out = stripFrontmatter(md);
    expect(out).not.toContain("title:");
    expect(out).toContain("body");
  });

  it("does not strip a stray `---` thematic break (no closing fence)", () => {
    const md = "---\n\nSection two follows.\n";
    // Single `---` with content but no closing `---` → not frontmatter.
    // Regex requires opening + content + closing, so this stays.
    const out = stripFrontmatter(md);
    expect(out).toContain("Section two");
  });
});
