import { describe, it, expect } from "vitest";
import { snippetAround } from "@onden/markdown";
import {
  nodeMatchesLink,
} from "../lib/utils";
import type { ContentNode } from "../lib/api";

// ── search snippet (was extractSnippet; the one rule is snippetAround, D76) ──

const extractSnippet = (markdown: string, query: string) => snippetAround(markdown, [query])?.text ?? "";

describe("search snippet", () => {
  it("returns empty string when query not found", () => {
    expect(extractSnippet("hello world", "xyz")).toBe("");
  });

  it("returns snippet around the match", () => {
    const snippet = extractSnippet("some text with the keyword inside it", "keyword");
    expect(snippet).toContain("keyword");
  });

  it("prepends ellipsis when match is not at start", () => {
    const long = "a".repeat(60) + "target" + "b".repeat(40);
    expect(extractSnippet(long, "target")).toMatch(/^…/);
  });

  it("appends ellipsis when content continues after match", () => {
    const long = "target" + "b".repeat(100);
    expect(extractSnippet(long, "target")).toMatch(/…$/);
  });

  it("strips heading markers from snippet", () => {
    const snippet = extractSnippet("## Section\nfind me here", "find me");
    expect(snippet).not.toContain("##");
  });

  it("is case-insensitive", () => {
    expect(extractSnippet("Hello World", "hello")).toContain("Hello");
  });
});

// ── nodeMatchesLink ──────────────────────────────────────────────────────────

const makeNode = (title: string, slug: string): ContentNode => ({
  id: "1", title, slug,
  source_type: "manual", node_type: "content",
  markdown: "",
});

describe("nodeMatchesLink", () => {
  it("matches an alias stored as a JSON array or a bare value; malformed aliases match nothing", () => {
    const base = { title: "Reading List", slug: "reading-list" };
    expect(nodeMatchesLink({ ...base, attrs: { aliases: '["待讀","TBR"]' } }, "tbr")).toBe(true);
    expect(nodeMatchesLink({ ...base, attrs: { aliases: "待讀" } }, "待讀|later")).toBe(true);
    expect(nodeMatchesLink({ ...base, attrs: { aliases: "[not json" } }, "not json")).toBe(false);
  });

  it("matches by exact title (case-insensitive)", () => {
    expect(nodeMatchesLink(makeNode("My Note", "my-note"), "My Note")).toBe(true);
    expect(nodeMatchesLink(makeNode("My Note", "my-note"), "my note")).toBe(true);
  });

  it("matches by slug", () => {
    expect(nodeMatchesLink(makeNode("My Note", "my-note"), "my note")).toBe(true);
  });

  it("returns false when neither title nor slug match", () => {
    expect(nodeMatchesLink(makeNode("Other", "other"), "My Note")).toBe(false);
  });

  it("matches when the link carries a display alias (Page|alias)", () => {
    expect(nodeMatchesLink(makeNode("My Note", "my-note"), "My Note|nice label")).toBe(true);
  });

  it("matches when the link carries a heading anchor (Page#heading)", () => {
    expect(nodeMatchesLink(makeNode("My Note", "my-note"), "My Note#Section")).toBe(true);
  });

  it("matches with both heading and alias present", () => {
    expect(nodeMatchesLink(makeNode("My Note", "my-note"), "My Note#Section|label")).toBe(true);
  });

  it("returns false for a same-page anchor with no target (#heading)", () => {
    expect(nodeMatchesLink(makeNode("My Note", "my-note"), "#Section")).toBe(false);
  });
});
