import { describe, it, expect } from "vitest";
import { DraftNode } from "@onden/contract";
import { extractWikilinks } from "../utils.js";
import { noteSummary, slugify } from "@onden/markdown";

// ── slugify ──────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("trims leading and trailing whitespace", () => {
    expect(slugify("  Hello  ")).toBe("hello");
  });

  it("removes leading and trailing hyphens", () => {
    expect(slugify("-hello-")).toBe("hello");
  });

  it("collapses multiple hyphens into one", () => {
    expect(slugify("hello--world")).toBe("hello-world");
  });

  it("strips non-alphanumeric, non-hyphen characters", () => {
    expect(slugify("hello! world?")).toBe("hello-world");
  });

  it("handles unicode letters", () => {
    expect(slugify("知識 管理")).toBe("知識-管理");
  });

  it("falls back to 'node' for empty or symbol-only input", () => {
    expect(slugify("")).toBe("node");
    expect(slugify("!!!")).toBe("node");
  });

  it("handles single-word input", () => {
    expect(slugify("onden")).toBe("onden");
  });

  it("handles already-valid slug", () => {
    expect(slugify("my-note")).toBe("my-note");
  });
});

// ── extractWikilinks ─────────────────────────────────────────────────────────

describe("extractWikilinks", () => {
  it("extracts a single wikilink", () => {
    expect(extractWikilinks("See [[My Note]] for details")).toEqual(["My Note"]);
  });

  it("extracts multiple wikilinks", () => {
    const result = extractWikilinks("[[Alpha]] and [[Beta]] are linked");
    expect(result).toContain("Alpha");
    expect(result).toContain("Beta");
    expect(result).toHaveLength(2);
  });

  it("deduplicates repeated wikilinks", () => {
    expect(extractWikilinks("[[Note]] and [[Note]] again")).toEqual(["Note"]);
  });

  it("trims whitespace inside brackets", () => {
    expect(extractWikilinks("[[ My Note ]]")).toEqual(["My Note"]);
  });

  it("returns empty array when no wikilinks", () => {
    expect(extractWikilinks("plain text without links")).toEqual([]);
  });

  it("handles wikilinks across multiple lines", () => {
    const md = "Line one [[A]]\nLine two [[B]]";
    expect(extractWikilinks(md)).toEqual(["A", "B"]);
  });

  it("ignores malformed single-bracket links", () => {
    expect(extractWikilinks("[not a wikilink]")).toEqual([]);
  });
});

// ── DraftNode ───────────────────────────────────────────────────────────────

describe("DraftNode", () => {
  it("parses a minimal valid node", () => {
    const result = DraftNode.safeParse({ title: "My Note" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("My Note");
      expect(result.data.node_type).toBe("content");
    }
  });

  it("applies defaults for omitted fields", () => {
    const result = DraftNode.safeParse({ title: "T" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.markdown).toBe("");
      expect(result.data.hidden).toBe(false);
      expect(result.data.sort_order).toBe(0);
    }
  });

  it("rejects empty title", () => {
    expect(DraftNode.safeParse({ title: "" }).success).toBe(false);
  });

  it("rejects missing title", () => {
    expect(DraftNode.safeParse({}).success).toBe(false);
  });

  it("rejects invalid node_type", () => {
    expect(DraftNode.safeParse({ title: "T", node_type: "image" }).success).toBe(false);
  });

  it("accepts valid parent_id uuid", () => {
    const result = DraftNode.safeParse({
      title: "T",
      parent_id: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-uuid parent_id", () => {
    expect(DraftNode.safeParse({ title: "T", parent_id: "not-a-uuid" }).success).toBe(false);
  });

  it("accepts null parent_id", () => {
    expect(DraftNode.safeParse({ title: "T", parent_id: null }).success).toBe(true);
  });
});

// ── noteSummary (the list / site excerpt; was utils excerptOf) ──────────────

const excerptOf = (md: string, maxLen = 280, title?: string) => noteSummary(md, { title, maxLen });

describe("noteSummary", () => {
  it("strips markdown furniture down to preview prose", () => {
    const md = "---\ntitle: x\n---\n# Heading\n\nSome **bold** text with a [link](https://x) and [[Wiki Page|alias]].\n\n```js\ncode();\n```\n\n![img](/a.png)\n\n> quoted";
    const out = excerptOf(md);
    expect(out).toContain("Some bold text with a link and alias.");
    expect(out).not.toContain("#");
    expect(out).not.toContain("```");
    expect(out).not.toContain("](");
    expect(out).not.toContain("---");
  });

  it("caps length on a word boundary with an ellipsis", () => {
    const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const out = excerptOf(long, 100);
    expect(out.length).toBeLessThanOrEqual(101); // cut + ellipsis
    expect(out.endsWith("…")).toBe(true);
    // never cuts mid-word when a boundary is near: the last token before the
    // ellipsis must be one of the input's complete words
    const lastToken = out.slice(0, -1).trim().split(" ").pop();
    expect(lastToken).toMatch(/^word\d+$/);
  });

  it("returns short bodies unchanged", () => {
    expect(excerptOf("just a line")).toBe("just a line");
  });

  it("an Obsidian note (frontmatter + title H1) previews its prose, not `---` (D37)", () => {
    const md = "---\nstatus: reading\n---\n# Deep Work\n\nFocus is a skill.";
    expect(excerptOf(md, 280, "Deep Work")).toBe("Focus is a skill.");
    expect(excerptOf("---\ndescription: Hand-written.\n---\n# Deep Work\n\nBody", 280, "Deep Work")).toBe("Hand-written.");
  });
});
