import { describe, expect, it } from "vitest";
import { sitePagePaths } from "./siteStatic";

describe("the static copy's page list", () => {
  it("is the home, each published note and each tag page — and nothing else", () => {
    const nodes = [{ slug: "a" }, { slug: "文章-一" }] as never;
    expect(sitePagePaths({ nodes, tagSlugs: ["花"] })).toEqual(["/site/", "/site/a/", "/site/文章-一/", "/site/tag/花/"]);
    expect(sitePagePaths({ nodes: [], tagSlugs: [] })).toEqual(["/site/"]);
  });
});
