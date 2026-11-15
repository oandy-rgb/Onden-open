import { useEffect, useRef } from "react";
import { useLiveEventLog } from "./useLiveEventLog";
import { addToast } from "../lib/appStore";
import { t } from "../lib/i18n";
import { drafts } from "../lib/data";
import { leftOutOwnText, type BodyConflictPayload } from "../lib/bodyConflict";

/** Tell the tab whose text lost a same-words conflict (another tab or another
 *  account saved over it): its editor just shows the other body, so without
 *  this the words would vanish unannounced. The text itself is in the note's
 *  version history; the inbox lists it with the choice to put it back. */
export function useBodyConflictNotice(): void {
  const { events } = useLiveEventLog({
    query: { event_type: "BODY_CONFLICT", limit: "20" },
    intervalMs: 10_000,
    maxEvents: 50,
  });
  const lastSeenRef = useRef(0);
  useEffect(() => {
    // The first batch is history, not news.
    if (lastSeenRef.current === 0 && events.length > 0) {
      lastSeenRef.current = events[0]!.id;
      return;
    }
    const fresh = events.filter((e) => e.id > lastSeenRef.current).sort((a, b) => a.id - b.id);
    for (const e of fresh) {
      lastSeenRef.current = e.id;
      if (leftOutOwnText(drafts.acceptedBody(e.target_id), e.payload as unknown as BodyConflictPayload)) {
        addToast(t("Someone changed the same text at the same time. Your version is saved in the note's history."), "info");
      }
    }
  }, [events]);
}
