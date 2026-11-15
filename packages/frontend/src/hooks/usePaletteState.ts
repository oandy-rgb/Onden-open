// The ⌘K palette's open / query / highlighted-row state, kept apart from the
// palette's engine (hooks/useCommandPalette: its actions, search and ranking).
// The shortcuts and the top bar only open and close the palette, so they need
// this much at boot; the engine arrives with the palette's own lazy chunk
// (components/workspace/PaletteHost).
import { useState } from "react";

export function usePaletteState() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  return { paletteOpen, setPaletteOpen, paletteQuery, setPaletteQuery, paletteIndex, setPaletteIndex };
}

export type PaletteState = ReturnType<typeof usePaletteState>;

/** Asks the editor host to open the selected note's history dialog. */
export const OPEN_NOTE_HISTORY_EVENT = "onden-open-note-history";
