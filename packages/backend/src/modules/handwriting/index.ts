import type { ModuleDefinition } from "../types.js";

// Handwriting (手寫): a way of seeing any note — a tab of its view row (layout "handwriting") that is a stack of
// fixed pages the person writes on. Like the slides' tab it owns no tables or routes: the tab is a stored view of the
// note, and its strokes are the note's own attribute `note_ink` (@onden/markdown NOTE_INK_ATTR), saved, synced, kept in
// history and backed up like any attribute — so removing the tab leaves them. Built in (no `library` card, no switch):
// it is how the pen is used on every note, as it already was on the whiteboard and in handwriting notes.
export const handwritingModule: ModuleDefinition = {
  id: "handwriting",
  registerRoutes: () => {},
  noteViewLayout: true,
};
