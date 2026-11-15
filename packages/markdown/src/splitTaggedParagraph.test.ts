import { describe, it, expect } from "vitest";
import { parseBlocks, splitAnchorSpan, splitTaggedParagraph } from "./index";

// 業主 2026-11-08 規則（docs/architecture/proposals/block-anchors-2026-11-01.md §5.3）：
// 段落有 `{…}` 時 Enter 在任何位置都切成兩段；身分跟著有 `{…}` 的那一半。
const at = (text: string, marker = "|") => {
  const i = text.indexOf(marker);
  return { body: text.slice(0, i) + text.slice(i + 1), offset: i };
};
const apply = (text: string) => {
  const { body, offset } = at(text);
  const cut = splitTaggedParagraph(body, offset);
  if (!cut) return null;
  const doc = body.slice(0, cut.at) + cut.insert + body.slice(cut.at);
  return { doc, caret: cut.caret };
};

describe("splitTaggedParagraph（規則 1、8）", () => {
  it("cuts after the braces when the caret is at the end of the tagged paragraph", () => {
    const r = apply("我發現不 {複習}|")!;
    expect(r.doc).toBe("我發現不 {複習}\n\n");
    expect(r.caret).toBe(r.doc.length);
  });

  it("cuts in the middle of the text: the tag goes with the second half", () => {
    const r = apply("前半|後半 {複習}")!;
    expect(r.doc).toBe("前半\n\n後半 {複習}");
    expect(r.caret).toBe("前半\n\n".length);
  });

  it("cuts at the start of the paragraph: an empty first half, the tagged text stays whole", () => {
    expect(apply("|文字 {複習}")!.doc).toBe("\n\n文字 {複習}");
  });

  it("cuts at the end of an earlier line without leaving two blank lines", () => {
    const r = apply("第一行|\n第二行 {複習}")!;
    expect(r.doc).toBe("第一行\n\n第二行 {複習}");
    expect(r.caret).toBe("第一行\n\n".length);
  });

  it("a caret inside the braces cuts after the `}`: the tag is never split", () => {
    for (const text of ["文字 {複|習}", "文字 {|複習}", "文字 {複習|}"]) {
      expect(apply(text)!.doc, text).toBe("文字 {複習}\n\n");
    }
  });

  it("with several tags in the braces the cut is still after the last `}` of the tag", () => {
    expect(apply("文字 {複習, 考|點}")!.doc).toBe("文字 {複習, 考點}\n\n");
  });

  it("a caret after the braces (trailing blanks) cuts at the end of the tag line", () => {
    expect(apply("文字 {複習}|  ")!.doc).toBe("文字 {複習}  \n\n");
  });

  it("works on a later paragraph and keeps the paragraphs around it", () => {
    const r = apply("別段\n\n前|後 {複習}\n\n下一段")!;
    expect(r.doc).toBe("別段\n\n前\n\n後 {複習}\n\n下一段");
  });

  it("is not for an untagged paragraph, a quote, a list item, a heading, code or an escaped tag", () => {
    for (const text of [
      "沒有標籤的段落|", "沒有|標籤", "> 引用 {複習}|", "- 清單 {複習}|", "## 標題 {複習}|",
      "```\ncode {x}|\n```", "  縮排 {複習}|", "文字 \\{複習\\}|", "前面 {複習} 後|面",
    ]) {
      expect(apply(text), text).toBeNull();
    }
  });

  it("a tag that is not on the paragraph's last line is plain text: Enter is not ours", () => {
    expect(apply("第一行| {複習}\n第二行")).toBeNull();
  });
});

describe("splitAnchorSpan（規則 2、3、8：身分在哪一半）", () => {
  const owner = (before: string, after: string) => {
    const r = splitAnchorSpan(before, after);
    return r ? after.slice(r.from, r.to) : null;
  };

  it("the tag in the second half: the identity moves to the second half", () => {
    expect(owner("前半後半 {複習}", "前半\n\n後半 {複習}")).toBe("後半 {複習}");
  });

  it("the tag in the first half (caret after it): the identity stays in the first half", () => {
    expect(owner("文字 {複習}", "文字 {複習}\n\n")).toBe("文字 {複習}");
    expect(owner("文字 {複習}", "文字 {複習}\n\n新的")).toBe("文字 {複習}");
  });

  it("no tag at all (§5.3): the identity stays in the first half", () => {
    expect(owner("前半後半", "前半\n\n後半")).toBe("前半");
  });

  it("an empty first half: the anchor is the tagged paragraph, without the blank lines", () => {
    expect(owner("文字 {複習}", "\n\n文字 {複習}")).toBe("文字 {複習}");
  });

  it("tags in both halves: the identity follows the first tag", () => {
    expect(owner("a {x}\nb {y}", "a {x}\n\nb {y}")).toBe("a {x}");
  });

  it("a span that already held a paragraph break is a deliberate multi-paragraph anchor", () => {
    expect(owner("一\n\n二 {複習}", "一\n\n二 {複習}\n\n三")).toBeNull();
  });

  it("is null when nothing was cut, and for blocks that are not plain paragraphs", () => {
    expect(owner("文字 {複習}", "文字 {複習} 加字")).toBeNull();
    expect(owner("- 項目 {複習}", "- 項目 {複習}\n\n- 另一個")).toBeNull();
    expect(owner("## 標題", "## 標題\n\n內文")).toBeNull();
  });

  it("agrees with parseBlocks: the half the rule picks is the block that has the tag", () => {
    const after = "前半\n\n後半 {複習}";
    const r = splitAnchorSpan("前半後半 {複習}", after)!;
    const tagged = parseBlocks(after).filter((b) => b.tags.includes("複習"));
    expect(tagged).toHaveLength(1);
    expect(tagged[0]!.start).toBe(r.from);
  });
});
