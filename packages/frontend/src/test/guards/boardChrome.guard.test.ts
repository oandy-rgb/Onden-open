// The whiteboard's floating controls (docs: changes/2026-10-30-board-toolbar.md): where they sit is decided by
// the board's own width (a container query on .graph-panel), not the window's — a side bar or a portrait
// tablet narrows the board while the window stays wide. Colour choices, the phone breakpoint and the layer
// number each have one owner. Exceptions are listed with a reason; the list may only shrink.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SRC } from "./sources";

const read = (file: string) => readFileSync(join(SRC, file), "utf8");
const BOARD_CSS = ["BoardCornerControls", "BoardSelectionBar", "BoardToolbar", "BoardViewMenu"].map((name) => `components/${name}.css`);

/** Board controls whose width rules still follow the window. The tool bar only sets a bottom offset and 44px targets for a phone. */
// ratchet:list WINDOW_MEDIA_ALLOWED
const WINDOW_MEDIA_ALLOWED: Record<string, string> = {
  "components/BoardToolbar.css": "touch target size and bottom offset belong to the device, not the board's width",
};
const CONTAINER_WIDTHS = [600, 900];

describe("board controls follow the board's width", () => {
  it("make .graph-panel a size container named board, and the corner and selection bar answer to it", () => {
    expect(read("components/BoardCornerControls.css")).toMatch(/\.graph-panel\s*\{\s*container:\s*board\s*\/\s*inline-size;/);
    for (const file of ["components/BoardCornerControls.css", "components/BoardSelectionBar.css"]) {
      const widths = [...read(file).matchAll(/@container board \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
      expect(widths.length, file).toBeGreaterThan(0);
      for (const width of widths) expect(CONTAINER_WIDTHS, file).toContain(width);
    }
  });

  it("use no window media query except the allowed ones", () => {
    const offenders = BOARD_CSS.filter((file) => /@media[^{]*max-width/.test(read(file)) && !(file in WINDOW_MEDIA_ALLOWED));
    expect(offenders).toEqual([]);
    for (const file of Object.keys(WINDOW_MEDIA_ALLOWED)) expect(BOARD_CSS, "allow-list entry names a board stylesheet").toContain(file);
  });

  it("the narrow-board rule hides the selection bar's text, not its buttons", () => {
    const css = read("components/BoardSelectionBar.css");
    expect(css).toMatch(/@container board \(max-width: 600px\)\s*\{\s*\.board-selection-label\s*\{\s*display:\s*none;/);
    expect(css).toMatch(/\.board-selection-bar\s*\{[^}]*max-width:\s*calc\(100cqw/);
  });
});

describe("one owner each", () => {
  it("the selected card's bar and the several-cards bar pick colours through CardColorSwatches", () => {
    for (const file of ["components/BoardSelectionBar.tsx", "components/KnowledgeWorkspace.tsx"]) {
      const text = read(file);
      expect(text, file).toMatch(/<CardColorSwatches /);
      expect(text, file).not.toMatch(/CARD_COLORS/);
    }
  });

  it("the 「顯示」 sheet follows the app's phone breakpoint instead of defining its own", () => {
    const text = read("components/BoardViewMenu.tsx");
    expect(text).toMatch(/useIsMobile\(\)/);
    expect(text).not.toMatch(/max-width:\s*\d+px/);
  });

  it("board controls take their layer from --board-chrome-z and their colours from tokens", () => {
    for (const file of [...BOARD_CSS, "components/CanvasMode.css"]) {
      const css = read(file);
      for (const [, z] of css.matchAll(/--board-chrome-z\)?[^;]*;|z-index:\s*(\d+);/g)) if (z && file !== "components/CanvasMode.css") throw new Error(`${file}: z-index ${z} is a bare number`);
    }
    for (const file of BOARD_CSS) expect(read(file), file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(read("components/BoardToolbar.css")).toMatch(/--board-chrome-z:\s*12/);
  });

  it("the full-screen hook points at the stylesheet that really holds the rule", () => {
    expect(read("hooks/useBoardFullscreen.ts")).toContain("components/CanvasMode.css");
    expect(read("components/CanvasMode.css")).toContain("body.onden-board-fullscreen");
  });
});
