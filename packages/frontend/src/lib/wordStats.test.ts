import { describe, it, expect } from "vitest";
import { readingMinutes } from "@onden/markdown";
import { wordStats } from "./wordStats";

describe("wordStats", () => {
  it("returns zero for empty / whitespace-only input", () => {
    expect(wordStats("")).toEqual({ words: 0, minutes: 0 });
    expect(wordStats("   \n\t  ")).toEqual({ words: 0, minutes: 0 });
  });

  it("counts plain prose words", () => {
    expect(wordStats("the quick brown fox").words).toBe(4);
  });

  it("does not count markdown leaders as words", () => {
    // '#', '>', '-' style punctuation must not inflate the count.
    expect(wordStats("# Heading").words).toBe(1);
    expect(wordStats("> a quote here").words).toBe(3);
    expect(wordStats("**bold** _italic_").words).toBe(2);
  });

  it("leaves code out of the count", () => {
    expect(wordStats("```\nconst x = 1\n```").words).toBe(0);
    expect(wordStats("call `foo` now").words).toBe(3); // inline code is prose, as in the reading time
  });

  it("counts each Chinese character", () => {
    expect(wordStats("今天天氣很好").words).toBe(6);
    expect(wordStats("用 Onden 寫筆記").words).toBe(5);
  });

  it("shows the reading time the published page shows (readingMinutes)", () => {
    const words = Array.from({ length: 450 }, (_, i) => `w${i}`).join(" ");
    expect(wordStats(words).minutes).toBe(readingMinutes(words));
    expect(wordStats("字".repeat(401)).minutes).toBe(readingMinutes("字".repeat(401)));
    expect(wordStats("one two three").minutes).toBe(1);
  });

  it("never reports a reading time for empty input", () => {
    expect(wordStats("").minutes).toBe(0);
  });
});
