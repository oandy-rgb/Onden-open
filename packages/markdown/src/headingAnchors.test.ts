// Heading anchors (audit D62): one rule for a heading's id, read by the
// renderer (h1–h6 ids), the published TOC and [[Note#Heading]] links.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { ondenMarkdownCore, headingAnchors, headingAnchorLines, headingFragment, BLOCK_PARSE_MAX, DOM_ID_PREFIX, type MarkdownProfile, type WikilinkTarget } from "./index.js";
import { ondenMarkdown } from "./full.js";

const fixtureDir = new URL("./fixtures/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("headingAnchors.json", fixtureDir), "utf8")) as {
  markdown: string; anchors: Array<{ depth: number; text: string; id: string }>; notHeadings: string[];
};
const note = readFileSync(new URL(fixture.markdown, fixtureDir), "utf8");

// The full pipeline (server exports, the static site); the core one (the
// app, before or without its lazy enhancers) is checked against it below.
function html(
  markdown: string, profile: MarkdownProfile = "published", wikilinkHref?: (l: WikilinkTarget) => string,
  pipeline: typeof ondenMarkdown = ondenMarkdown,
): string {
  const md = pipeline({ profile, wikilinkHref });
  return String(unified().use(remarkParse).use(md.remarkPlugins).use(remarkRehype, md.remarkRehypeOptions)
    .use(md.rehypePlugins).use(rehypeStringify).processSync(md.prepare(markdown)));
}
const headingIds = (out: string) => [...out.matchAll(/<h[1-6]\b[^>]*\sid="([^"]*)"/g)].map((m) => m[1]);

describe("headingAnchors (shared fixture)", () => {
  it("lists the headings the page shows, with Unicode ids de-duplicated", () => {
    expect(headingAnchors(note)).toEqual(fixture.anchors);
    for (const text of fixture.notHeadings) expect(headingAnchors(note).map((a) => a.text), text).not.toContain(text);
  });

  for (const profile of ["app", "published"] as const) {
    it(`the renderer (${profile}) gives every heading its anchor id, prefixed`, () => {
      const out = html(note, profile, (l) => `#wl:${l.target}`);
      expect(headingIds(out)).toEqual(fixture.anchors.map((a) => `${DOM_ID_PREFIX}${a.id}`));
    });
    it(`the core pipeline (${profile}, no enhancers) gives the same ids`, () => {
      const out = html(note, profile, (l) => `#wl:${l.target}`, (o) => ondenMarkdownCore(o));
      expect(headingIds(out)).toEqual(fixture.anchors.map((a) => `${DOM_ID_PREFIX}${a.id}`));
    });
  }
});

describe("heading anchors: the D62 bugs", () => {
  it("(1) rendered headings carry ids (they had none)", () => {
    expect(html("## Goals\n\ntext")).toContain('<h2 id="user-content-goals">Goals</h2>');
  });

  it("(2) a CJK heading has an id of its own, not an empty one", () => {
    expect(headingAnchors("## 目標")).toEqual([{ depth: 2, text: "目標", id: "目標" }]);
    expect(headingFragment("## 目標", "目標")).toBe("#user-content-目標");
  });

  it("(3) a heading-like line in a code fence is code", () => {
    expect(headingAnchors("```\n## comment\n```\n\n## Real")).toEqual([{ depth: 2, text: "Real", id: "real" }]);
  });

  it("(4) [[Note#Goals]] hands the heading to the link resolver", () => {
    const seen: WikilinkTarget[] = [];
    html("[[Plan#Goals]], [[Plan#^b1]], [[#目標]], [[Plan#A#B|x]] and [[Plan#]]", "published", (l) => { seen.push(l); return "#"; });
    expect(seen).toEqual([
      { target: "Plan", blockId: null, heading: "Goals" },
      { target: "Plan", blockId: "b1", heading: null },
      { target: "", blockId: null, heading: "目標" },
      { target: "Plan", blockId: null, heading: "B" },
      { target: "Plan", blockId: null, heading: null },
    ]);
  });
});

describe("heading ids", () => {
  it("de-duplicates as GitHub does", () => {
    expect(headingAnchors("## A\n## A\n## A\n## A-1").map((a) => a.id)).toEqual(["a", "a-1", "a-2", "a-1-1"]);
  });

  it("reads the text without the {…} marker; a `^id` is heading text; escaped or code braces stay", () => {
    expect(headingAnchors("## Plan {project}").map((a) => a.text)).toEqual(["Plan"]);
    expect(headingAnchors("## Plan {project} ^p1").map((a) => a.text)).toEqual(["Plan {project} ^p1"]);
    expect(headingAnchors("## Plan \\{x\\}").map((a) => a.text)).toEqual(["Plan {x}"]);
    expect(headingAnchors("## Plan `{x}`").map((a) => a.text)).toEqual(["Plan {x}"]);
    expect(headingAnchors("## Done ##").map((a) => a.text)).toEqual(["Done"]);
  });

  it("composes in NFC: a decomposed title has the composed one's id", () => {
    expect(headingAnchors("## Café")[0]!.id).toBe("café");
  });

  it("an in-note [link](#目標) follows the heading to its prefixed id", () => {
    expect(html("## 目標\n\n[back](#目標)")).toContain('href="#user-content-%E7%9B%AE%E6%A8%99"');
  });

  it("hidden key:: value lines are not a heading's text, as on the page", () => {
    expect(headingAnchors("due:: x\nTitle\n---")).toEqual([{ depth: 2, text: "Title", id: "title" }]);
    expect(headingAnchors("due:: x\n---")).toEqual([]);
  });

  it("frontmatter is not a heading", () => {
    expect(headingAnchors("---\ntitle: x\n---\n# T")).toEqual([{ depth: 1, text: "T", id: "t" }]);
  });
});

describe("headingFragment", () => {
  const md = "## Goals\n\n## Goals\n\n## Next step";
  it("finds a heading by its text (case-insensitive) or its id", () => {
    expect(headingFragment(md, "goals")).toBe("#user-content-goals");
    expect(headingFragment(md, "goals-1")).toBe("#user-content-goals-1");
    expect(headingFragment(md, "Next  step")).toBe("#user-content-next-step");
    expect(headingFragment(md, "next-step")).toBe("#user-content-next-step");
  });

  it("is null for a heading the note doesn't have", () => {
    expect(headingFragment(md, "Missing")).toBeNull();
    expect(headingFragment(md, " ")).toBeNull();
  });

  it("over the parse cap: no anchors listed (an empty TOC), the link falls back to the slug", () => {
    const long = "## Goals\n\n" + "x ".repeat(BLOCK_PARSE_MAX);
    expect(headingAnchors(long)).toEqual([]);
    expect(headingFragment(long, "Goals")).toBe("#user-content-goals");
    // The renderer, which parses anyway, still sets the id.
    expect(headingIds(html(long))).toEqual(["user-content-goals"]);
  });
});

describe("headingAnchorLines", () => {
  it("gives each heading's 0-based line, frontmatter included, (code fences skipped, setext headings counted)", () => {
    const md = "---\ntitle: x\n---\n# One\n\n```\n# code\n```\nSetext\n======\n\n## Two\n";
    expect(headingAnchorLines(md).map(({ anchor, line }) => [anchor.text, line])).toEqual([["One", 3], ["Setext", 8], ["Two", 11]]);
  });
});
