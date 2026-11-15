import { createContext, useContext, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useT } from "../lib/i18n";
import { Pressable, Sheet, SheetHeader } from "./ui";
import "./BoardPhoneNav.css";

// A phone's whiteboard is full screen for good (hooks/useBoardFullscreen `always`): the note's top bar, its
// tab row and the app's bottom bar are hidden, so the board's own top-left carries the way out.
//   · ‹  — the same step back as the note's top bar (NotesWorkspace `usePhoneBack`);
//   · the note's title ⌄ — a sheet with the note's view tabs and its Info / ⋯ actions.
// NotesWorkspace owns what these do and provides it here; BoardCornerControls draws them.
// With no provider (a board not inside the notes home) the board cannot be locked full screen.

export type BoardPhoneNavValue = {
  back: { onBack: () => void; label: string };
  title: string;
  /** The sheet's body; `close` shuts the sheet (after a tab was picked). */
  sheet: (close: () => void) => ReactNode;
};

const BoardPhoneNavContext = createContext<BoardPhoneNavValue | null>(null);
export const BoardPhoneNavProvider = BoardPhoneNavContext.Provider;
export const useBoardPhoneNav = () => useContext(BoardPhoneNavContext);

/** The title button at the top of a phone's full-screen board, and the sheet it opens. */
export function BoardNoteTitle({ title, sheet }: Pick<BoardPhoneNavValue, "title" | "sheet">) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <Pressable className="board-note-title" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="board-note-title__text">{title}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </Pressable>
      {open && (
        <Sheet label={t("View")} cardClassName="board-note-sheet" onClose={close}>
          <SheetHeader className="board-note-sheet__header" title={title} onClose={close} />
          {sheet(close)}
        </Sheet>
      )}
    </>
  );
}
