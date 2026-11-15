// The colour swatches of the context menu (a card's colour on a board, a
// note's colour in the sidebar menu) and the ⌘K colour dialog are drawn by
// components/ColorSwatchRow. A second hand-written swatch loop in them would
// grow back the copies this replaced. (The board's two bars — the selected card's and
// the several-cards one — share components/CardColorSwatches; guards/boardChrome.guard.test.ts.)
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SRC } from "./sources";

describe("colour swatches", () => {
  it.each(["components/ContextMenu.tsx", "components/NoteColorDialog.tsx"])("%s uses ColorSwatchRow, not its own loop", (file) => {
    const text = readFileSync(join(SRC, file), "utf8");
    expect(text).toMatch(/<ColorSwatchRow /);
    expect(text).not.toMatch(/CARD_COLORS/);
  });
});
