// D37: every published-site summary of a note follows one rule
// (@onden/markdown noteSummary / bodyAfterTitle). A note written in Obsidian —
// frontmatter, then its title as an H1 — used to show `---` as its RSS
// description, `status: reading description: …` as its blog-list excerpt, and
// its title twice on the article page.

import { describe, it, expect } from "vitest";
import { feedSummary } from "../lib/siteFeed";
import type { PublishedNode } from "../components/templates/publishedCore";
import { bodyAfterTitle, noteSummary, snippetAround } from "@onden/markdown";

const OBSIDIAN = "---\nstatus: reading\ntags: [book]\n---\n# Deep Work\n\nFocus is a **skill**.\n\nSecond paragraph.";
const node = (markdown: string, over: Partial<PublishedNode> = {}): PublishedNode =>
  ({ id: "n1", node_type: "content", title: "Deep Work", slug: "deep-work", markdown, ...over });

const extractExcerpt = (n: PublishedNode, maxLen = 200) => noteSummary(n.markdown, { title: n.title, maxLen });

describe("RSS item description (feed.xml)", () => {
  it("is the prose, not the frontmatter fence", () => {
    expect(feedSummary(node(OBSIDIAN))).toBe("Focus is a skill. Second paragraph.");
  });

  it("uses a frontmatter description:", () => {
    expect(feedSummary(node("---\ndescription: Hand-written.\n---\n# Deep Work\n\nBody"))).toBe("Hand-written.");
  });
});

describe("list excerpts (blog list, page list, search fallback)", () => {
  it("never shows frontmatter keys", () => {
    const out = extractExcerpt(node("---\nstatus: reading\ndescription: \n---\nBody text here."));
    expect(out).toBe("Body text here.");
    expect(extractExcerpt(node(OBSIDIAN))).not.toMatch(/status|---|Deep Work/);
  });

  it("a short list cuts on a word with an ellipsis instead of mid-word", () => {
    const out = extractExcerpt(node(`# Deep Work\n\n${"focus ".repeat(40)}`), 100);
    expect(out.endsWith("focus…")).toBe(true);
  });
});

describe("article body (bodyAfterTitle)", () => {
  it("drops the title H1 that follows the frontmatter", () => {
    expect(bodyAfterTitle(OBSIDIAN, "Deep Work")).toBe("\nFocus is a **skill**.\n\nSecond paragraph.");
  });
});

// The published site's search snippet (snippetAround, D76).
const extractSnippet = (markdown: string, query: string, opts?: { before: number; after: number }) =>
  snippetAround(markdown, [query], opts)?.text ?? "";

describe("search snippet", () => {
  it("leaves the frontmatter out of the window", () => {
    const out = extractSnippet(OBSIDIAN, "focus");
    expect(out).toContain("Focus is a skill.");
    expect(out).not.toMatch(/---|status|tags/);
    expect(extractSnippet(OBSIDIAN, "reading")).toBe("");
  });

  it("reads wikilinks as their text", () => {
    expect(extractSnippet("see [[Cal Newport]] here", "newport", { before: 40, after: 90 })).toBe("see Cal Newport here");
  });
});
