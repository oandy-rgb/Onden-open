import { describe, expect, it } from "vitest";
import { blockCitations } from "../index";

const alpha = { title: "Alpha", slug: "alpha", aliases: ["First"] };

describe("blockCitations", () => {
  it("finds links and embeds that name a paragraph of the note", () => {
    const md = "看 [[Alpha#^p1]] 和\n\n![[Alpha#^p1]]\n\n以及 [[alpha#^q2|別名]]";
    expect(blockCitations(md, alpha).map((c) => c.blockId)).toEqual(["p1", "p1", "q2"]);
  });

  it("matches by slug and alias, case-insensitively", () => {
    expect(blockCitations("[[First#^a1]] [[ALPHA#^a2]]", alpha).map((c) => c.blockId)).toEqual(["a1", "a2"]);
  });

  it("skips links to other notes, headings and the whole note", () => {
    expect(blockCitations("[[Beta#^p1]] [[Alpha#Heading]] [[Alpha]] [[#^p1]]", alpha)).toEqual([]);
  });

  it("reports where each citation starts", () => {
    const md = "x [[Alpha#^p1]]";
    expect(blockCitations(md, alpha)).toEqual([{ blockId: "p1", start: 2 }]);
  });

  it("is cheap for text with no block links", () => {
    expect(blockCitations("沒有任何連結", alpha)).toEqual([]);
  });
});
