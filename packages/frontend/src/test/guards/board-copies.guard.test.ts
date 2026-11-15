// A note's whiteboard is a tab of the note (docs/architecture/canvas-as-view.md); no path
// makes another note to be "the board of" a note — that is what left the same-title copies
// migration 139 folded back. Creating a board note is for a new, untitled or imported board.
//
// A failure names the file: use ensureWhiteboardTab (lib/whiteboardTab.ts) for "give this note
// a board". An exception needs a reason, and one that no longer calls the writer fails too.
import { describe, expect, it } from "vitest";
import { findUses, sourceFiles } from "./sources";

const CREATE = /\b(createCanvas|canvasWriter\.create)\(/;
// ratchet:list EXCEPTIONS
const EXCEPTIONS: Record<string, string> = {
  "hooks/useCanvasActions.ts": "importing a JSON Canvas file makes the new board note the file stands for",
  "hooks/useWorkspaceFocus.ts": "createBoard: a new, untitled board the person asked for",
  "hooks/useNodeCreation.ts": "the create menu's 白板: a new, untitled board",
  "lib/createKinds.ts": "the create kinds: a new, untitled board (the environment decides where it goes)",
};

describe("no path makes a board note for an existing note", () => {
  const files = sourceFiles(".");
  it("only the listed places create a board note, and none names it after another note", () => {
    const uses = findUses(files, CREATE, Object.keys(EXCEPTIONS));
    expect(uses, "use ensureWhiteboardTab for a note's own board").toEqual([]);
    const stale = Object.keys(EXCEPTIONS).filter((rel) => findUses(files.filter((f) => f.endsWith(rel)), CREATE).length === 0);
    expect(stale, "these exceptions no longer create a board").toEqual([]);
    expect(findUses(files, /\b(createCanvas|canvasWriter\.create)\([^)]*(\.title|\bnode\b|Canvas`)/), "a board named after a note").toEqual([]);
  });
});
