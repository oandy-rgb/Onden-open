// The few things the info panel's AI tab needs from the page itself (selection, scrolling, polling while the
// tab is visible), kept here so the tab's components stay free of window/document.

/** The text the person selected inside `root`, trimmed; "" when the selection is elsewhere. */
export function selectedTextWithin(root: HTMLElement | null): string {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? "";
  return text && root && selection?.anchorNode && root.contains(selection.anchorNode) ? text : "";
}

/** Scroll the note's AI suggestion bar to the top of the view. */
export function scrollToSuggestionBar(): void {
  requestAnimationFrame(() => document.querySelector(".ai-bar")?.scrollIntoView({ block: "start", behavior: "smooth" }));
}

/** Call `tick` every `ms` while the page is visible; returns the stop function. */
export function pollWhileVisible(tick: () => void, ms: number): () => void {
  const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") tick(); }, ms);
  return () => window.clearInterval(timer);
}
