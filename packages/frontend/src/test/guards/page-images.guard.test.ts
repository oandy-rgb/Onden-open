// Pictures on a page (`page_images`) are saved in one place, drawn by one layer,
// and uploaded the way every other picture is. Each test pins one thing that
// lives in exactly one place, so a second path (a surface that PUTs the
// attribute itself, its own <img> layer, its own upload call) cannot quietly grow back.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { SRC, findImports, findUses, sourceFiles } from "./sources";

describe("page pictures", () => {
  it("the attribute is written by lib/data/pageImagesWriter only (components and hooks go through the controller)", () => {
    expect(findUses(sourceFiles("components"), /\bsavePageImages\b/)).toEqual([]);
    expect(findUses(sourceFiles("hooks"), /\bsavePageImages\b/)).toEqual([]);
    expect(findUses(sourceFiles("."), /attributes\/page_images|PAGE_IMAGES_ATTRIBUTE/, ["lib/data/pageImagesWriter.ts"])).toEqual([]);
  });

  it("the two page layers share one write: only pageLayerWriter builds an attribute URL for them", () => {
    expect(findUses(sourceFiles("lib/data"), /attributes\/\$\{key\}/, ["lib/data/pageLayerWriter.ts"])).toEqual([]);
  });

  it("surfaces show pictures with the shared layer — only components/page draws one", () => {
    expect(findUses(sourceFiles("components"), /page-image-box|data-page-image\b/, ["components/page/PageImageLayer.tsx"])).toEqual([]);
  });

  it("no page surface keeps its own picture state: they take the controller from usePageImagesController", () => {
    expect(findImports(sourceFiles("components"), /lib\/pageImages\/controller/)).toEqual([]);
  });

  it("a picture is uploaded by lib/data uploadMedia (through useImageUpload), never by a fetch of /api/media of the surface's own", () => {
    const surfaces = ["components/InkNodeView.tsx", "components/CanvasInkLayer.tsx", "components/InkInsertButton.tsx"].map((f) => join(SRC, f));
    expect(findUses(surfaces, /\buploadMedia\b|\bfetch\(|apiFetch|\/api\/media/)).toEqual([]);
    expect(findUses([join(SRC, "components/InkNodeView.tsx")], /\buseImageUpload\b/)).not.toEqual([]);
  });

  it("the PDF toolbar has no Insert button: PdfNodeView hands InkToolbar no `insert`", () => {
    expect(findUses([join(SRC, "components/PdfNodeView.tsx")], /\binsert=\{/)).toEqual([]);
  });
});
