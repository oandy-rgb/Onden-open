// Text boxes on a page (`page_text`) are saved in one place, shown by one layer.
// Each test pins one thing that lives in exactly one place, so a second path
// (a surface that PUTs the attribute itself, a page with its own box editor)
// cannot quietly grow back.
import { describe, expect, it } from "vitest";
import { findImports, findUses, sourceFiles } from "./sources";

describe("page text boxes", () => {
  it("the attribute is written by lib/data/pageTextWriter only (components and hooks go through the controller)", () => {
    expect(findUses(sourceFiles("components"), /\bsavePageText\b/)).toEqual([]);
    expect(findUses(sourceFiles("hooks"), /\bsavePageText\b/)).toEqual([]);
    expect(findUses(sourceFiles("."), /attributes\/page_text|PAGE_TEXT_ATTRIBUTE/, ["lib/data/pageTextWriter.ts"])).toEqual([]);
  });

  it("surfaces show boxes with the shared layer — only components/page draws a box", () => {
    expect(findUses(sourceFiles("components"), /page-text-box/, ["components/page/TextBoxLayer.tsx"])).toEqual([]);
  });

  it("no page surface keeps its own box state: they take the controller from usePageTextController", () => {
    expect(findImports(sourceFiles("components"), /lib\/pageText\/controller/)).toEqual([]);
  });
});
