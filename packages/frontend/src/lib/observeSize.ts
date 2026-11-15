/** Calls `onResize` whenever any of `targets` changes size, and returns the stop function. The one
 *  place that creates a `ResizeObserver`: where the browser has none (old WebViews, jsdom) nothing is
 *  observed and the stop function does nothing, so callers read the size once themselves and need
 *  no environment check. */
export function observeSize(
  targets: Element | null | undefined | ReadonlyArray<Element | null | undefined>,
  onResize: (entries: ResizeObserverEntry[]) => void,
): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(onResize);
  for (const target of Array.isArray(targets) ? targets : [targets]) if (target) observer.observe(target);
  return () => observer.disconnect();
}
