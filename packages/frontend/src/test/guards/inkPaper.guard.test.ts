// @vitest-environment node
// Guard: paper is white in both themes (owner 2026-11-20, 「紙應該要白色的吧」). Handwriting pages, PDF pages, drawings embedded in
// notes and quoted ink regions show strokes in their STORED colours on --ac-pure-white; the lightness inversion of lib/ink/color.ts is
// only for surfaces that take the app theme (the whiteboard canvas). Decision: docs/agents/decisions-ui.md.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { invertLightness, themedStrokeColor } from "../../lib/ink";
import { SRC } from "./sources";

const read = (rel: string) => readFileSync(`${SRC}/${rel}`, "utf8");

describe("paper surfaces never invert ink", () => {
  it("the page book, its ink surface and its text boxes know nothing of the dark theme", () => {
    for (const rel of ["pagebook/PageBook.tsx", "pagebook/PageInkSurface.tsx", "components/page/TextBoxLayer.tsx", "components/InkNodeView.tsx"]) {
      expect(read(rel), rel).not.toMatch(/themedStrokeColor|setDarkMode|isDarkTheme|useAppSchemeMode|\bdark\b/);
    }
  });
  it("a page sheet and an embedded drawing are --ac-pure-white, and no filter inverts a picture", () => {
    expect(read("pagebook/PageBook.css")).toMatch(/\.pagebook-page \{[^}]*background: var\(--ac-pure-white\)/);
    const embeds = read("styles/embeds.css");
    expect(embeds).toMatch(/\.md-drawing-picture svg \{[^}]*background: var\(--ac-pure-white\)/);
    expect(embeds).not.toMatch(/invert\(/);
    expect(read("styles/tokens.css")).toMatch(/--ac-pure-white:\s+#fff;/);
  });
});

describe("the whiteboard keeps its dark-theme behaviour", () => {
  it("the whiteboard canvas still tells its engine about the theme", () => {
    expect(read("components/CanvasInkLayer.tsx")).toMatch(/setDarkMode\(darkRef\.current\)/);
  });
  it("a near-black stroke stored as #1a1a1a is near-white on the dark whiteboard, and unchanged on paper", () => {
    const luminance = (hex: string) => parseInt(hex.slice(1, 3), 16);
    expect(luminance(themedStrokeColor("#1a1a1a", true))).toBeGreaterThan(200);
    expect(themedStrokeColor("#1a1a1a", false)).toBe("#1a1a1a");
    expect(invertLightness("#1a1a1a")).not.toBe("#1a1a1a");
  });
});
