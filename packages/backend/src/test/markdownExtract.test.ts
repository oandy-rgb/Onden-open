import { describe, it, expect } from "vitest";
import { extractWikilinks, extractAttributes } from "../utils.js";
import { slugify } from "@onden/markdown";

describe("slugify edge cases", () => {
  it("handles ASCII", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("Foo Bar Baz")).toBe("foo-bar-baz");
  });
  it("handles CJK characters", () => {
    expect(slugify("殘差連結")).toBe("殘差連結");
    expect(slugify("我的 筆記")).toBe("我的-筆記");
  });
  it("strips ASCII punctuation but keeps unicode letters and digits", () => {
    expect(slugify("a/b c?d!")).toBe("ab-cd");
    expect(slugify("123-abc")).toBe("123-abc");
  });
  it("collapses repeated dashes", () => {
    expect(slugify("a---b")).toBe("a-b");
    expect(slugify("  a   b  ")).toBe("a-b");
  });
  it("trims leading and trailing dashes", () => {
    expect(slugify("---hello---")).toBe("hello");
  });
  it("returns 'node' for empty input", () => {
    expect(slugify("")).toBe("node");
    expect(slugify("   ")).toBe("node");
    expect(slugify("!!!")).toBe("node");
  });
});

describe("extractWikilinks", () => {
  it("extracts single wikilink", () => {
    expect(extractWikilinks("Link to [[Other Page]]")).toEqual(["Other Page"]);
  });
  it("extracts multiple unique wikilinks", () => {
    expect(extractWikilinks("[[A]] and [[B]] then [[A]] again")).toEqual(["A", "B"]);
  });
  it("trims whitespace inside brackets", () => {
    expect(extractWikilinks("[[  spaced  ]]")).toEqual(["spaced"]);
  });
  it("handles CJK page names", () => {
    expect(extractWikilinks("見 [[殘差連結]] 細節")).toEqual(["殘差連結"]);
  });
  it("returns empty array when no wikilinks present", () => {
    expect(extractWikilinks("just plain text")).toEqual([]);
    expect(extractWikilinks("")).toEqual([]);
  });
  it("ignores single-bracket links", () => {
    expect(extractWikilinks("[not wikilink]")).toEqual([]);
  });
  it("doesn't extract from unclosed brackets", () => {
    expect(extractWikilinks("[[only-open")).toEqual([]);
  });
  it("strips the display alias (Page|alias → Page)", () => {
    expect(extractWikilinks("See [[Other Page|the alias]]")).toEqual(["Other Page"]);
  });
  it("strips a heading anchor (Page#heading → Page)", () => {
    expect(extractWikilinks("See [[Other Page#Some Heading]]")).toEqual(["Other Page"]);
  });
  it("strips a block anchor (Page#^block → Page)", () => {
    expect(extractWikilinks("See [[Other Page#^abc123]]")).toEqual(["Other Page"]);
  });
  it("strips both heading and alias together", () => {
    expect(extractWikilinks("[[Other Page#Heading|nice label]]")).toEqual(["Other Page"]);
  });
  it("dedupes a bare link and its aliased form to the same target", () => {
    expect(extractWikilinks("[[Page]] and [[Page|alias]]")).toEqual(["Page"]);
  });
  it("drops same-page anchors with no target ([[#heading]])", () => {
    expect(extractWikilinks("jump to [[#Section]]")).toEqual([]);
  });
});

describe("extractAttributes (#key=value markdown syntax)", () => {
  it("extracts a single label", () => {
    expect(extractAttributes("Some text #priority=high here")).toEqual({ priority: "high" });
  });
  it("extracts multiple distinct keys", () => {
    expect(extractAttributes("#status=draft #priority=urgent #author=alice")).toEqual({
      status: "draft", priority: "urgent", author: "alice",
    });
  });
  it("supports CJK letters in key and value", () => {
    expect(extractAttributes("#類型=技術 #狀態=完成")).toEqual({ 類型: "技術", 狀態: "完成" });
  });
  it("returns empty object when no attributes", () => {
    expect(extractAttributes("plain text without attributes")).toEqual({});
    expect(extractAttributes("")).toEqual({});
  });
  it("ignores trailing # without value", () => {
    expect(extractAttributes("hashtag #tag without equals")).toEqual({});
  });
  it("later instance overwrites earlier (last-write-wins)", () => {
    expect(extractAttributes("#k=first #k=second")).toEqual({ k: "second" });
  });
});
