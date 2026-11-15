import { describe, it, expect } from "vitest";
import { countWords } from "@onden/markdown";

// countWords strips markdown scaffolding before tallying. The reading time
// next to it is @onden/markdown's readingMinutes (see lib/wordStats.test.ts).

describe("countWords", () => {
  it("counts whitespace-separated words in plain prose", () => {
    expect(countWords("the quick brown fox")).toBe(4);
  });

  it("returns 0 for empty or whitespace-only input (not 1)", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
  });

  it("does not count markdown markers as words", () => {
    // headings, list bullets, emphasis runs are scaffolding, not prose
    expect(countWords("# Title")).toBe(1);
    expect(countWords("- one\n- two\n- three")).toBe(3);
    expect(countWords("**bold** and *italic*")).toBe(3); // bold and italic
  });

  it("strips fenced and inline code so syntax doesn't inflate the count", () => {
    expect(countWords("before\n```js\nconst x = 1;\n```\nafter")).toBe(2);
    expect(countWords("call `someFunction()` now")).toBe(3); // call someFunction now: inline code is prose, as in the reading time
  });

  it("keeps link/wikilink label text but drops the URL and brackets", () => {
    expect(countWords("see [the docs](https://example.com/page)")).toBe(3); // see the docs
    expect(countWords("[[Some Note]] here")).toBe(3); // Some Note here
    expect(countWords("[[note-id|Display Label]]")).toBe(2); // Display Label
  });

  it("drops images entirely (alt text is metadata, not prose)", () => {
    expect(countWords("![alt text](https://x/y.png) caption")).toBe(1); // caption
  });

  it("ignores bare URLs", () => {
    expect(countWords("read https://example.com/a/b now")).toBe(2); // read now
  });

  it("counts each CJK glyph as one word (no spaces in the script)", () => {
    expect(countWords("你好世界")).toBe(4);
    expect(countWords("hello 世界")).toBe(3); // hello + 2 glyphs
  });
});
