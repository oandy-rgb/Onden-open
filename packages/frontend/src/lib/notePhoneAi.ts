import { useSyncExternalStore } from "react";

// Where the phone's AI panel stands for the open note (docs/agents/decisions-ai-collaboration.md, 手機的 AI 面板).
// The panel is a bottom panel over the note with three heights; this is the only place that knows which one.
// It is tiny on purpose: the top bar's button and the host that mounts the panel load with the note, the panel
// itself (components/infoAi) only once it was opened. The state belongs to one note and one visit: another
// note shows nothing of it, and nothing is stored.

type NoteAiHeight = "bar" | "half" | "full";
/** `dismissed`: the person took the bar away; it comes back by itself only while an answer is pending. */
type State = { noteId: string; height: NoteAiHeight; dismissed: boolean } | null;

let state: State = null;
const listeners = new Set<() => void>();
const set = (next: State) => { state = next; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The panel of this note, or null when it was never opened for it in this visit. */
export function useNoteAiPanel(noteId: string): { height: NoteAiHeight; dismissed: boolean } | null {
  const now = useSyncExternalStore(subscribe, () => state, () => null);
  return now && now.noteId === noteId ? now : null;
}

/** The top bar's button: nothing or the bar opens half height; an open panel goes down to the bar. */
export function toggleNoteAi(noteId: string): void {
  const now = state && state.noteId === noteId ? state : null;
  if (!now || now.dismissed || now.height === "bar") set({ noteId, height: "half", dismissed: false });
  else set({ noteId, height: "bar", dismissed: false });
}

export function setNoteAiHeight(noteId: string, height: NoteAiHeight): void {
  set({ noteId, height, dismissed: false });
}

/** The bar's ✕ (and the panel's own): out of sight until the button or a pending answer brings it back. */
export function dismissNoteAi(noteId: string): void {
  set({ noteId, height: "bar", dismissed: true });
}

