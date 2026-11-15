// Shapes and ink colours each live in one place now (docs/agents/decisions-canvas.md,
// 「手寫：形狀、停住自動修形、更多顏色」). Each test pins one of them so the
// copy that caused "shapes can't be drawn on the tablet" cannot grow back.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SRC, findUses, sourceFiles } from "./sources";

describe("the shape tool", () => {
  // A shape was once dragged out on its own React pointer surface, outside the
  // ink engine: the touch layer did not know it, so the browser took the drag.
  // Every shape — chosen from the button or made by holding the pen still — is
  // the engine's, with the engine's input rules.
  it("no component keeps its own shape-dragging surface", () => {
    expect(findUses(sourceFiles("components"), /PdfPageShapeSurface|pdf-shape-surface|pdf-shape-preview/)).toEqual([]);
  });

  it("the PDF's touch layer treats every tool but Select as owning the pen", () => {
    const text = readFileSync(join(SRC, "components/PdfNodeView.tsx"), "utf8");
    expect(text).toMatch(/const isInkTool = \(tool: PdfTool\): tool is InkActiveTool => tool !== "select"/);
    // The page book's touch layer owns the pen exactly while the shell hands it an ink tool (null = none).
    expect(text).toMatch(/tool=\{inkTool\}/);
    expect(readFileSync(join(SRC, "pagebook/PageBook.tsx"), "utf8")).toMatch(/penOwned: \(\) => toolRef\.current !== null/);
  });

  // The outline of a kind is one function (inkShapePolylines) for the engine, the
  // PDF page's SVG and the static SVG; a hand-written ellipse or rect elsewhere
  // is a second geometry that drifts.
  it("the page's SVG and the exports draw shapes from the shared geometry", () => {
    expect(findUses(sourceFiles("components/pdf"), /<ellipse|<rect\b|<line\b/)).toEqual([]);
    expect(readFileSync(join(SRC, "../../markdown/src/inkSvg.ts"), "utf8")).not.toMatch(/<ellipse|<rect /);
  });
});

describe("ink colours", () => {
  // The toolbar's colours are the person's own (quick colours, recent, made):
  // hosts hold the colour value and never look a colour up by id again.
  it("hosts do not keep a colour id or look colours up in INK_COLORS", () => {
    const hosts = ["components/InkNodeView.tsx", "components/CanvasInkLayer.tsx", "components/PdfNodeView.tsx"].map((rel) => join(SRC, rel));
    expect(findUses(hosts, /\bcolorId\b|INK_COLORS\.find/)).toEqual([]);
  });

  it("the palette is read and written only through lib/inkPrefs (one account pref, one parser)", () => {
    expect(findUses(sourceFiles("."), /serverKey:\s*"inkPalette"/, ["lib/inkPrefs.ts"])).toEqual([]);
    expect(findUses(sourceFiles("components"), /inkPalettePref/)).toEqual([]);
  });
});
