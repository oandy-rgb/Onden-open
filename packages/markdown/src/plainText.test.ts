import { describe, expect, it } from "vitest";
import { checklistLine, lineMarkerLength, plainInline, stripLineMarker, wikilinkLabel } from "./plainText.js";
import { noteSummary } from "./summary.js";

describe("plainInline", () => {
  it("keeps an underscore inside a word and drops emphasis marks", () => {
    expect(plainInline("use snake_case_name and _italic_ and **bold** and ~~gone~~ `code`")).toBe("use snake_case_name and italic and bold and gone code");
  });
  it("reads links, images, wikilinks and footnotes as their words", () => {
    expect(plainInline("![alt](a.png)see [the docs](http://x.y)[^1] and [[Note#Part|alias]] [[Note#^abc]]")).toBe(" see the docs and alias Note");
  });
  it("drops HTML tags but not a comparison", () => {
    expect(plainInline("a <b>bold</b> and 1 < 2 and 3 > 2")).toBe("a bold and 1 < 2 and 3 > 2");
  });
});

describe("stripLineMarker / lineMarkerLength", () => {
  it.each([
    ["## Title", "Title"], ["> - [ ] buy", "buy"], ["  12) item", "item"], ["- [x] done", "done"], ["**bold** line", "**bold** line"], ["#tag", "#tag"],
  ])("%s → %s", (line, words) => {
    expect(stripLineMarker(line)).toBe(words);
    expect(lineMarkerLength(line)).toBe(line.length - words.length);
  });
});

describe("checklistLine", () => {
  it("reads a task line and nothing else", () => {
    expect(checklistLine("  - [x] done it")).toEqual({ prefix: "  - [x] ", checked: true, text: "done it" });
    expect(checklistLine("* [ ] open")).toEqual({ prefix: "* [ ] ", checked: false, text: "open" });
    expect(checklistLine("- plain")).toBeNull();
    expect(checklistLine("1. [ ] numbered")).toBeNull();
  });
});

describe("wikilinkLabel", () => {
  it("shows the alias, else the page without its ^block anchor and with headings as ›", () => {
    expect(wikilinkLabel("a|b")).toBe("b");
    expect(wikilinkLabel("Page#Heading")).toBe("Page › Heading");
    expect(wikilinkLabel("Page#^id")).toBe("Page");
  });
});

describe("the one-line summary keeps the words of a note readable", () => {
  it("does not eat the underscores of snake_case_name", () => {
    expect(noteSummary("call snake_case_name now", { maxLen: 80 })).toBe("call snake_case_name now");
  });
});
