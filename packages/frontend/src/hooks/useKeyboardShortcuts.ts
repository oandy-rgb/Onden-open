import { useEffect, type Dispatch, type SetStateAction } from "react";
import { FIND_IN_NOTE_EVENT } from "../lib/findInNote";
import type { AppMode } from "./useUiMode";
import { matchShortcut } from "../lib/shortcuts";
import { isEscapeKey } from "../lib/keys";
import { openQuickCapture } from "../modules";

// A4 of the BuilderApp decomposition: the global keyboard-shortcut effect and
// the context-menu dismiss effect, lifted out of BuilderApp verbatim. Pure
// behaviour move. Must be called AFTER useNodeCreation (openDailyNote) at the
// call site, since the handler closes over it.
//
// WU-1: dispatch now runs through matchShortcut() against the SHORTCUTS single
// source of truth (lib/shortcuts) instead of an ad-hoc if-ladder, so the chords
// the dispatcher fires can never drift from what the palette / cheatsheet show.
// Each SHORTCUTS id maps to a handler below; chords with no entry (Escape's
// contextual dismiss, Delete/Backspace on a canvas card) keep their bespoke
// branches since they are mode-dependent and not single-chord commands.
//
// Delete/Backspace on a board is the board's own (KnowledgeWorkspace): it
// takes the selected cards off the board or deletes the selected arrows. It
// used to trash the selected card's NOTE from here.

type Params = {
  mode: AppMode;
  notesView: string;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  /** Cmd/Ctrl + N: make a plain note and open it (the sidebar's 「新筆記」). */
  createNote: () => unknown;
  canvasSearch: string;
  /** Single-board open (canvas-in-Editor) — board shortcuts apply. */
  boardOpen?: boolean;
  setCanvasSearch: Dispatch<SetStateAction<string>>;
  onOpenOverviewSearch: () => void;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setPaletteQuery: Dispatch<SetStateAction<string>>;
  setPaletteIndex: Dispatch<SetStateAction<number>>;
  saveOverviewDraft: () => Promise<unknown> | void;
  setOverviewView: Dispatch<SetStateAction<"edit" | "preview">>;
  openDailyNote: () => Promise<unknown> | void;
  /** Toggle the supporting pane (inspector) — bound to Cmd/Ctrl + . */
  toggleInspector?: () => void;
  /** Fold or open the notes list on its own — bound to Cmd/Ctrl + Shift + B. */
  toggleSidebar?: () => void;
  /** Open the current tab on the right, or close the right side — bound to Cmd/Ctrl + \ */
  toggleSplit?: () => void;
  /** Toggle focus / distraction-free writing mode — bound to Cmd/Ctrl + Alt + F */
  setFocusMode: Dispatch<SetStateAction<boolean>>;
  /** Alt + ← / → : the link trail's previous / next note (the top bar's 「上一頁」「下一頁」). */
  history?: { canGoBack: boolean; goBack: () => void; canGoForward: boolean; goForward: () => void };
};

export function useKeyboardShortcuts(p: Params) {
  const {
    mode, notesView, selectedId, setSelectedId, createOpen, setCreateOpen, createNote,
    canvasSearch, boardOpen = false, setCanvasSearch, onOpenOverviewSearch,
    setPaletteOpen, setPaletteQuery, setPaletteIndex,
    saveOverviewDraft, setOverviewView, openDailyNote,
    toggleInspector, toggleSidebar, toggleSplit, setFocusMode, history,
  } = p;

  useEffect(() => {
    const isEditingText = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
    };

    function onKey(e: KeyboardEvent) {
      // SHORTCUTS-driven dispatch: matchShortcut normalizes the event into a
      // canonical chord, finds the entry, and already drops bare-key chords
      // while a text field is focused, and a press the editor already handled
      // (defaultPrevented: bold, delete line, a card's save…). id → handler below; most handlers are
      // additionally mode-gated (the chord is global but the action only makes
      // sense in a particular view, so we let it fall through when out of
      // context rather than swallowing the key).
      const hit = matchShortcut(e);
      if (hit) {
        switch (hit.id) {
          case "open-palette":
            e.preventDefault();
            setPaletteOpen((o) => !o);
            setPaletteQuery("");
            setPaletteIndex(0);
            return;

          // F5.2 — Cmd+Shift+N opens QuickCapture; Cmd+Shift+D opens today's
          // daily note. Both are thesis "捕捉零摩擦" affordances. On desktop the
          // hotkey is the way in (the topbar has no capture button).
          case "quick-capture":
            e.preventDefault();
            openQuickCapture();
            return;
          case "daily-note":
            e.preventDefault();
            void openDailyNote();
            return;

          // Cmd+F — focus sidebar search (editor) or canvas search (canvas)
          case "focus-search":
            if (mode === "notes" && notesView === "editor") {
              e.preventDefault();
              // Focus inside the open note (e.g. its reading view): find in
              // the note; anywhere else keeps opening the sidebar search.
              if (document.activeElement?.closest(".note-document")) {
                window.dispatchEvent(new CustomEvent(FIND_IN_NOTE_EVENT));
                return;
              }
              onOpenOverviewSearch();
              return;
            }
            if (mode === "notes" && (notesView === "canvas" || boardOpen)) {
              e.preventDefault();
              setCanvasSearch((s) => s.trim() ? s : "​");
              return;
            }
            break;

          // Cmd+N — new note
          case "new-note":
            e.preventDefault();
            void createNote();
            return;

          // Cmd+S — save draft (notes editor mode, node selected)
          case "save-draft":
            if (mode === "notes" && notesView === "editor" && !boardOpen) {
              e.preventDefault();
              void saveOverviewDraft();
              return;
            }
            break;

          // Alt+← / Alt+→ — the link trail. Left to the browser's own history
          // while there is nowhere to go in the trail.
          case "nav-back":
            if (history?.canGoBack) { e.preventDefault(); history.goBack(); return; }
            break;
          case "nav-forward":
            if (history?.canGoForward) { e.preventDefault(); history.goForward(); return; }
            break;

          // Cmd+. — toggle the supporting pane (inspector), any mode. Mirrors the
          // topbar PanelRight button; safe inside text inputs (it's a command
          // chord, not a character).
          case "toggle-inspector":
            e.preventDefault();
            toggleInspector?.();
            return;

          // Cmd+Shift+B — fold or open the notes list alone (the top bar's left cell).
          case "toggle-sidebar":
            e.preventDefault();
            toggleSidebar?.();
            return;

          // Cmd+\ — side by side: open the current tab on the right, or close the right side.
          case "split-view":
            e.preventDefault();
            toggleSplit?.();
            return;

          // Cmd+Alt+F — toggle focus / distraction-free writing mode (notes editor).
          // A command chord, safe inside text inputs (the editor is where you
          // want it most). Mirrors the topbar Maximize button.
          case "focus-mode":
            if (mode === "notes" && notesView === "editor") {
              e.preventDefault();
              setFocusMode((v) => !v);
              return;
            }
            break;

          // Cmd+E — toggle Edit/Preview (notes editor mode)
          case "toggle-edit-preview":
            if (mode === "notes" && notesView === "editor") {
              e.preventDefault();
              setOverviewView((v) => (v === "edit" ? "preview" : "edit"));
              return;
            }
            break;

          // delete-node (Delete/Backspace) is handled by the open board; see
          // the header note.

          // shortcuts-help ("?") is rendered by WU-2's cheatsheet, which listens
          // for the key itself; nothing to dispatch here.
          default:
            break;
        }
      }

      // Escape — contextual dismiss. Not a single-chord SHORTCUTS command: it
      // clears search, canvas search, the create panel, or the canvas
      // selection depending on what's currently active.
      if (isEscapeKey(e) && mode === "notes" && (notesView === "canvas" || boardOpen) && canvasSearch) {
        setCanvasSearch("");
        return;
      }
      if (isEscapeKey(e) && !isEditingText()) {
        if (createOpen) { setCreateOpen(false); return; }
        if (selectedId && mode === "notes" && notesView === "canvas") { setSelectedId(null); return; }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, notesView, selectedId, createOpen, history?.canGoBack, history?.canGoForward]); // eslint-disable-line react-hooks/exhaustive-deps -- handler binds a snapshot of these; the omitted setters/handlers are stable and re-binding on each would thrash
}
