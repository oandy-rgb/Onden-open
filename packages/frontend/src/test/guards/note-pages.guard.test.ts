// The pages of a note (`note_pages`): who makes a page's key, who reads the stored list, and that a PDF of the page list is opened
// by the one viewer. Each test pins one thing that lives in one place, so a second path cannot quietly grow back.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { SRC, findUses, sourceFiles } from "./sources";

describe("the pages of a note", () => {
  it("a page key is made by mintPageId only: the notebook surface does not mint its own, and nothing else appends a page", () => {
    expect(findUses([join(SRC, "components/InkNodeView.tsx")], /\brandomUUID\b|crypto\.randomUUID/)).toEqual([]);
    expect(findUses([join(SRC, "components/InkNodeView.tsx")], /\bmintPageId\b/)).not.toEqual([]);
    expect(findUses(sourceFiles("."), /\bwithPageAppended\(/, ["components/InkNodeView.tsx"])).toEqual([]);
  });

  it("the list is read by its codec: nothing else parses `note_pages` or looks at `pdf_url` to find a note's pages", () => {
    expect(findUses(sourceFiles("."), /JSON\.parse\([^)]*note_pages|attributes\/note_pages/, ["lib/data/pageLayerWriter.ts"])).toEqual([]);
    expect(findUses(sourceFiles("modules/handwriting"), /\bpdf_url\b/)).toEqual([]);
  });

  it("a PDF is opened by usePdfDocument (one per file): the page book's PDF pieces are components/pdf, not a second viewer", () => {
    expect(findUses(sourceFiles("modules"), /loadPdfCore|getDocument\(/)).toEqual([]);
    expect(findUses(sourceFiles("modules/handwriting"), /\busePdfDocument\b/)).not.toEqual([]);
  });

  it("an old PDF note is shown through the same page list: PdfNodeView expands pagesFromPdfUrl, it does not count pages 1..n itself", () => {
    expect(findUses([join(SRC, "components/PdfNodeView.tsx")], /\bpagesFromPdfUrl\b/)).not.toEqual([]);
    expect(findUses([join(SRC, "components/PdfNodeView.tsx")], /for \(let n = 1; shapes/)).toEqual([]);
  });
});
