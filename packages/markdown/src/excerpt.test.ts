import { describe, expect, it } from "vitest";
import { anchoredBlocks, parseBlocks } from "./blocks.js";
import { extractBlock } from "./embedExtract.js";
import {
  EXCERPT_CONTEXT_MAX, excerptBlock, excerptBlockSpans, excerptContext, excerptsOfPage, excerptPlain, expandExcerptEmbeds, parseExcerpts, sameExcerpt, sourceLine,
} from "./excerpt.js";

const SOURCE = { title: "An Article", url: "https://example.com/a", feed: "Daily News" };

/** `parts` joined by blank lines, and one anchor per excerpt block (id → where its block starts and ends): what a note
 *  holding these excerpts is now — text without ids, plus anchor rows. */
function note(...parts: Array<string | { id: string; block: string }>): { markdown: string; anchors: Array<{ id: string; from: number; to: number }> } {
  let markdown = "";
  const anchors: Array<{ id: string; from: number; to: number }> = [];
  for (const part of parts) {
    if (markdown) markdown += "\n\n";
    if (typeof part === "string") { markdown += part; continue; }
    anchors.push({ id: part.id, from: markdown.length, to: markdown.length + part.block.length });
    markdown += part.block;
  }
  return { markdown: `${markdown}\n`, anchors };
}

describe("excerptBlock", () => {
  it("is a quote and a source line with a Text Fragment; it carries no id (the caller gives it an anchor)", () => {
    expect(excerptBlock({ exact: "The quick brown fox", prefix: "Today ", suffix: "jumps" }, SOURCE)).toBe(
      "> The quick brown fox\n>\n> — [An Article](https://example.com/a#:~:text=Today%20-,The%20quick%20brown%20fox,-jumps) · Daily News",
    );
  });

  it("writes no fragment context it was not given, and drops the page's own fragment", () => {
    expect(excerptBlock({ exact: "fox" }, { ...SOURCE, url: "https://example.com/a#top" })).toBe(
      "> fox\n>\n> — [An Article](https://example.com/a#:~:text=fox) · Daily News",
    );
  });

  it("percent-encodes what a Text Fragment reserves: - & , and what a Markdown link cannot hold: ( )", () => {
    const md = excerptBlock({ exact: "state-of-the-art R&D, (really)" }, SOURCE);
    const link = /\]\((\S+)\)/.exec(md)![1]!;
    expect(link).toBe("https://example.com/a#:~:text=state%2Dof%2Dthe%2Dart%20R%26D%2C%20%28really%29");
    expect(link.slice(link.indexOf("text=") + 5)).not.toMatch(/[-&,()]/);
  });

  it("names a long or multi-line passage by its first and last words (a range)", () => {
    const long = `${"開頭".repeat(10)}${"中".repeat(400)}${"結尾".repeat(10)}`;
    const md = excerptBlock({ exact: long }, SOURCE);
    const fragment = decodeURIComponent(/text=([^)]+)\)/.exec(md)![1]!);
    const [start, end] = fragment.split(",");
    expect(long.startsWith(start!)).toBe(true);
    expect(long.endsWith(end!)).toBe(true);
    expect(/text=([^)]+)\)/.exec(md)![1]!.length).toBeLessThan(encodeURIComponent(long).length / 2); // not the whole passage

    const two = excerptBlock({ exact: "first line\nsecond line" }, SOURCE);
    expect(two).toContain("text=first%20line,second%20line)");
  });

  it("writes a plain source name when there is no link", () => {
    expect(excerptBlock({ exact: "q" }, { title: "Offline", url: null, feed: "" })).toBe("> q\n>\n> — Offline");
    expect(excerptBlock({ exact: "q" }, { title: " ", url: null, feed: "" }, "未命名")).toBe("> q\n>\n> — 未命名");
  });
});

describe("parseExcerpts", () => {
  const roundTrip = (quote: Parameters<typeof excerptBlock>[0], source = SOURCE) => {
    const n = note("# Notes", "Some text.", { id: "id1", block: excerptBlock(quote, source) }, "After.");
    return parseExcerpts(n.markdown, n.anchors);
  };

  it("reads back what was written: text, page, title, feed, context and id", () => {
    expect(roundTrip({ exact: "The quick brown fox", prefix: "Today", suffix: "jumps over" })).toEqual([
      { id: "id1", exact: "The quick brown fox", prefix: "Today", suffix: "jumps over", url: "https://example.com/a", title: "An Article", feed: "Daily News" },
    ]);
  });

  it("round-trips Chinese, - and &, brackets in the title, and paragraphs", () => {
    const quote = { exact: "資料庫的 state-of-the-art 與 R&D，\n\n第二段 — 還有 [括號]", prefix: "前文-前", suffix: "後文&後" };
    const source = { title: "A [b] 與 c", url: "https://x.test/p?q=1&r=(2)", feed: "訂閱 · 名" };
    const [e] = roundTrip(quote, source);
    expect(e).toMatchObject({ exact: quote.exact, prefix: "前文-前", suffix: "後文&後", title: "A [b] 與 c", feed: "訂閱 · 名", id: "id1" });
    expect(sameExcerpt(e!, { url: source.url, exact: quote.exact })).toBe(true);
  });

  it("round-trips a multi-line quote and a quote line that starts with >", () => {
    const [e] = roundTrip({ exact: "line one\nline two\n> nested?" });
    expect(e!.exact).toBe("line one\nline two\n> nested?");
  });

  it("has an empty prefix and suffix when none were known", () => {
    const [e] = roundTrip({ exact: "alone" });
    expect(e).toMatchObject({ prefix: "", suffix: "", exact: "alone" });
  });

  it("is anchored as a quote block by the ordinary block scanner, and embeds with its source line", () => {
    const n = note("Intro.", { id: "id1", block: excerptBlock({ exact: "The fox" }, SOURCE) });
    expect(anchoredBlocks(n.markdown, n.anchors).map((a) => [a.id, a.kind])).toEqual([["id1", "quote"]]);
    expect(extractBlock(n.markdown, "id1", n.anchors)).toBe("> The fox\n>\n> — [An Article](https://example.com/a#:~:text=The%20fox) · Daily News");
    // It adds no block node of its own.
    expect(parseBlocks(n.markdown, n.anchors)).toEqual([]);
  });

  it("ignores quotes that are not excerpts: no anchor, no linked source line, or a source with no link", () => {
    const quote = (text: string) => ({ markdown: text, anchors: [{ id: "q1", from: 0, to: text.trimEnd().length }] });
    expect(parseExcerpts("> plain quote\n\n— [T](https://a.b)\n", [{ id: "q1", from: 0, to: 13 }])).toEqual([]);
    expect(parseExcerpts(quote("> quote\n>\n> — Author\n").markdown, quote("> quote\n>\n> — Author\n").anchors)).toEqual([]);
    expect(parseExcerpts(quote("> quote\n>\n> not a source line\n").markdown, quote("> quote\n>\n> not a source line\n").anchors)).toEqual([]);
    expect(parseExcerpts("plain note [x](y)\n", [{ id: "a", from: 0, to: 17 }])).toEqual([]);
    // A well-formed excerpt without its anchor is just a quote.
    expect(parseExcerpts(note(excerptBlock({ exact: "one" }, SOURCE)).markdown)).toEqual([]);
  });

  it("reads several", () => {
    const n = note({ id: "a1", block: excerptBlock({ exact: "one" }, SOURCE) }, { id: "a2", block: excerptBlock({ exact: "two  words" }, { ...SOURCE, url: "https://other.test/" }) });
    expect(parseExcerpts(n.markdown, n.anchors).map((e) => e.id)).toEqual(["a1", "a2"]);
  });
});

describe("excerptContext", () => {
  it("keeps the nearest whole words, squashed, within the limit", () => {
    const { prefix, suffix } = excerptContext(`${"x".repeat(100)}\n  the   words before `, " and\nthose after ".padEnd(100, "y"));
    expect(prefix).toBe("the words before");
    expect(suffix).toBe("and those after");
    expect(excerptContext("", "")).toEqual({ prefix: "", suffix: "" });
  });

  it("never starts the prefix or ends the suffix inside a word", () => {
    const before = "Once upon a time there was an extraordinarily patient ";
    const after = " jumps over the lazy dog while everybody watches quietly";
    const { prefix, suffix } = excerptContext(before, after);
    expect([...prefix].length).toBeLessThanOrEqual(EXCERPT_CONTEXT_MAX);
    expect([...suffix].length).toBeLessThanOrEqual(EXCERPT_CONTEXT_MAX);
    expect(prefix).toBe("was an extraordinarily patient");
    expect(before.trim().endsWith(prefix)).toBe(true);
    expect(before.trim()[before.trim().length - prefix.length - 1]).toBe(" ");
    expect(suffix).toBe("jumps over the lazy dog while");
    expect(after[after.indexOf(suffix) + suffix.length]).toBe(" ");
  });

  it("cuts Chinese, which has no spaces, between words", () => {
    const before = "今天的天氣非常好所以我們決定去公園散步順便看看新開的咖啡店";
    const after = "老闆說這家店的拿鐵很有名而且價格公道還提供免費的無線網路服務";
    const { prefix, suffix } = excerptContext(before, after);
    expect(prefix.length).toBeGreaterThan(0);
    expect(suffix.length).toBeGreaterThan(0);
    expect(before.endsWith(prefix)).toBe(true);
    expect(after.startsWith(suffix)).toBe(true);
    expect([...prefix].length).toBeLessThanOrEqual(EXCERPT_CONTEXT_MAX);
    expect([...suffix].length).toBeLessThanOrEqual(EXCERPT_CONTEXT_MAX);
    // the cut falls on a segmenter boundary, never inside a word
    const cuts = (text: string) => new Set([...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)].map((x) => x.index));
    expect(cuts(before).has(before.length - prefix.length)).toBe(true);
    expect(cuts(after).has(suffix.length) || suffix.length === after.length).toBe(true);
  });

  it("keeps punctuation with the words around it", () => {
    const { prefix, suffix } = excerptContext("He said: \u201cstate-of-the-art, really\u201d \u2014 ", " (see R&D, 2024). Then more text follows after that.");
    expect(prefix).toBe(": \u201cstate-of-the-art, really\u201d \u2014");
    expect(suffix.startsWith("(see R&D, 2024)")).toBe(true);
    expect(suffix.endsWith(" ")).toBe(false);
  });
});

describe("Text Fragment range ends", () => {
  const link = (exact: string) => excerptBlock({ exact }, SOURCE).match(/\(([^)]*)\)/)![1]!;
  const decoded = (exact: string) => decodeURIComponent(link(exact).split("text=")[1]!.replace(/%2D/g, "-")).split(",");

  it("starts and ends a long passage's range at word boundaries, with no edge spaces", () => {
    const exact = "The quick brown fox jumps over the lazy dog and keeps on running through the forest until the sun goes down behind the hills";
    const [start, end] = decoded(exact);
    expect(exact.startsWith(start!)).toBe(true);
    expect(exact.endsWith(end!)).toBe(true);
    expect(start).toBe(start!.trim());
    expect(end).toBe(end!.trim());
    expect(exact[start!.length]).toBe(" ");
    expect(exact[exact.length - end!.length - 1]).toBe(" ");
    expect(link(exact)).not.toMatch(/,%20/);
  });

  it("does the same across paragraphs and in Chinese", () => {
    const [start, end] = decoded("The quick brown fox jumps over the lazy dog and more words follow here\n\nSecond paragraph with some more words to finish the quote properly okay");
    expect(start!.split(" ").every(Boolean)).toBe(true);
    expect("Second paragraph with some more words to finish the quote properly okay".endsWith(end!)).toBe(true);
    expect(end!.startsWith(" ")).toBe(false);
    const zh = "今天的天氣非常好所以我們決定去公園散步順便看看新開的咖啡店老闆說這家店的拿鐵很有名而且價格公道還提供免費的無線網路服務讓人想一直待下去而且大家都覺得這個決定十分正確所以下次還要再來";
    const [zs, ze] = decoded(zh);
    expect(zh.startsWith(zs!)).toBe(true);
    expect(zh.endsWith(ze!)).toBe(true);
    const cuts = new Set([...new Intl.Segmenter(undefined, { granularity: "word" }).segment(zh)].map((x) => x.index));
    expect(cuts.has(zs!.length)).toBe(true);
    expect(cuts.has(zh.length - ze!.length)).toBe(true);
  });
});

describe("expandExcerptEmbeds", () => {
  const n = note("Intro", { id: "id1", block: excerptBlock({ exact: "The fox", prefix: "See" }, SOURCE) }, "Other");
  const bodyOf = (m: { target: string }) => (m.target === "Today" ? n.markdown : null);

  const withAnchors = (m: { target: string }) => (m.target === "Today" ? n : null);
  const expanded = "> The fox\n>\n> — [An Article](https://example.com/a#:~:text=See-,The%20fox) · Daily News";

  it("replaces an embed alone on its line with the quote and its source link: by its id (`Note#^id`)…", () => {
    expect(expandExcerptEmbeds("before\n\n![[Today#^id1]]\n\nafter", withAnchors)).toBe(`before\n\n${expanded}\n\nafter`);
  });

  it("…or by what the caller read the part link to be (`Note/words`: bodyOf says which anchor)", () => {
    const read = (m: { target: string }) => (m.target === "Today/The fox" ? { ...n, id: "id1" } : null);
    expect(expandExcerptEmbeds("![[Today/The fox]]\n\n![[Today/Other]]", read)).toBe(`${expanded}\n\n![[Today/Other]]`);
    // a part that is not an excerpt, and an embed inside a sentence, stay
    expect(expandExcerptEmbeds("![[Today/The fox]]", (m) => ({ ...n, id: "plain" }))).toBe("![[Today/The fox]]");
    expect(expandExcerptEmbeds("see ![[Today/The fox]] here", read)).toBe("see ![[Today/The fox]] here");
  });

  it("excerptBlockSpans finds the excerpt-shaped quotes, anchored or not, and no other quote", () => {
    const md = `Intro\n\n${excerptBlock({ exact: "The fox" }, SOURCE)}\n\n> just a quote\n\n${excerptBlock({ exact: "Two" }, SOURCE)}\n`;
    const spans = excerptBlockSpans(md);
    expect(spans.map((s) => md.slice(s.from, s.to).split("\n")[0])).toEqual(["> The fox", "> Two"]);
    expect(excerptBlockSpans("no quotes here")).toEqual([]);
  });

  it("excerptPlain writes the quote and its source link without an id", () => {
    expect(excerptPlain(parseExcerpts(n.markdown, n.anchors)[0]!)).toBe("> The fox\n>\n> — [An Article](https://example.com/a#:~:text=See-,The%20fox) · Daily News");
  });

  it("leaves embeds it cannot expand: another block, another note, or one inside a sentence", () => {
    const md = "![[Today#^plain]]\n\n![[Gone#^id1]]\n\nsee ![[Today#^id1]] here\n\n![[Today]]";
    expect(expandExcerptEmbeds(md, bodyOf)).toBe(md);
  });
});

describe("sourceLine", () => {
  it("is 「— [標題](網址) · 訂閱名稱」, escaping brackets and encoding spaces and parentheses", () => {
    expect(sourceLine(SOURCE)).toBe("— [An Article](https://example.com/a) · Daily News");
    expect(sourceLine({ title: "A [b] c", url: "https://x.test/a (1)", feed: "" })).toBe("— [A \\[b\\] c](https://x.test/a%20%281%29)");
    expect(sourceLine({ title: "No link", url: null, feed: "Feed" })).toBe("— No link · Feed");
    expect(sourceLine({ title: " ", url: null, feed: "" }, "未命名")).toBe("— 未命名");
  });
});

describe("excerptsOfPage", () => {
  it("lists the excerpts of one page, whatever fragment its link carries", () => {
    const n = note({ id: "a1", block: excerptBlock({ exact: "one" }, SOURCE) }, { id: "a2", block: excerptBlock({ exact: "two" }, { ...SOURCE, url: "https://other.test/" }) }, { id: "a3", block: excerptBlock({ exact: "three" }, SOURCE) });
    expect(excerptsOfPage(n.markdown, "https://example.com/a#section", n.anchors).map((e) => e.id)).toEqual(["a1", "a3"]);
    expect(excerptsOfPage("plain note", "https://example.com/a")).toEqual([]);
  });
});
