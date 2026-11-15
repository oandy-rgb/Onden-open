/** Runs `flush` when the page is going away: `pagehide` covers close and
 *  navigation, `visibilitychange` to hidden covers a mobile app switch (where
 *  pagehide may never fire before the process is killed). Returns the undo. */
export function onPageHide(flush: () => void): () => void {
  const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** The browser's own "leave this page?" question, asked only while `shouldWarn()` is true (the temporary session has
 *  writing that was not downloaded). The browser shows its fixed wording; a page cannot change it. Returns the undo. */
export function warnBeforeLeaving(shouldWarn: () => boolean): () => void {
  const ask = (event: BeforeUnloadEvent) => {
    if (!shouldWarn()) return;
    event.preventDefault();
    event.returnValue = ""; // older engines read this instead of preventDefault
  };
  window.addEventListener("beforeunload", ask);
  return () => window.removeEventListener("beforeunload", ask);
}
