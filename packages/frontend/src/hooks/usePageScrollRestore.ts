import { useEffect, useLayoutEffect, useRef } from "react";
import { ownPageScrollRestoration } from "../lib/pageUrl";
import { arriveAtScreen, watchScrolling } from "../lib/pageScrollRestore";
import { hasPendingCursor } from "../lib/cursorHandoff";
import { hasPendingFind } from "../lib/findInNote";
import { pendingReveal } from "../lib/noteReveal";
import { currentEntryId } from "./useUrlLocation";

/** The opening asks for a place of its own in this note (a line to reveal, words to find, a caret handoff). */
const asksForPlace = (noteId: string | null): boolean =>
  noteId !== null && (pendingReveal(noteId) !== null || hasPendingFind(noteId) || hasPendingCursor(noteId));

/**
 * Back and Forward return the page to where its history entry was left (see lib/pageScrollRestore). `screen`
 * names what the entry shows (the list, or one note) and `noteId` the note, if one. Call it after `useUrlSync`
 * in the same component: its passive effect writes the entry a new screen belongs to, and this one reads it.
 */
export function usePageScrollRestore(screen: string, noteId: string | null): void {
  const here = useRef<{ entry: string; screen: string } | null>(null);

  // The app owns the page's scroll: the browser's own restoring would move it again after the app did.
  useEffect(() => {
    const releaseRestoration = ownPageScrollRestoration();
    const stopWatching = watchScrolling(() => here.current);
    return () => { releaseRestoration(); stopWatching(); };
  }, []);

  // Layout effect: put the position back before the browser paints, or the screen shows for a frame at the wrong
  // place. Until the entry is known (the effect below), what scrolls is not this screen's: a clamp to the shorter
  // page must not be recorded under the entry just left.
  useLayoutEffect(() => {
    here.current = null;
    return arriveAtScreen({ entry: currentEntryId(), screen, noteId, explicitTarget: asksForPlace(noteId) });
  }, [screen, noteId]);

  useEffect(() => {
    const entry = currentEntryId();
    here.current = entry === null ? null : { entry, screen };
  }, [screen]);
}
