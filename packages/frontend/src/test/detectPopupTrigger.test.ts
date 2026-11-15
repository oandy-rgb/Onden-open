import { describe, it, expect } from "vitest";
import { detectPopupTrigger } from "../lib/editorCompletion";

describe("detectPopupTrigger", () => {
  it("a `^` at the end of a line is an ordinary character: no popup offers to make an id", () => {
    expect(detectPopupTrigger("^")).toBeNull();
    expect(detectPopupTrigger("some text ^ab")).toBeNull();
  });

  it("still detects the existing triggers", () => {
    expect(detectPopupTrigger("see [[Foo")).toMatchObject({ type: "wikilink", query: "Foo" });
    // A body `#` is Markdown: no tag list (decisions-ui.md).
    expect(detectPopupTrigger("tagged #wor")).toBeNull();
    expect(detectPopupTrigger("#")).toBeNull();
    expect(detectPopupTrigger("# ")).toBeNull();
    expect(detectPopupTrigger("/head")).toEqual({ type: "slash", query: "head", markerIndex: 0 });
    // The menu is translated, so a Chinese query filters it too.
    expect(detectPopupTrigger("/草圖")).toEqual({ type: "slash", query: "草圖", markerIndex: 0 });
    expect(detectPopupTrigger("/a/b")).toBeNull();
  });

  it("returns null for ordinary text", () => {
    expect(detectPopupTrigger("just typing along")).toBeNull();
    expect(detectPopupTrigger("a^b")).toBeNull(); // ^ mid-word (no whitespace before) is not a trigger
  });
});
