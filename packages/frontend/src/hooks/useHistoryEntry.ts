import { useEffect, useRef } from "react";
import { dropStaleOverlayMarker, onHistoryPop, overlayEntryShown, popOverlayEntry, pushOverlayEntry } from "./useUrlLocation";

/** While `active`, one history entry (same address) lets Back return from a detail screen (a reader's
 *  article, a phone settings level) to its list; `onBack` runs then. `leave` drops the entry when the
 *  screen's own back button is used. Previous/next inside the screen keep `active` true: no new entry.
 *  The entry stays a page of its own after the screen closed by anything but `leave` (a note opened from it, Back): going
 *  Back or Forward onto it calls `reopen`, which shows the screen again; without `reopen` the entry shows the page. */
export function useHistoryEntry(active: boolean, onBack: () => void, marker: string, reopen?: () => void) {
  const pushed = useRef(false);
  const mounted = useRef(true);
  const back = useRef(onBack);
  back.current = onBack;
  const markerRef = useRef(marker);
  markerRef.current = marker;
  const reopenRef = useRef(reopen);
  reopenRef.current = reopen;
  // The screen is closed while its entry was not taken off: that entry is behind the page now shown, no longer the screen's own.
  useEffect(() => { if (!active) pushed.current = false; }, [active]);
  // A reload: the entry of a screen that no longer exists.
  useEffect(() => { if (!active) dropStaleOverlayMarker(markerRef.current); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount only
  useEffect(() => {
    if (!active || pushed.current) return;
    pushOverlayEntry(marker);
    pushed.current = true;
  }, [active, marker]);
  useEffect(() => {
    const onPop = () => {
      // Back (or `leave`) took a step off a screen opened over this one (an article's linked page over the article):
      // this entry is still the one shown, and this screen stays.
      const shown = overlayEntryShown(markerRef.current);
      if (!pushed.current) {
        // Back or Forward onto this screen's own entry after it was closed: the screen comes back.
        if (shown && reopenRef.current) { pushed.current = true; reopenRef.current(); }
        return;
      }
      if (shown) return;
      pushed.current = false;
      back.current();
    };
    const stopPop = onHistoryPop(onPop);
    mounted.current = true;
    return () => {
      stopPop();
      mounted.current = false;
      // Deferred: StrictMode remounts at once, and then keeps the entry.
      setTimeout(() => {
        if (mounted.current || !pushed.current) return;
        pushed.current = false;
        // Only while the entry is still the one shown: a move made since (a link opened from
        // the screen, another place) is the page now, and Back must not undo it.
        if (overlayEntryShown(markerRef.current)) popOverlayEntry();
      }, 0);
    };
  }, []);
  return {
    leave: () => {
      if (!pushed.current) return;
      pushed.current = false;
      popOverlayEntry();
    },
    /** From `onBack`: Back went one step back inside the screen (to the page that opened this
     *  one), which stays open, so the next Back needs the entry again. */
    again: () => {
      if (pushed.current) return;
      pushOverlayEntry(markerRef.current);
      pushed.current = true;
    },
  };
}
