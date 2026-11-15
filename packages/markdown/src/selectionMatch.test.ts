import { describe, expect, it } from "vitest";
import { findSelection } from "./selectionMatch.js";

describe("findSelection", () => {
  it("finds a text that appears once", () => {
    expect(findSelection("abc def ghi", "def")).toEqual({ found: "one", at: 4, length: 3 });
  });
  it("says none for a missing or empty selection, several for a repeat (overlaps count)", () => {
    expect(findSelection("abc", "x")).toEqual({ found: "none" });
    expect(findSelection("abc", "")).toEqual({ found: "none" });
    expect(findSelection("a b a", "a")).toEqual({ found: "several" });
    expect(findSelection("aaa", "aa")).toEqual({ found: "several" });
  });
  it("treats pattern characters as plain text", () => {
    expect(findSelection("x (a+b)* y", "(a+b)*")).toEqual({ found: "one", at: 2, length: 6 });
    expect(findSelection("a.c abc", "a.c")).toEqual({ found: "one", at: 0, length: 3 });
  });
  it("matches a multi-line selection against a CRLF note and reports the note's own length", () => {
    const note = "one\r\ntwo\r\nthree";
    expect(findSelection(note, "one\ntwo")).toEqual({ found: "one", at: 0, length: 8 });
    expect(findSelection(note, "one\r\ntwo")).toEqual({ found: "one", at: 0, length: 8 });
    expect(findSelection("one\ntwo", "one\ntwo")).toEqual({ found: "one", at: 0, length: 7 });
  });
});
