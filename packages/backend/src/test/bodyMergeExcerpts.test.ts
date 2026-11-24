// Pins today's behaviour for docs/architecture/proposals/pdf-highlights-as-excerpts-2026-11-17.md: two devices that each
// append an excerpt block to the same note (what a PDF highlight written as an excerpt would do) both keep theirs, and
// each stays a whole excerpt a reader can parse. Pure merge, no database.
import { describe, expect, it } from "vitest";
import { appendedBody, excerptBlock, parseExcerpts, blockSpans } from "@onden/markdown";
import { threeWayMergeBody } from "../services/eventLog/bodyMerge.js";

const paper = (page: number) => ({ title: "Paper", url: `/api/media/paper.pdf#page=${page}`, feed: `p.${page}` });

describe("two devices each append an excerpt to the same note", () => {
  const base = "My own words about the paper.\n";
  const a = appendedBody(base, excerptBlock({ exact: "first passage" }, paper(2)));
  const b = appendedBody(base, excerptBlock({ exact: "second passage" }, paper(9)));

  it.each([["a then b", a, b], ["b then a", b, a]])("keeps both, cleanly (%s)", (_name, incoming, current) => {
    const merged = threeWayMergeBody(base, incoming, current);
    expect(merged.clean).toBe(true);
    expect(merged.merged).toContain("first passage");
    expect(merged.merged).toContain("second passage");
    expect(merged.merged.startsWith(base)).toBe(true);
  });

  it("leaves each one a whole excerpt (quote, blank line, linked source line) when anchored", () => {
    const { merged } = threeWayMergeBody(base, a, b);
    const quotes = blockSpans(merged).filter((s) => s.kind === "quote");
    expect(quotes).toHaveLength(2);
    const found = parseExcerpts(merged, quotes.map((s, i) => ({ id: `x${i}`, from: s.start, to: s.end })));
    expect(found.map((e) => e.exact).sort()).toEqual(["first passage", "second passage"]);
  });
});
