import { describe, expect, it } from "vitest";
import { LAYOUT_IDS, autoLayoutOf, pagesOf, partsOf } from "./pages";

const one = (markdown: string, index = 1) => {
  const { parts } = partsOf(markdown, index);
  return autoLayoutOf(parts, index);
};

describe("cutting a note into pages", () => {
  it("cuts on --- first, else on ##, else it is one page", () => {
    expect(pagesOf("## A\nx\n\n---\n\n## B\ny").map((p) => p.parts.heading)).toEqual(["A", "B"]);
    expect(pagesOf("# Top\n\n## A\n- a\n\n## B\n- b").map((p) => p.parts.heading)).toEqual(["Top", "A", "B"]);
    expect(pagesOf("- just\n- a list")).toHaveLength(1);
    expect(pagesOf("")).toHaveLength(1);
  });

  it("keeps the [n] sources of a page and drops the source list as a page", () => {
    const pages = pagesOf("## A\n- point [1]\n\n---\n\n## Sources\n\n[1] [[ch|Chapter]]");
    expect(pages).toHaveLength(1);
    expect(pages[0].cites.map((c) => c.n)).toEqual([1]);
  });
});

describe("what is on the slide and what is for the speaker", () => {
  it("makes paragraphs the speaker's notes when the page shows anything else", () => {
    const { parts, notes } = partsOf("## Plan\n\nSay this first.\n\n- one\n- two\n\nThen this.", 1);
    expect(parts.body.map((b) => b.kind)).toEqual(["list"]);
    expect(notes).toBe("Say this first.\n\nThen this.");
    expect(parts.statement).toBeNull();
  });

  it("a page whose only text is one short paragraph is a big-line page, and keeps its heading as a label", () => {
    const { parts, notes } = partsOf("## Why\n\nBecause it is ours.", 2);
    expect(parts.statement).toBe("Because it is ours.");
    expect(parts.heading).toBe("Why");
    expect(notes).toBe("");
    expect(autoLayoutOf(parts, 2)).toBe("section");
  });

  it("a long single paragraph is not a slogan: it stays as a line under the heading", () => {
    const long = "這是一個很長的段落，".repeat(12);
    const { parts } = partsOf(`## T\n\n${long}`, 2);
    expect(parts.statement).toBeNull();
    expect(parts.subtitle).toBe(long);
  });

  it("a heading and an article: a first paragraph too long for a subtitle is the slide's text, laid out as text", () => {
    const long = "這是一個很長的段落，".repeat(20);
    const { parts, notes } = partsOf(`## T\n\n${long}\n\nSecond.`, 2);
    expect(parts.subtitle).toBeNull();
    expect(parts.body.map((b) => b.markdown)).toEqual([long]);
    expect(notes).toBe("Second.");
    expect(autoLayoutOf(parts, 2)).toBe("text");
    // also on the first page, which would otherwise be a cover
    expect(autoLayoutOf(partsOf(`# T\n\n${long}`, 0).parts, 0)).toBe("text");
  });

  it("with several paragraphs and nothing else, the first stays on the slide and the rest are notes", () => {
    const { parts, notes } = partsOf("## T\n\nFirst.\n\nSecond.\n\nThird.", 1);
    expect(parts.subtitle).toBe("First.");
    expect(notes).toBe("Second.\n\nThird.");
  });

  it("the first page with a heading and one line is a cover, not a slogan", () => {
    const { parts } = partsOf("# My talk\n\nA subtitle", 0);
    expect(parts.statement).toBeNull();
    expect(parts.subtitle).toBe("A subtitle");
    expect(autoLayoutOf(parts, 0)).toBe("cover");
  });
});

describe("the layout a page's content asks for", () => {
  it("picks by the shape of the content", () => {
    expect(one("## Only a title", 0)).toBe("cover");
    expect(one("## Only a title", 3)).toBe("section");
    expect(one("## Q\n\n> Make it work, make it right.\n\n> — Kent")).toBe("quote");
    expect(one("## Pic\n\n![a](x.png)")).toBe("fullImage");
    expect(one("## Pic\n\n![a](x.png)\n\n- caption point")).toBe("media");
    expect(one("## Code\n\n```ts\nconst a = 1;\n```")).toBe("codeMath");
    expect(one("## Math\n\n$$\nE = mc^2\n$$")).toBe("codeMath");
    expect(one("## Numbers\n\n- 90% of users stay\n- 3x faster builds")).toBe("stat");
    expect(one("## Roadmap\n\n- 2024 start\n- 2025 grow\n- 2026 ship")).toBe("timeline");
    expect(one("## Three\n\n- Fast\n- Cheap\n- Good")).toBe("three");
    expect(one("## Two sides\n\n### Pros\n- a\n- b\n\n### Cons\n- c\n- d")).toBe("compare");
    expect(one("## List\n\n- alpha item\n- beta item\n- gamma item\n- delta item")).toBe("bullets");
    expect(one("## Prose\n\n```\n```\n")).toBe("codeMath");
    expect(one("## Table\n\n| a | b |\n| - | - |\n| 1 | 2 |")).toBe("text");
  });

  it("only names layouts the registry has", () => {
    expect(new Set(LAYOUT_IDS).size).toBe(12);
  });
});

describe("the page key finds a page's chosen layout again", () => {
  const keys = (md: string) => pagesOf(md).map((p) => p.key);

  it("is the heading's words, lower-cased and without marks", () => {
    expect(keys("## **Hello**  World\n- a")).toEqual(["h:hello world"]);
  });

  it("is the heading's anchor id when an anchor starts at it, so it survives a changed title", () => {
    const keyed = (md: string, anchors: Array<{ id: string; from: number; to: number }>) => pagesOf(md, anchors).map((p) => p.key);
    expect(keyed("## First title\n- a", [{ id: "abc-1", from: 0, to: 14 }])).toEqual(["^abc-1"]);
    expect(keyed("## A totally new title\n- a", [{ id: "abc-1", from: 0, to: 22 }])).toEqual(["^abc-1"]);
  });

  it("finds each page's heading by place: the second page's anchor, with a first page before it", () => {
    const md = "## One\n- a\n\n---\n\n## Two\n- b";
    const at = md.indexOf("## Two");
    expect(pagesOf(md, [{ id: "two-id", from: at, to: at + 6 }]).map((p) => p.key)).toEqual(["h:one", "^two-id"]);
  });

  it("an anchor that does not start at the heading names nothing (the words key the page)", () => {
    expect(pagesOf("## Plan\n- a", [{ id: "x", from: 3, to: 7 }]).map((p) => p.key)).toEqual(["h:plan"]);
  });

  it("does not change when the page's body changes", () => {
    expect(keys("## Plan\n- a\n- b")).toEqual(keys("## Plan\n- a\n- b\n- c\n\nsome speaker words"));
  });

  it("changes when the heading changes and no anchor starts at it (the stated limit)", () => {
    expect(keys("## Plan\n- a")).not.toEqual(keys("## Plans\n- a"));
  });

  it("falls back to the first words of the page, then to its place", () => {
    expect(keys("Just some words here\n\n---\n\n- list only")).toEqual(["p:just some words here", "p:list only"]);
    expect(pagesOf("---\n\n![x](a.png)\n\n---\n\n![y](b.png)").map((p) => p.key)[0]).toMatch(/^(p|n):/);
  });

  it("numbers pages that would share a key, in order", () => {
    expect(keys("## Same\n- a\n\n---\n\n## Same\n- b\n\n---\n\n## Same\n- c")).toEqual(["h:same", "h:same~2", "h:same~3"]);
  });
});

describe("embeds and tasks stay on the slide", () => {
  it("a whole-line embed is drawn beside the words, not moved to the speaker's notes", () => {
    for (const embed of ["![[手寫]]", "![[Another note]]", "![[Tasks#Today]]"]) {
      const { parts, notes } = partsOf(`## T\n\n${embed}`, 1);
      expect(parts.body.map((b) => b.kind)).toEqual(["embed"]);
      expect(notes).toBe("");
      expect(autoLayoutOf(parts, 1)).toBe("media");
    }
  });

  it("several pictures in one line are a picture slide, not notes", () => {
    const { parts, notes } = partsOf("## T\n\n![a](a.png) ![b](b.png)", 1);
    expect(parts.body.map((b) => b.kind)).toEqual(["image"]);
    expect(notes).toBe("");
    expect(autoLayoutOf(parts, 1)).toBe("fullImage");
  });

  it("task lines are a list on the slide, and number or step layouts read them without the box", () => {
    expect(one("## T\n- [ ] buy\n- [x] sell")).toBe("bullets");
    expect(one("## T\n- [ ] **90%** stay\n- [ ] 3x faster")).toBe("stat");
  });
});
