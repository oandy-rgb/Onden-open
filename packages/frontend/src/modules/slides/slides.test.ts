import { describe, expect, it } from "vitest";
import { parseDeck } from "./slides";

describe("parseDeck", () => {
  it("splits on lines that are only ---, ignoring frontmatter and code fences", () => {
    const deck = parseDeck("---\ntitle: x\n---\n## One\n- a\n\n---\n\n## Two\n```\n---\n```\n");
    expect(deck.slides.map((s) => s.markdown)).toEqual(["## One\n- a", "## Two\n```\n---\n```"]);
  });

  it("a fence closes only on its own marker: ``` inside ~~~ (and a --- there) stays text", () => {
    const deck = parseDeck("## One\n~~~\n```\n---\n```\n~~~\n\n---\n\n## Two");
    expect(deck.slides.map((s) => s.markdown)).toEqual(["## One\n~~~\n```\n---\n```\n~~~", "## Two"]);
  });

  it("--- right under a paragraph line is its heading underline, not a break; under a list or blank line it breaks", () => {
    expect(parseDeck("Title\n---\nbody").slides).toHaveLength(1);
    expect(parseDeck("## A\n- point\n---\n## B").slides.map((s) => s.markdown)).toEqual(["## A\n- point", "## B"]);
    expect(parseDeck("## A\ntext\n\n---\n\n## B").slides).toHaveLength(2);
  });

  it("without --- splits at ## headings, keeping an intro before the first", () => {
    const deck = parseDeck("Intro\n\n## A\nx\n### sub\n## B\ny");
    expect(deck.slides.map((s) => s.markdown)).toEqual(["Intro", "## A\nx\n### sub", "## B\ny"]);
  });

  it("a plain note is one slide; an empty one still has a slide", () => {
    expect(parseDeck("Just text").slides).toHaveLength(1);
    expect(parseDeck("").slides).toEqual([{ markdown: "", cites: [] }]);
  });

  it("a last part of [n] lines is the source list: not a slide, and each slide names what it cites", () => {
    const deck = parseDeck("## A\nClaim [1] and [2]\n\n---\n\n## B\nOnly [2], a [link](x) and [3]\n\n---\n\n## Sources\n\n[1] [[ch-1|Chapter one]]\n[2] Plain title\n");
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[0].cites).toEqual([
      { n: 1, label: "Chapter one", target: "ch-1" }, { n: 2, label: "Plain title", target: null },
    ]);
    expect(deck.slides[1].cites.map((s) => s.n)).toEqual([2]);
  });

  it("a last slide with other text stays a slide", () => {
    const deck = parseDeck("## A\nx\n\n---\n\n## End\n[1] [[a]]\nThanks");
    expect(deck.slides).toHaveLength(2);
    expect(deck.sources).toEqual([]);
  });

  it("reads a numbered source list at the end of a deck back as each slide's cites", () => {
    const deck = parseDeck("## A\nSee [1] [2]\n\n---\n\n## Sources\n\n[1] [[ch-1|Chapter one]]\n[2] [[Same]]\n");
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0].cites).toEqual([
      { n: 1, label: "Chapter one", target: "ch-1" }, { n: 2, label: "Same", target: "Same" },
    ]);
  });
});
