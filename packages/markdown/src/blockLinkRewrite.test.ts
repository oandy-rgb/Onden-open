import { describe, expect, it } from "vitest";
import { oldPartLinkIds, oldPartLinkWords, restorePartLinks, writePartLinks } from "./blockLinkRewrite.js";

describe("writePartLinks", () => {
  it("writes `[[筆記#^id]]` as `[[筆記/words]]`, keeps the alias and the embed", () => {
    const out = writePartLinks("見 [[算法#^ab1|那段]] 與 ![[算法#^ab1]]。", ({ note, id }) => (id === "ab1" ? { note, words: "二分搜尋" } : null));
    expect(out).toEqual({ markdown: "見 [[算法/二分搜尋|那段]] 與 ![[算法/二分搜尋]]。", count: 2 });
  });
  it("a link to the note it is written in becomes `[[/words]]`", () => {
    expect(writePartLinks("[[#^c1]]", () => ({ note: "", words: "本篇" })).markdown).toBe("[[/本篇]]");
  });
  it("leaves what decide does not name, heading links, and links in code", () => {
    const text = "[[A#^x1]] [[A#標題]] [[A]] `[[A#^x1]]`";
    expect(writePartLinks(text, ({ id }) => (id === "none" ? { note: "A", words: "w" } : null))).toEqual({ markdown: text, count: 0 });
    expect(writePartLinks(text, () => ({ note: "A", words: "w" })).markdown).toBe("[[A/w]] [[A#標題]] [[A]] `[[A#^x1]]`");
  });
  it("is idempotent: a rewritten link has no `#^` left to find", () => {
    const once = writePartLinks("[[A#^x1]]", () => ({ note: "A", words: "w" })).markdown;
    expect(writePartLinks(once, () => ({ note: "A", words: "other" })).count).toBe(0);
  });
});

describe("oldPartLinkIds", () => {
  it("lists the ids in order, links and embeds", () => {
    expect(oldPartLinkIds("[[A#^a1]] ![[B#^b2|x]] [[C#head]] [[D/文字]]")).toEqual(["a1", "b2"]);
  });
});

describe("restorePartLinks", () => {
  it("writes the bound part links back as `[[筆記#^id]]`, others stay", () => {
    const bound = new Map([["算法/二分搜尋", { note: "算法", id: "ab1" }]]);
    const out = restorePartLinks("[[算法/二分搜尋|那段]] ![[算法/二分搜尋]] [[資料夾/某篇]] [[/本篇]]", (target) => bound.get(target) ?? null);
    expect(out).toEqual({ markdown: "[[算法#^ab1|那段]] ![[算法#^ab1]] [[資料夾/某篇]] [[/本篇]]", count: 2 });
  });
});

describe("oldPartLinkWords", () => {
  it("drops the marks that would read as an anchor", () => {
    expect(oldPartLinkWords("寫 #標籤 與 ^id")).toBe("寫 標籤 與 id");
  });
});
