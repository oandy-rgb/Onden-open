import { describe, expect, it } from "vitest";
import { AI_MENTION_ALIAS, findMentions, isMentionHandle, parseMention } from "./mentions.js";

describe("findMentions", () => {
  it("reads the free text after the handle to the end of the block; the block's id is the anchor that starts it", () => {
    const md = "前言\n\n看這個 @claude 幫我整理\n這段內容\n\n下一段";
    const [m] = findMentions(md, [{ id: "s7k2", from: md.indexOf("看這個") }]);
    expect(m).toMatchObject({ handle: "claude", blockId: "s7k2", leadIn: "看這個", prompt: "幫我整理\n這段內容", skill: null });
    expect(md.slice(m!.at, m!.at + 7)).toBe("@claude");
    expect(md.slice(m!.groupEnd)).toBe("\n\n下一段");
  });

  it("splits list items and headings into their own blocks", () => {
    const md = "- a @claude 一\n- b\n- [ ] @claude 二\n";
    const ms = findMentions(md);
    expect(ms.map((m) => [m.prompt, m.leadIn])).toEqual([["一", "a"], ["二", ""]]);
    // the reply goes after the whole contiguous list
    expect(md.slice(ms[0]!.groupEnd)).toBe("\n");
  });

  it("reads /[[技能]] and /技能 with extra text", () => {
    expect(findMentions("@claude /[[摘要論文]] 重點放在方法")[0]).toMatchObject({
      skill: { title: "摘要論文", form: "wikilink" }, prompt: "重點放在方法",
    });
    expect(findMentions("@claude /摘要論文")[0]).toMatchObject({ skill: { title: "摘要論文", form: "text" }, prompt: "" });
    // a path is text, not a skill
    expect(findMentions("@claude /etc/hosts 是什麼")[0]).toMatchObject({ skill: null, prompt: "/etc/hosts 是什麼" });
  });

  it("ignores code, quotes, frontmatter, e-mail addresses and reserved words", () => {
    const md = [
      "---", "note: @claude x", "---", "",
      "```", "@claude in fence", "```", "",
      "`@claude inline` code", "",
      "> **Claude** · reply @claude", "",
      "mail me a@claude.com", "",
      "due @today and @tomorrow", "",
      "寫給 @all", "",
    ].join("\n");
    expect(findMentions(md)).toEqual([]);
  });

  it("accepts CJK handles and lower-cases them", () => {
    expect(findMentions("@小幫手 你好")[0]!.handle).toBe("小幫手");
    expect(findMentions("@Claude hi")[0]!.handle).toBe("claude");
  });

  it("has no block id without an anchor, and reports the block's own range", () => {
    const md = "@claude hi\nthere\n\nafter";
    const [m] = findMentions(md);
    expect(m!.blockId).toBeNull();
    expect(md.slice(m!.blockStart, m!.blockEnd)).toBe("@claude hi\nthere");
  });

  it("a `^id` at the end of the text is part of the prompt, not the block's id", () => {
    const [m] = findMentions("@claude hi ^s7k2\n");
    expect(m).toMatchObject({ blockId: null, prompt: "hi ^s7k2" });
  });

  it("an anchor that does not start at the block's first line gives it no id", () => {
    const md = "前言\n\n@claude hi";
    expect(findMentions(md, [{ id: "k", from: 1 }])[0]!.blockId).toBeNull();
    expect(findMentions(md, [{ id: "k", from: md.indexOf("@claude") }])[0]!.blockId).toBe("k");
  });

  it("is cheap on a note without @", () => {
    expect(findMentions("x".repeat(100_000))).toEqual([]);
  });
});

describe("parseMention", () => {
  const md = "@claude a\n\n@claude a\n\n@claude b\n";
  const anchors = [{ id: "k1", from: 0 }];
  it("finds by block id", () => {
    expect(parseMention(md, { blockId: "k1" }, anchors)).toMatchObject({ prompt: "a" });
    expect(parseMention(md, { blockId: "nope" }, anchors)).toBeNull();
    expect(parseMention(md, { blockId: "k1" })).toBeNull();
  });
  it("finds an id-less block by its text, and refuses a text that matches twice", () => {
    expect(parseMention(md, { blockText: "@claude b" })).toMatchObject({ prompt: "b", blockId: null });
    expect(parseMention("@claude a\n\n@claude a\n", { blockText: "@claude a" })).toBe("ambiguous");
  });
});

describe("isMentionHandle", () => {
  it("applies the grammar", () => {
    expect(isMentionHandle("claude")).toBe(true);
    expect(isMentionHandle("Claude")).toBe(false);
    expect(isMentionHandle("today")).toBe(false);
    expect(isMentionHandle("a b")).toBe(false);
    expect(isMentionHandle("x".repeat(33))).toBe(false);
  });
});

describe("@ai", () => {
  it("is an ordinary handle to the parser, with a skill and a prompt", () => {
    expect(AI_MENTION_ALIAS).toBe("ai");
    expect(isMentionHandle(AI_MENTION_ALIAS)).toBe(true);
    const [m] = findMentions("@ai /[[摘要論文]] 重點放在方法", [{ id: "k1", from: 0 }]);
    expect(m).toMatchObject({ handle: "ai", blockId: "k1", prompt: "重點放在方法", skill: { title: "摘要論文", form: "wikilink" } });
    // written in capitals it is still the alias: handles are read lower case
    expect(findMentions("@AI 好")[0]!.handle).toBe("ai");
    // an e-mail address or a word ending in ai is not a mention
    expect(findMentions("寫信給 me@ai.com 或 Thai")).toEqual([]);
  });
});
