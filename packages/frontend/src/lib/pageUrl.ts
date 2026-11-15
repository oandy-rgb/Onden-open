// The page's address, read and tidied. The only place besides hooks/useUrlLocation (which owns where the app is)
// and lib/api that touches window.location / window.history: one-shot query parameters that arrive from outside
// (a share, an invite link) are taken here and removed from the address bar.

/** The address bar's query parameters, as a copy (changing it changes nothing). */
export function readUrlParams(): URLSearchParams {
  return new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
}

/** Open this same page again with a different query (`"?temp=1"`): a new page load, not a change inside the app. */
export function reopenWithQuery(search: string): void {
  window.location.assign(window.location.pathname + search);
}

/** Remove these query parameters from the address bar without adding a history entry or reloading
 *  (a reload or a shared screenshot must not carry them on). */
export function stripUrlParams(names: readonly string[]): void {
  const params = readUrlParams();
  for (const name of names) params.delete(name);
  const rest = params.toString();
  window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash);
}

/** The page's own origin, "" where there is no page (tests, workers). */
export function pageOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/** The app restores the page scroll itself (lib/pageScrollRestore), so the browser must not: on Back it puts the page
 *  at the position it saved for the entry a moment after the app did, and the screen jumps. Returns the undo. */
export function ownPageScrollRestoration(): () => void {
  if (typeof window === "undefined" || !("scrollRestoration" in window.history)) return () => {};
  const before = window.history.scrollRestoration;
  window.history.scrollRestoration = "manual";
  return () => { window.history.scrollRestoration = before; };
}
