// @vitest-environment node
// Guard: an excerpt (a quote with its source link and ^id) is written and read in
// one place — @onden/markdown excerpt.ts — so RSS today and PDF highlights later
// cannot drift into two formats. The app only calls it (docs/architecture/excerpts.md).
import { describe, expect, it } from "vitest";
import { findUses, sourceFiles } from "./sources";

const files = sourceFiles(".");

describe("excerpts have one format", () => {
  it("nothing in the app writes a Text Fragment or a quote's source line itself", () => {
    expect(findUses(files, /#:~:text=/)).toEqual([]);
    expect(findUses(files, /`— \[\$\{|— \[\$\{/)).toEqual([]);
  });

  it("nothing in the app defines its own blockquote writer or excerpt reader", () => {
    expect(findUses(files, /function\s+(blockquote|parseExcerpts?|textFragment)\b/)).toEqual([]);
  });

  it("the embed that shows an excerpt is written in one place", () => {
    expect(findUses(files, /!\[\[\$\{[^}]*\}#\^/, ["modules/rss/rssQuote.ts"])).toEqual([]);
  });
});
