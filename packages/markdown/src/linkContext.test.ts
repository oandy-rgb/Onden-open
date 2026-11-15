import { describe, expect, it } from "vitest";
import { plainText } from "./linkContext.js";
import { plainExcerpt } from "./graphemes.js";
import { linkPlaces, type ContextPiece, type LinkPlace } from "./linkPlaces.js";

const toThis = (body: string) => body.split(/[|#]/)[0]!.trim() === "目標";
const links = (md: string, extra: { isEmbed?: (b: string) => boolean; max?: number } = {}): LinkPlace[] => linkPlaces(md, { isTarget: toThis, ...extra });
const flat = (pieces: ContextPiece[]) => pieces.map((p) => (p.mark ? `<${p.text}>` : p.text)).join("");
const sentences = (md: string) => links(md).map((p) => (p.kind === "link" ? flat(p.pieces) : "embed"));

describe("linkPlaces", () => {
  it("returns the paragraph with the link's words marked and the syntax gone", () => {
    expect(sentences("# 標題\n\n我讀了 **很多** 書，其中 [[目標]] 最好 [官網](https://x.test)。 ^abc")).toEqual(["我讀了 很多 書，其中 <目標> 最好 官網。"]);
  });

  it("marks the alias the author wrote", () => {
    expect(sentences("見 [[目標|這一篇]] 的說明")).toEqual(["見 <這一篇> 的說明"]);
  });

  it("reads the list item, not the whole list", () => {
    expect(sentences("- 第一項\n- [ ] 第二項連到 [[目標]]\n  延伸一行\n- 第三項")).toEqual(["第二項連到 <目標> 延伸一行"]);
  });

  it("reads a quote and drops the quote marks", () => {
    expect(sentences("> 引用 [[目標]]\n> 下一行")).toEqual(["引用 <目標> 下一行"]);
  });

  it("ignores links in code and links to other pages", () => {
    expect(links("`[[目標]]` 與 [[別篇]]\n\n```\n[[目標]]\n```")).toEqual([]);
  });

  it("lists each sentence once, at most three", () => {
    const md = ["一 [[目標]]", "二 [[目標]] 與 [[目標]]", "三 [[目標]]", "四 [[目標]]"].join("\n\n");
    expect(sentences(md)).toEqual(["一 <目標>", "二 <目標> 與 <目標>", "三 <目標>"]);
    expect(links(md, { max: 2 })).toHaveLength(2);
  });

  it("cuts a long paragraph to about 80 characters around the link", () => {
    const md = `${"前".repeat(100)}[[目標]]${"後".repeat(100)}`;
    const [place] = links(md);
    const text = place!.kind === "link" ? flat(place!.pieces) : "";
    expect(text.startsWith("…")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text).toContain("<目標>");
    expect(Array.from(text.replace(/[<>…]/g, "")).length).toBe(80);
  });

  it("cuts only the side that is long", () => {
    const [place] = links(`[[目標]]${"後".repeat(200)}`);
    const text = place!.kind === "link" ? flat(place!.pieces) : "";
    expect(text.startsWith("<目標>")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
  });

  it("does not split a surrogate pair when it cuts", () => {
    const [place] = links(`${"😀".repeat(100)}[[目標]]${"😀".repeat(100)}`);
    const text = place!.kind === "link" ? flat(place!.pieces) : "";
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("reports the embeds the server turned into links as embeds, with the part they name", () => {
    const places = links("開頭\n\n[[目標#^k1]]\n\n另一段 [[目標]]", { isEmbed: (b) => b === "目標#^k1" });
    expect(places[0]).toMatchObject({ kind: "embed", embed: { target: "目標", blockId: "k1" } });
    expect(places[1]!.kind).toBe("link");
  });

  it("skips the frontmatter", () => {
    expect(links("---\nrelated: '[[目標]]'\n---\n沒有連結")).toEqual([]);
  });
});

describe("plainText / plainExcerpt", () => {
  it("removes syntax and joins blocks", () => {
    expect(plainText("## 標題\n\n- *重點* `a`\n- [x](u)")).toBe("標題 重點 a x");
  });
  it("cuts with an ellipsis only when something is left out", () => {
    expect(plainExcerpt("一二三", 34)).toBe("一二三");
    expect(plainExcerpt("字".repeat(40), 34)).toBe(`${"字".repeat(34)}…`);
  });
});

describe("plainText with links", () => {
  it("reads a wikilink as its words", () => {
    expect(plainText("先看 [[目標|這篇]]，再看 [[別篇#^k1]]。")).toBe("先看 這篇，再看 別篇。");
  });
});
