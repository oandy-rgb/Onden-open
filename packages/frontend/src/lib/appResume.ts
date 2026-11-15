export type ResumeSignal = "visible" | "online" | "focus";

/** Runs `check` when the person comes back to the app: the tab becomes visible
 *  (phone unlocked, tab switched back), the network returns, or the window
 *  regains focus. The one place that listens for these (the connection state
 *  itself stays in lib/data/connectivity.ts). `signals` picks which of the
 *  three count; the default is visible + online. Returns the undo. */
export function onAppResume(
  check: () => void,
  signals: readonly ResumeSignal[] = ["visible", "online"],
): () => void {
  const onVisibility = () => { if (document.visibilityState !== "hidden") check(); };
  const off: Array<() => void> = [];
  if (signals.includes("visible")) {
    document.addEventListener("visibilitychange", onVisibility);
    off.push(() => document.removeEventListener("visibilitychange", onVisibility));
    // A page restored from the back/forward cache (phone browsers) may not fire visibilitychange.
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) check(); };
    window.addEventListener("pageshow", onPageShow);
    off.push(() => window.removeEventListener("pageshow", onPageShow));
  }
  if (signals.includes("online")) {
    window.addEventListener("online", check);
    off.push(() => window.removeEventListener("online", check));
  }
  if (signals.includes("focus")) {
    window.addEventListener("focus", check);
    off.push(() => window.removeEventListener("focus", check));
  }
  return () => { for (const f of off) f(); };
}
