// Where an export's [[links]] point (D42): every output resolves a link
// against the served site's pages (@onden/markdown servedLinkTarget) and
// addresses the page by its served slug — the single-note export and the site at
// /site/<slug>. (The static copy's links are made relative by staticSite.ts.)
// A link naming no page of the site reads as plain text, as on the live site.
// A link by alias reaches the exports already rewritten to the page's served
// slug (redaction.ts linkAliasesBySlug, option 3): the pages list no aliases.
import { describe, expect, it } from "vitest";
import { md2html } from "../modules/website/publishing/htmlUtils.js";
import { buildSingleNoteHtml } from "../modules/website/publishing/singleNoteHtml.js";
import { inertUnpublishedWikilinks, linkAliasesBySlug } from "../modules/website/publishing/redaction.js";
import type { NodeRow } from "../modules/website/publishing/types.js";

const pages: NodeRow[] = [
  { id: "t1", title: "Target", slug: "target", markdown: "t" },
  // Two notes titled Plan from different spaces: the snapshot renamed one.
  { id: "p1", title: "Plan", slug: "plan", markdown: "p" },
  { id: "p2aaaa", title: "Plan", slug: "plan-p2aaaa", markdown: "p" },
  { id: "l1", title: "Links", slug: "links", markdown: "[[My Alias]], [[Plan]], [[Nowhere]] and [[Target#^b1]]" },
];
const aliases = new Map([["t1", ["My Alias"]]]);
// The pages as the snapshot stores them: [[My Alias]] rewritten (option 3).
const served: NodeRow[] = structuredClone(pages);
linkAliasesBySlug(served, aliases);

const publishedWith = (map: Map<string, string[]>) => pages.map((p) => ({ ...p, aliases: map.get(p.id) }));

describe("export [[links]] resolve against the served site", () => {
  it("bug 1: [[My Alias]] opens the note with that alias, not a page slugified from the text", () => {
    // The snapshot keeps the link (the alias names a published note) and
    // names the note by its served slug, keeping the text the reader sees.
    expect(inertUnpublishedWikilinks("see [[My Alias]]", publishedWith(aliases))).toBe("see [[My Alias]]");
    expect(served.find((p) => p.id === "l1")!.markdown).toBe("[[target|My Alias]], [[Plan]], [[Nowhere]] and [[Target#^b1]]");
    const html = md2html(served.find((p) => p.id === "l1")!.markdown, { pages: served, from: "l1" });
    expect(html).toContain('href="/site/target">My Alias</a>');
    expect(html).not.toContain("my-alias");
    // Without the rewrite the alias names no page of the site: plain text.
    expect(md2html("see [[My Alias]]", { pages, from: "l1" })).toContain("<p>see My Alias</p>");
  });

  it("bug 1: an unresolved link is its label as plain text, not a dead link", () => {
    const html = md2html("a [[Nowhere]] b", { pages, from: "l1" });
    expect(html).toContain("<p>a Nowhere b</p>");
    expect(md2html("a [[Target]] b")).toContain("<p>a Target b</p>"); // no site given
    expect(md2html("[[#^b1]]", { pages, from: "l1" })).not.toContain("<a");
  });

  it("bug 2: a link to a renamed clash points at the served slug", () => {
    expect(md2html("[[plan-p2aaaa]]", { pages })).toContain('href="/site/plan-p2aaaa"');
    expect(md2html("[[Plan]]", { pages })).toContain('href="/site/plan"');
  });

  it("the single-note export links to the site's pages, plain text where the site has none", () => {
    const html = buildSingleNoteHtml({ id: "x", title: "Draft", markdown: "[[target|My Alias]] [[Nowhere]]" }, {} as never, served);
    expect(html).toContain('href="/site/target">My Alias</a>');
    expect(html).toContain(" Nowhere</p>");
    expect(buildSingleNoteHtml({ title: "Draft", markdown: "[[Target]]" }, {} as never)).not.toContain("<a ");
  });
});
