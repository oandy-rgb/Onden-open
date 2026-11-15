import { describe, expect, it } from "vitest";
import { aliasLinksBySlug, servedLinkTarget, sitePathFor } from "./sitePath.js";
import { drawnWikilinks } from "./wikilinkSpans.js";

const served = [
  { id: "a", title: "Plan", slug: "plan" },
  { id: "b", title: "Plan", slug: "plan-b00000" },
  { id: "c", title: "Target", slug: "target", aliases: ["My Alias"] },
];

describe("sitePathFor", () => {
  it("is the served slug by id, null when the site does not serve the note", () => {
    expect(sitePathFor("b", served)).toBe("/site/plan-b00000");
    expect(sitePathFor("missing", served)).toBeNull();
  });
});

describe("servedLinkTarget", () => {
  it("names a page by title, slug or alias; nothing for an unknown or same-page link", () => {
    expect(servedLinkTarget("my alias|shown", served)?.id).toBe("c");
    expect(servedLinkTarget("plan-b00000", served)?.id).toBe("b");
    expect(servedLinkTarget("Target#^x1", served)?.id).toBe("c");
    expect(servedLinkTarget("Nowhere", served)).toBeNull();
    expect(servedLinkTarget("#^x1", served)).toBeNull();
  });
  it("takes the first match, the linking page itself last", () => {
    expect(servedLinkTarget("Plan", served, "a")?.id).toBe("b");
    expect(servedLinkTarget("Target", served, "c")?.id).toBe("c");
  });
});

describe("aliasLinksBySlug", () => {
  const rewrite = aliasLinksBySlug([
    ...served,
    { id: "d", title: "Guide", slug: "guide-d00000", aliases: ["Handbook", "手冊"] },
  ]);

  it("names the page by its served slug, keeping what the reader sees", () => {
    expect(rewrite("see [[My Alias]] and [[手冊]]", "a")).toBe("see [[target|My Alias]] and [[guide-d00000|手冊]]");
    expect(rewrite("[[my alias|the target]]")).toBe("[[target|the target]]");
    expect(rewrite("[[Handbook#Setup]] [[Handbook#Setup|setup]]")).toBe("[[guide-d00000#Setup|Handbook#Setup]] [[guide-d00000#Setup|setup]]");
    expect(rewrite("[[Handbook#^b1]] [[Handbook#^b1|that block]]")).toBe("[[guide-d00000#^b1|Handbook]] [[guide-d00000#^b1|that block]]");
  });

  it("leaves a link by title or slug, to no page, or in code and math, as written", () => {
    const text = "[[Target]] [[plan-b00000]] [[Nowhere]] `[[My Alias]]` $[[My Alias]]$\n\n```\n[[My Alias]]\n```\n";
    expect(rewrite(text)).toBe(text);
  });

  it("the rewritten link opens the same page without the alias list", () => {
    const bare = served.map(({ aliases: _a, ...p }) => p);
    const [link] = drawnWikilinks(rewrite("[[My Alias#^x1]]"));
    expect(servedLinkTarget(link!.body, bare)?.id).toBe("c");
  });

  it("keeps the frontmatter and finds links after it", () => {
    expect(rewrite("---\ntitle: x\n---\n[[My Alias]]")).toBe("---\ntitle: x\n---\n[[target|My Alias]]");
  });

  it("is the identity when no page has an alias", () => {
    expect(aliasLinksBySlug([{ id: "a", title: "A", slug: "a" }])("[[x]]")).toBe("[[x]]");
  });
});
