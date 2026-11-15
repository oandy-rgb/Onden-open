import { describe, expect, it } from "vitest";
import { excerptParts, hitHref, indexFolder, markTypedText, siteRoot } from "./siteSearch";

describe("site search addresses", () => {
  it("the index folder gets a trailing slash, and the root is two folders up", () => {
    expect(indexFolder("https://x.test/site/search.idx")).toBe("https://x.test/site/search.idx/");
    expect(indexFolder("https://x.test/site/search.idx/")).toBe("https://x.test/site/search.idx/");
    expect(siteRoot("https://x.test/site/search.idx/")).toBe("https://x.test/");
    expect(siteRoot("https://me.github.io/garden/site/search.idx/")).toBe("https://me.github.io/garden/");
  });

  it("a result opens inside the copy, under a Pages subpath too", () => {
    expect(hitHref("https://x.test/", "/site/a/")).toBe("https://x.test/site/a/");
    expect(hitHref("https://me.github.io/garden/", "/site/a/")).toBe("https://me.github.io/garden/site/a/");
    expect(hitHref("https://x.test/", "/site/%E6%96%87/")).toBe("https://x.test/site/%E6%96%87/");
  });
});

describe("excerptParts", () => {
  it("marks the matches and never keeps markup", () => {
    expect(excerptParts("學習了<mark>資料結構</mark>與&lt;b&gt;演算法")).toEqual([
      { text: "學習了", mark: false }, { text: "資料結構", mark: true }, { text: "與<b>演算法", mark: false },
    ]);
    expect(excerptParts("")).toEqual([]);
  });
});

describe("markTypedText", () => {
  it("marks the phrase that was typed where Pagefind marked single characters", () => {
    const parts = excerptParts("今天學習了<mark>資</mark>料<mark>結</mark>構與演算法");
    expect(markTypedText(parts, "資料結構")).toEqual([
      { text: "今天學習了", mark: false }, { text: "資料結構", mark: true }, { text: "與演算法", mark: false },
    ]);
  });

  it("is case-insensitive, and keeps Pagefind's marks when the phrase is not there as typed", () => {
    expect(markTypedText([{ text: "Tomatoes grow", mark: false }], "TOMATO")).toEqual([
      { text: "Tomato", mark: true }, { text: "es grow", mark: false },
    ]);
    const stemmed = excerptParts("<mark>grows</mark> tall");
    expect(markTypedText(stemmed, "grow tall")).toBe(stemmed);
    expect(markTypedText(stemmed, "  ")).toBe(stemmed);
  });
});
