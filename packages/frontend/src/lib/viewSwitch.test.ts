import { describe, expect, it } from "vitest";
import { noteMode, otherView, previewAvailable, sourceOffsetFromPreviewText } from "./viewSwitch";

describe("view switch", () => {
  it("flips between editing and preview", () => {
    expect(otherView("edit")).toBe("preview");
    expect(otherView("preview")).toBe("edit");
  });

  it("is in one of three modes: the preview wins, side by side is editing with the split on", () => {
    expect(noteMode("edit", false)).toBe("edit");
    expect(noteMode("edit", true)).toBe("split");
    expect(noteMode("preview", true)).toBe("preview");
    expect(noteMode("preview", false)).toBe("preview");
  });

  it("a PDF or handwriting note has no preview", () => {
    expect(previewAvailable({ pdfUrl: null, inkActive: false })).toBe(true);
    expect(previewAvailable({ pdfUrl: "/a.pdf", inkActive: false })).toBe(false);
    expect(previewAvailable({ pdfUrl: null, inkActive: true })).toBe(false);
  });

  it("maps a click in rendered text to the same spot in the source, or null", () => {
    const source = "# Title\n\nsecond **bold** paragraph";
    expect(sourceOffsetFromPreviewText(source, "Title", 2)).toBe(source.indexOf("Title") + 2);
    expect(sourceOffsetFromPreviewText(source, " paragraph", 4)).toBe(source.indexOf("paragraph") + 3);
    expect(sourceOffsetFromPreviewText(source, "second bold paragraph", 3)).toBeNull();
    expect(sourceOffsetFromPreviewText(source, "   ", 1)).toBeNull();
  });
});
