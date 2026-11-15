import { describe, expect, it } from "vitest";
import { fenceInfoWord, fenceScanner, fencedLines, openingFenceInfo, withoutFences } from "./fences.js";

describe("fenceScanner", () => {
  it("follows CommonMark: same character, at least as long, nothing after the closing fence", () => {
    const scan = fenceScanner();
    expect(["```js", "x", "~~~", "``", "```` ", "after"].map(scan)).toEqual(["open", "inside", "inside", "inside", "close", "outside"]);
  });
  it("lets an unclosed fence run to the end", () => {
    expect(fencedLines(["a", "```", "b", "c"])).toEqual([false, true, true, true]);
  });
  it("a backtick fence's info holds no backtick (that is inline code)", () => {
    expect(fencedLines(["```not `fence`", "x"])).toEqual([false, false]);
  });
  it("sees a fence in a quote or list item only when asked", () => {
    expect(fencedLines(["> ```", "> x"])).toEqual([false, false]);
    expect(fencedLines(["- ```js", "  x", "  ```"], { container: true })).toEqual([true, true, true]);
  });
  it("indents of four spaces are code, not a fence", () => {
    expect(fencedLines(["    ```"])).toEqual([false]);
  });
});

describe("withoutFences", () => {
  it("replaces each fenced block once and keeps the lines around it", () => {
    expect(withoutFences("a\n```\nx\n```\nb", " ")).toBe("a\n \nb");
  });
});

describe("opening fence info", () => {
  it("is the text after the marks; its first word is the language", () => {
    expect(openingFenceInfo("```ts title=x")).toBe("ts title=x");
    expect(fenceInfoWord("ts title=x")).toBe("ts");
    expect(openingFenceInfo("text")).toBeNull();
  });
});

describe("fenceScanner with math", () => {
  const read = (text: string) => { const next = fenceScanner({ math: true }); return text.split("\n").map(next); };
  it("reads a `$$` block like a fence: open, inside, close", () => {
    expect(read("a\n$$\nx\n---\n$$\nb")).toEqual(["outside", "open", "inside", "inside", "close", "outside"]);
  });
  it("a one-line `$$x$$` and a four-space indent are not blocks", () => {
    expect(read("$$x$$\n    $$\ny")).toEqual(["outside", "outside", "outside"]);
  });
  it("closes only on at least as many `$`, and runs to the end when unclosed", () => {
    expect(read("$$$\nx\n$$\n$$$\ny")).toEqual(["open", "inside", "inside", "close", "outside"]);
    expect(read("$$\nx\ny")).toEqual(["open", "inside", "inside"]);
  });
  it("off by default", () => {
    const next = fenceScanner();
    expect(["$$", "x", "$$"].map(next)).toEqual(["outside", "outside", "outside"]);
  });
});
