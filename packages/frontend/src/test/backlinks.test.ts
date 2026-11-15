import { describe, it, expect } from "vitest";
import { findBacklinkSnippet, nodeMatchesLink, findMentionSnippet } from "../lib/backlinks";
import type { ContentNode } from "../lib/api";

// Backlink / mention derivation: wikilink matching (title OR slug), context
// snippet windowing, and unlinked-mention detection (word boundary + skip
// existing [[wikilinks]]). nodeMatchesLink also backs openWikilink's
// create-on-click path, so its title/slug equivalence is load-bearing.

const node = (over: Partial<ContentNode>): ContentNode =>
  ({ id: "n", title: "T", slug: "t", markdown: "", ...over } as ContentNode);

describe("nodeMatchesLink", () => {
  const target = node({ title: "My Great Note", slug: "my-great-note" });

  it("matches on title, case- and whitespace-insensitive", () => {
    expect(nodeMatchesLink(target, "  my great note ")).toBe(true);
  });

  it("matches on slug", () => {
    expect(nodeMatchesLink(target, "my-great-note")).toBe(true);
  });

  it("matches a title typed in slug-ish form (spaces → hyphens, punctuation dropped)", () => {
    expect(nodeMatchesLink(node({ title: "Hello, World!", slug: "hello-world" }), "Hello World")).toBe(true);
  });

  it("does not match an unrelated label", () => {
    expect(nodeMatchesLink(target, "some other note")).toBe(false);
  });
});

describe("findBacklinkSnippet", () => {
  it("returns a context window around a [[Title]] link with highlight offsets", () => {
    const source = node({ markdown: "before text [[My Note]] after text" });
    const target = node({ title: "My Note", slug: "my-note" });
    const snip = findBacklinkSnippet(source, target)!;
    expect(snip.text).toBe("before text [[My Note]] after text");
    expect(snip.text.slice(snip.linkStart, snip.linkEnd)).toBe("[[My Note]]");
    expect(snip.truncatedStart).toBe(false);
    expect(snip.truncatedEnd).toBe(false);
  });

  it("matches the [[slug]] form too", () => {
    const source = node({ markdown: "see [[my-note]] here" });
    const target = node({ title: "My Note", slug: "my-note" });
    expect(findBacklinkSnippet(source, target)).not.toBeNull();
  });

  it("exposes the ABSOLUTE link offset for the cursor handoff (land-on-line)", () => {
    // Far enough in that the snippet is truncated, so linkAbsStart != linkStart.
    const pad = "y".repeat(200);
    const source = node({ markdown: `${pad} [[My Note]] tail` });
    const target = node({ title: "My Note", slug: "my-note" });
    const snip = findBacklinkSnippet(source, target)!;
    // linkAbsStart points at the '[[' in the FULL body, not within the snippet.
    expect(source.markdown!.slice(snip.linkAbsStart, snip.linkAbsStart + 11)).toBe("[[My Note]]");
    expect(snip.linkAbsStart).toBe(201); // 200 pad + 1 space
    expect(snip.linkAbsStart).not.toBe(snip.linkStart); // truncated → they diverge
  });

  it("flags truncation when the link is far inside a long body", () => {
    const pad = "x".repeat(200);
    const source = node({ markdown: `${pad} [[My Note]] ${pad}` });
    const target = node({ title: "My Note", slug: "my-note" });
    const snip = findBacklinkSnippet(source, target)!;
    expect(snip.truncatedStart).toBe(true);
    expect(snip.truncatedEnd).toBe(true);
    expect(snip.text.slice(snip.linkStart, snip.linkEnd)).toBe("[[My Note]]");
  });

  it("returns null when the source has no link to the target", () => {
    const source = node({ markdown: "no links here at all" });
    const target = node({ title: "My Note", slug: "my-note" });
    expect(findBacklinkSnippet(source, target)).toBeNull();
  });

  it("returns null for an empty body", () => {
    expect(findBacklinkSnippet(node({ markdown: "" }), node({ title: "X", slug: "x" }))).toBeNull();
  });
});

describe("findMentionSnippet (unlinked mentions)", () => {
  it("finds a plain-text mention at a word boundary", () => {
    const source = node({ markdown: "I discussed Photosynthesis in class." });
    const snip = findMentionSnippet(source, "Photosynthesis")!;
    expect(snip.text.slice(snip.linkStart, snip.linkEnd)).toBe("Photosynthesis");
  });

  it("skips an occurrence that is already a [[wikilink]]", () => {
    const source = node({ markdown: "linked [[Photosynthesis]] only" });
    expect(findMentionSnippet(source, "Photosynthesis")).toBeNull();
  });

  it("returns the FIRST unlinked mention even when a linked one precedes it", () => {
    const source = node({ markdown: "[[Cat]] then a plain Cat here" });
    const snip = findMentionSnippet(source, "Cat")!;
    // the highlighted span is the plain one, not the wikilinked one
    expect(source.markdown!.slice(0, 5)).toBe("[[Cat"); // sanity: linked one is first textually
    expect(snip.text.slice(snip.linkStart, snip.linkEnd)).toBe("Cat");
    expect(snip.linkStart).toBeGreaterThan(0);
  });

  it("does not match inside a larger word (Cat ⊄ Category)", () => {
    expect(findMentionSnippet(node({ markdown: "the Category of things" }), "Cat")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(findMentionSnippet(node({ markdown: "we love PARIS" }), "Paris")).not.toBeNull();
  });

  it("returns null for an empty body or empty title", () => {
    expect(findMentionSnippet(node({ markdown: "" }), "X")).toBeNull();
    expect(findMentionSnippet(node({ markdown: "text" }), "  ")).toBeNull();
  });
});
