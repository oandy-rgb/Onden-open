// A sheet or dialog header is one component (components/ui/SheetHeader.tsx): its text actions and its ✕
// are the same height and frame, set by the row, not by each caller. So:
//  1. `<CloseButton` appears only in ui/SheetHeader and PanelHeader. A ✕ that is not a header (an inline hint,
//     the slide player's exit, a touch-only close) is listed below with the reason; the list only shrinks.
//  2. A button in a SheetHeader's `actions` sets no `size`.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC, sourceFiles } from "./sources";

const OWNERS = ["components/ui/SheetHeader.tsx", "components/PanelHeader.tsx"];
// ratchet:list CLOSE_BUTTON_KEPT
const CLOSE_BUTTON_KEPT: Record<string, string> = {
  "components/HashtagScopeHint.tsx": "an inline hint's ✕ beside a line of text, not a header; keeps focus in the editor",
  "components/CommandPalette.tsx": "the ✕ ends the search field's row; the palette has no title row",
  "components/history/RewindPreview.tsx": "a touch-only close on a preview strip; no title row",
  "modules/slides/PresentationPlayer.tsx": "「Leave the slides」, a floating exit over a full-screen show",
};

const rel = (f: string) => relative(SRC, f);
const files = sourceFiles(".").filter((f) => f.endsWith(".tsx"));
const text = (f: string) => readFileSync(f, "utf8");

describe("sheet headers", () => {
  it("<CloseButton is used only by the shared headers and the listed non-headers", () => {
    const users = files.filter((f) => /<CloseButton\b/.test(text(f))).map(rel);
    expect(users.filter((f) => !OWNERS.includes(f) && !(f in CLOSE_BUTTON_KEPT)),
      "a dialog or sheet title row is <SheetHeader title onClose actions> from components/ui").toEqual([]);
    expect(Object.keys(CLOSE_BUTTON_KEPT).filter((f) => !users.includes(f)), "these no longer use <CloseButton — drop them").toEqual([]);
  });

  it("buttons in a SheetHeader's actions do not set size", () => {
    const bad = files.flatMap((f) => {
      const src = text(f);
      return [...src.matchAll(/<SheetHeader\b[\s\S]*?\/>/g)]
        .filter((m) => /\bsize=/.test(m[0]))
        .map((m) => `${rel(f)}:${src.slice(0, m.index).split("\n").length}`);
    });
    expect(bad, "the header sets the size of its actions").toEqual([]);
  });
});
