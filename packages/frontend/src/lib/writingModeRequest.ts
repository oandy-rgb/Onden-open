// 「寫作模式」 lives in the open note's editor (useZenMode). The command palette
// and the ⋯ menu are elsewhere, so entering it is a request the editor hears.

const EVENT = "onden-enter-writing-mode";

export function requestWritingMode(): void {
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** The editor's listener; returns the unsubscribe. */
export function onWritingModeRequest(enter: () => void): () => void {
  window.addEventListener(EVENT, enter);
  return () => window.removeEventListener(EVENT, enter);
}
