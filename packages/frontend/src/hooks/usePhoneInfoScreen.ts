import { useCallback, useRef } from "react";
import type { OverviewMobileTab } from "./useUiMode";
import { useHistoryEntry } from "./useHistoryEntry";
import { overlayEntryShown } from "./useUrlLocation";

const INFO_MARKER = "ondenNoteInfo";

/** The phone's Info screen is a page of its own: while it shows, one history entry lets system Back return
 *  to the note's content (same note). `closeInfo` is the on-screen ‹ (it drops that entry); give
 *  `setNoteFromHistory` to useUrlSync so Back/forward onto another note also leaves Info, since Info
 *  belongs to the note it was opened on. */
export function usePhoneInfoScreen(
  { phone, tab, selectedId, setTab, setSelectedId }: {
    phone: boolean;
    tab: OverviewMobileTab;
    selectedId: string | null;
    setTab: (tab: OverviewMobileTab) => void;
    setSelectedId: (id: string | null) => void;
  },
) {
  const entry = useHistoryEntry(phone && tab === "info", () => setTab("edit"), INFO_MARKER, () => setTab("info"));
  const shownNoteId = useRef(selectedId);
  shownNoteId.current = selectedId;
  const setNoteFromHistory = useCallback((id: string | null) => {
    // Another note leaves Info (it belongs to the note it was opened on), unless the entry arrived at is Info's own: that brings it back.
    if (id !== shownNoteId.current && !overlayEntryShown(INFO_MARKER)) setTab("edit");
    setSelectedId(id);
  }, [setTab, setSelectedId]);
  const closeInfo = () => { entry.leave(); setTab("edit"); };
  return { closeInfo, setNoteFromHistory };
}
