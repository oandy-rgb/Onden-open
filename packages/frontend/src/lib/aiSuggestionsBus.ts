// The open note's AI suggestions are read by the editor (hooks/useAiSuggestions). Something else on the
// page can change them — the info panel's AI answer filing edits, or accepting them all at once — and
// tells the editor here, so its bar and its marks in the text read again. The inbox listens too: what
// waits for a decision (the review card of a suggestion) is read again when places were decided.

type Change = {
  nodeId: string;
  /** The note's text changed on the server (a place was accepted). */
  noteChanged: boolean;
  /** Set when the editor decided places itself and has already read them again. */
  fromEditor?: true;
};
const listeners = new Set<(change: Change) => void>();

export function announceSuggestionsChanged(nodeId: string, noteChanged = false, fromEditor = false): void {
  for (const listener of [...listeners]) listener({ nodeId, noteChanged, ...(fromEditor ? { fromEditor: true as const } : {}) });
}
export function onSuggestionsChanged(listener: (change: Change) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
