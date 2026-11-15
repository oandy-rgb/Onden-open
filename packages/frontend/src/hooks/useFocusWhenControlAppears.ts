import { useEffect, type RefObject } from "react";

const CONTROL = "input, textarea, select, [contenteditable='true'], button";

/**
 * While `active`, puts the caret in the first control that shows up inside `scope`, once.
 *
 * Why an observer and not "try for N frames": the control is code-split, and on a slow phone or a busy
 * machine it can arrive after any fixed number of tries; then the press that opened it would leave no
 * caret and the typing would go nowhere. The control being mounted is the event, so this waits for
 * exactly that (a DOM insertion into `scope`), however long it takes, and holds nothing while idle.
 *
 * Callers turn it on only for "the person just pressed this to edit it" (FeaturedFields), never for
 * controls that are simply on screen (the tag card), where taking focus would be wrong. If focus is
 * already on something else by the time the control appears (the person tapped elsewhere), it is left
 * alone. The pressed cell unmounts, so focus is on `body` (or inside `scope`) in the normal case.
 */
export function useFocusWhenControlAppears(scope: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const root = scope.current;
    if (!active || !root) return;
    const tryFocus = (): boolean => {
      const control = root.querySelector<HTMLElement>(CONTROL);
      if (!control) return false;
      const current = root.ownerDocument.activeElement;
      const elsewhere = current && current !== root.ownerDocument.body && !root.contains(current);
      if (!elsewhere) control.focus();
      return true;
    };
    if (tryFocus()) return;
    const observer = new MutationObserver(() => { if (tryFocus()) observer.disconnect(); });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [scope, active]);
}
