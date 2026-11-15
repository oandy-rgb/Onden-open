// What the browser window tells us that is not the address bar, history or
// media queries (those have their own owners: hooks/useUrlLocation, hooks/useIsMobile).
// Screens ask here instead of touching `window` (allowlist: screens do not touch window).

/** Device pixel ratio, 1 when unknown. */
export function pixelRatio(): number {
  return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

/** A browser-provided global that has no TypeScript type (`webkitSpeechRecognition`, `__API_BASE__`). */
export function windowGlobal<T>(name: string): T | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as Record<string, T | undefined>)[name];
}
