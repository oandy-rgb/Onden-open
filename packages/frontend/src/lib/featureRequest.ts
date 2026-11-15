// Open a built-in function's page from anywhere (a Settings › Modules card's
// 「打開」) — the shell owns navigation (hooks/useWorkspaceModules), so this is
// a request it hears, like lib/settingsRequest does for Settings.
const EVENT = "onden:open-feature";

export function requestOpenFeature(moduleId: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: moduleId }));
}

/** The shell's listener; returns the unsubscribe. */
export function onFeatureRequest(open: (moduleId: string) => void): () => void {
  const handler = (event: Event) => open((event as CustomEvent<string>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
