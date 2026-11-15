import { describe, it, expect } from "vitest";
import { isHashtagOnlyLine, stripHashtagMarks, tagName } from "./hashtags";

describe("stripHashtagMarks / isHashtagOnlyLine / tagName", () => {
  it("drops # but keeps the word and its boundary", () => {
    expect(stripHashtagMarks("read #研究 now\n#a")).toBe("read 研究 now\na");
    expect(stripHashtagMarks("a#b stays")).toBe("a#b stays");
  });

  it("recognises hashtag-only lines", () => {
    expect(isHashtagOnlyLine("  #garden #研究 ")).toBe(true);
    expect(isHashtagOnlyLine("#garden is nice")).toBe(false);
    expect(isHashtagOnlyLine("## Heading")).toBe(false);
  });

  it("normalises a typed name", () => {
    expect(tagName("  ##研究 ")).toBe("研究");
    expect(tagName("plain")).toBe("plain");
  });
});
