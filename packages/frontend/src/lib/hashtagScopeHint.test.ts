import { describe, it, expect } from "vitest";
import { hashtagScopeHintAt, hashtagToScope } from "./hashtagScopeHint";
import { popupBlockedAt } from "./editorCompletion";
import { stateOf } from "../test/helpers/editorState";

// Code and formulas are the editor's one judgment (popupBlockedAt), as in MarkdownEditor.
const hint = (doc: string) => {
  const state = stateOf(doc);
  return hashtagScopeHintAt(doc, doc.length, (pos) => popupBlockedAt(state, pos));
};

describe("hashtagScopeHintAt", () => {
  it("fires when #word is finished by a space or a newline", () => {
    expect(hint("二分搜尋 #考點 ")).toEqual({ name: "考點", from: 5, to: 8 });
    expect(hint("#idea ")).toEqual({ name: "idea", from: 0, to: 5 });
    expect(hint("看 #考點\n")).toMatchObject({ name: "考點" });
  });

  it("waits for the word to be finished", () => {
    expect(hint("二分搜尋 #考點")).toBeNull();
    expect(hint("二分搜尋 #")).toBeNull();
  });

  it("is not a Markdown heading, an issue number or an anchor", () => {
    expect(hint("# 標題 ")).toBeNull();
    expect(hint("## 標題 ")).toBeNull();
    expect(hint("see issue #12 ")).toBeNull();
    expect(hint("https://x.test/page#frag ")).toBeNull();
  });

  it("is not inside code", () => {
    expect(hint("`#考點 ")).toBeNull();
    expect(hint("```\n#考點 ")).toBeNull();
    expect(hint("~~~js\nconst a = 1; #x ")).toBeNull();
    expect(hint("$a$ 之後 #考點 ")).not.toBeNull();
  });

  it("is not in the front matter", () => {
    expect(hint("---\ntags: x #y \n---\n\n內文")).toBeNull();
    const doc = "---\ntitle: x\n---\n\n#y ";
    expect(hint(doc)).toMatchObject({ name: "y" });
  });
});

describe("hashtagToScope", () => {
  it("moves the word to the end of its paragraph as {word}", () => {
    const typed = "二分搜尋 #考點 ";
    expect(hashtagToScope(typed, hint(typed)!)).toBe("二分搜尋 {考點} ");
  });

  it("goes at the end of the line (a `^word` there is plain text now) and joins an existing {…}", () => {
    const doc = "段落 #重要 ^k3f9";
    const found = hashtagScopeHintAt(doc, doc.indexOf("^"))!;
    expect(hashtagToScope(doc, found)).toBe("段落 ^k3f9 {重要}");
    const withBraces = "段落 {a} #b ";
    expect(hashtagToScope(withBraces, hint(withBraces)!)).toBe("段落 {a, b} ");
  });

  it("uses the last line of a multi-line paragraph and a list item's own line", () => {
    const para = "第一行\n第二行 #x ";
    expect(hashtagToScope(para, hint(para)!)).toBe("第一行\n第二行 {x} ");
    const list = "- 項目 #x \n- 下一項";
    const found = hashtagScopeHintAt(list, list.indexOf("\n"))!;
    expect(hashtagToScope(list, found)).toBe("- 項目 {x} \n- 下一項");
  });

  it("a block that is only the word becomes {word} in place", () => {
    expect(hashtagToScope("#solo ", hint("#solo ")!)).toBe("{solo} ");
  });
});
