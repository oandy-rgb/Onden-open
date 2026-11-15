import { describe, expect, it } from "vitest";
import { countWords, readingMinutes } from "./readingTime.js";

describe("readingMinutes", () => {
  it("is at least one minute, even for an empty note", () => {
    expect(readingMinutes("")).toBe(1);
    expect(readingMinutes("短")).toBe(1);
  });

  it("counts Chinese at 400 characters a minute", () => {
    expect(readingMinutes("字".repeat(800))).toBe(2);
    expect(readingMinutes("字".repeat(2000))).toBe(5);
  });

  it("counts other words at 200 a minute", () => {
    expect(readingMinutes("word ".repeat(600))).toBe(3);
  });

  it("adds the two for mixed text", () => {
    expect(readingMinutes(`${"字".repeat(800)} ${"word ".repeat(400)}`)).toBe(4);
  });

  it("does not count code blocks, frontmatter, images or link addresses", () => {
    const code = "```ts\n" + "code ".repeat(5000) + "\n```\n";
    const tilde = "~~~\n" + "code ".repeat(5000) + "\n~~~\n";
    const url = "[text](https://example.com/" + "a/".repeat(2000) + ")";
    expect(readingMinutes(`---\ntitle: ${"x ".repeat(3000)}\n---\n短文\n${code}${tilde}![a](${"b".repeat(5000)})${url}`)).toBe(1);
  });

  it("counts an unclosed code fence to the end of the note as code", () => {
    expect(readingMinutes("```\n" + "word ".repeat(5000))).toBe(1);
  });

  it("reads a wikilink as its label", () => {
    expect(readingMinutes("[[" + "x".repeat(4000) + "|短]]")).toBe(1);
  });
});

describe("countWords", () => {
  it("counts the same prose readingMinutes reads: frontmatter, ~~~ fences and bare URLs are not words", () => {
    expect(countWords("---\ntitle: a b c\n---\none two")).toBe(2);
    expect(countWords("a\n~~~\nx y z\n~~~\nb")).toBe(2);
    expect(countWords("see https://example.com/a now")).toBe(2);
  });

  it("counts each CJK character, the long-vowel mark included, and ignores markers and invisible characters", () => {
    expect(countWords("コーヒー")).toBe(4);
    expect(countWords("hello 世界")).toBe(3);
    expect(countWords("# - > ​")).toBe(0);
  });
});
