import { describe, it, expect } from "vitest";
import { splitParagraphs, alignParagraphs, matchParagraphs, findParagraph, paragraphOccurrence, paragraphSample as sample, summarizeChange, sameTextIgnoringIds } from "./paragraphs.js";

const texts = (md: string) => splitParagraphs(md).map((p) => p.text);

describe("splitParagraphs", () => {
  it("cuts on blank lines; a heading, each list item and each task is its own paragraph", () => {
    expect(texts("# 標題\n\n第一段\n接續\n\n- 甲\n- 乙\n  續\n- [ ] 任務\n\n最後")).toEqual(["# 標題", "第一段\n接續", "- 甲", "- 乙\n  續", "- [ ] 任務", "最後"]);
  });
  it("ranges point into the source; CRLF reads like LF", () => {
    const md = "# A\r\n\r\n段落一\r\n接續\r\n\r\n- x";
    for (const p of splitParagraphs(md)) expect(md.slice(p.start, p.end)).toBe(p.text);
    expect(splitParagraphs(md).map((p) => p.norm)).toEqual(splitParagraphs("# A\n\n段落一\n接續\n\n- x").map((p) => p.norm));
    expect(splitParagraphs("")).toEqual([]);
    expect(splitParagraphs("\n\n  \n")).toEqual([]);
  });
  it("a code fence is one paragraph even with blank lines", () => {
    expect(texts("前\n\n```ts\na\n\nb\n```\n\n後")).toEqual(["前", "```ts\na\n\nb\n```", "後"]);
  });
  it("a quote is cut from the text before it, and holds its lines", () => {
    expect(texts("text\n> q\n> r\nafter")).toEqual(["text", "> q\n> r", "after"]);
  });
  it("the frontmatter block is one paragraph", () => {
    const ps = splitParagraphs("---\ntitle: x\n\nk: v\n---\n\n正文");
    expect(ps.map((p) => p.kind)).toEqual(["frontmatter", "text"]);
    expect(ps[0]!.text).toBe("---\ntitle: x\n\nk: v\n---");
  });
  describe("^id (blockId.ts's grammar)", () => {
    it("is read at the end of the last line, before a trailing space too", () => {
      const ps = splitParagraphs("內容 ^abc1\n\n- 項目 ^ghi3 ");
      expect(ps.map((p) => p.blockId)).toEqual(["abc1", "ghi3"]);
      expect(ps[0]!.body).toBe("內容");
      expect(ps[0]!.text).toBe("內容 ^abc1");
    });
    it("a caret glued to a word is not an id", () => {
      expect(splitParagraphs("x^abc")[0]!.blockId).toBeNull();
    });
    it("an id alone on a line belongs to the paragraph above it, with or without a blank line between", () => {
      const ps = splitParagraphs("另一段\n^def2\n\n> 引用\n\n^q1\n\n後");
      expect(ps.map((p) => p.blockId)).toEqual(["def2", "q1", null]);
      expect(ps.map((p) => p.body)).toEqual(["另一段", "> 引用", "後"]);
      expect(ps[1]!.norm).toBe("> 引用\n^q1");
    });
    it("a longer id than BLOCK_ID_MAX is not an id", () => {
      expect(splitParagraphs(`x ^${"a".repeat(65)}`)[0]!.blockId).toBeNull();
    });
  });
  describe("headings", () => {
    it("are `#`×1–6 then a space (up to 3 spaces of indent); `#tag` and 4 spaces are not", () => {
      expect(splitParagraphs("# a\n\n   ## b\n\n#tag\n\n    # code\n\n####### seven").map((p) => p.kind))
        .toEqual(["heading", "heading", "text", "text", "text"]);
    });
    it("give their paragraphs a section; closing #s and a ^id are not part of it", () => {
      const ps = splitParagraphs("序\n\n# 待辦 ^h1\n\n- a\n\n## 細項 ##\n\n- b");
      expect(ps.map((p) => p.section)).toEqual([null, "待辦", "待辦", "細項", "細項"]);
      expect(ps[1]!.blockId).toBe("h1");
    });
  });
});

describe("alignParagraphs / summarizeChange", () => {
  it("whitespace differences are no change", () => {
    expect(summarizeChange("# A\n\n內容  一\n", "# A\r\n\r\n內容 一")).toEqual({ added: 0, changed: 0, removed: 0, sections: [] });
  });
  it("counts paragraphs: added, changed in place, removed", () => {
    expect(summarizeChange("# A\n\n- x\n- y\n\n# B\n\nz", "# A\n\n- x\n\n# B\n\nz")).toEqual({ added: 0, changed: 0, removed: 1, sections: ["A"] });
    expect(summarizeChange("# T\n\n- [ ] 寫報告", "# T\n\n- [x] 寫報告")).toEqual({ added: 0, changed: 1, removed: 0, sections: ["T"] });
    expect(summarizeChange("a", "a\n\nb")).toEqual({ added: 1, changed: 0, removed: 0, sections: [] });
  });
  it("a paragraph that only moved is not a change", () => {
    expect(summarizeChange("一\n\n二\n\n三", "三\n\n一\n\n二")).toMatchObject({ added: 0, changed: 0, removed: 0 });
  });
  it("a ^id pairs a rewritten paragraph; two different ids never pair", () => {
    expect(summarizeChange("# H\n\n完全不同的舊句子 ^k1", "# H\n\n這是徹底重寫過的新內容 ^k1")).toMatchObject({ added: 0, changed: 1, removed: 0 });
    expect(summarizeChange("same words here ^a1", "same words here! ^b2")).toMatchObject({ added: 1, changed: 0, removed: 1 });
  });
  it("keeps at most three sections, first touched first", () => {
    const older = "# A\n\na\n\n# B\n\nb\n\n# C\n\nc\n\n# D\n\nd";
    const newer = "# A\n\na1\n\n# B\n\nb1\n\n# C\n\nc1\n\n# D\n\nd1";
    expect(summarizeChange(older, newer).sections).toEqual(["A", "B", "C"]);
  });
  it("reads in the new order, a removed paragraph right after the one before it", () => {
    const rows = alignParagraphs("keep one\n\ngone here\n\nkeep two", "keep one\n\nkeep two\n\nbrand new");
    expect(rows.map((r) => r.kind)).toEqual(["same", "removed", "same", "added"]);
  });
  it("matchParagraphs: for each new paragraph, which old one (or -1)", () => {
    const prev = splitParagraphs("a\n\nb\n\nc");
    const next = splitParagraphs("c\n\nz new thing\n\na");
    expect(matchParagraphs(prev, next)).toEqual([2, -1, 0]);
  });
});

describe("paragraphSample (120 characters)", () => {
  it("shows inline Markdown as plain words", () => {
    expect(sample("A `#tag` in Onden isn't just a label — it's a **capability you grant**.", 120)).toBe("A #tag in Onden isn't just a label — it's a capability you grant.");
    expect(sample("see [[筆記甲|甲]] and [[筆記乙]] and [site](https://x.y) and ~~old~~ ==hi== *it* _it_", 120)).toBe("see 甲 and 筆記乙 and site and old hi it it");
    expect(sample("2*3*4 and snake_case_name stay", 120)).toBe("2*3*4 and snake_case_name stay");
    expect(sample("```js\nconst a = 1;\n```", 120)).toBe("const a = 1;");
  });
  it("去掉標題／清單／任務框／引用記號與結尾的 ^id", () => {
    expect(sample("## 待辦 ^h1", 120)).toBe("待辦");
    expect(sample("- [x] 買牛奶 ^t1", 120)).toBe("買牛奶");
    expect(sample("12. 第十二項", 120)).toBe("第十二項");
    expect(sample("> 引用的話", 120)).toBe("引用的話");
    expect(sample("- > 清單裡的引用", 120)).toBe("清單裡的引用");
  });

  it("多行段落併成一行；超過 120 字用「…」截斷（總長 120）", () => {
    expect(sample("第一行\n第二行", 120)).toBe("第一行 第二行");
    const long = sample("字".repeat(300), 120)!;
    expect([...long]).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
    expect(sample("字".repeat(120), 120)).toBe("字".repeat(120));
  });

  it("沒有可顯示的文字時為 null", () => {
    expect(sample("##", 120)).toBeNull();
    expect(sample("- [ ]", 120)).toBeNull();
    expect(sample("^abc", 120)).toBeNull();
  });
});

describe("findParagraph / paragraphOccurrence", () => {
  const md = "same\n\nother\n\nsame\n";
  const ps = splitParagraphs(md);
  it("finds the n-th identical paragraph and counts the ones before", () => {
    expect(findParagraph(ps, "same", 0)).toBe(0);
    expect(findParagraph(ps, "same", 1)).toBe(2);
    expect(findParagraph(ps, "same", 2)).toBe(-1);
    expect(findParagraph(ps, "nope", 0)).toBe(-1);
    expect(ps.map((_, i) => paragraphOccurrence(ps, i))).toEqual([0, 0, 1]);
  });
});

describe("sameTextIgnoringIds", () => {
  it("ignores an id at the end of a paragraph, trailing spaces and the blank lines between paragraphs", () => {
    expect(sameTextIgnoringIds("hello world\n\nsecond", "hello world ^abc123\n\nsecond")).toBe(true);
    expect(sameTextIgnoringIds("- a {t}\n- b", "- a {t} ^aa11bb\n- b ^cc22dd")).toBe(true);
    expect(sameTextIgnoringIds("a  \nb\n\nc", "a\nb\n\n\n\nc\n")).toBe(true);
  });
  it("counts words, indentation and structure", () => {
    expect(sameTextIgnoringIds("hello world", "hello  world")).toBe(false);
    expect(sameTextIgnoringIds("- a\n  - b", "- a\n- b")).toBe(false);
    expect(sameTextIgnoringIds("a\n\nb", "a")).toBe(false);
    expect(sameTextIgnoringIds("a ^x1", "b ^x1")).toBe(false);
  });
});
