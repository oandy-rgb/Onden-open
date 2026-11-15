// An event from a subscribed calendar, opened from the timeline or the week board:
// when, where, what it says and which calendar it comes from. Nothing here edits
// the event (the calendar is the owner); 「記筆記」 makes a note about it.

import { useState, type CSSProperties } from "react";
import { Button, Sheet } from "../../../../components/ui";
import { addToast, useNode } from "../../../../lib/appStore";
import { noteWriter, writeErrors } from "../../../../lib/data";
import { displayTitle } from "../../../../lib/noteLabel";
import { eventNoteId, type ExternalEvent } from "../../../../lib/externalCalendars";
import { useT } from "../../../../lib/i18n";
import { eventClock, eventDays, eventNoteBody } from "./eventText";
import "../strings";
import "./external.css";

type Props = { event: ExternalEvent; onClose: () => void; onOpenNode: (id: string) => void };

export default function ExternalEventSheet({ event, onClose, onOpenNode }: Props) {
  const t = useT();
  const noteId = eventNoteId(event);
  const note = useNode(noteId);
  const hasNote = !!note && !note.deleted_at;
  const [busy, setBusy] = useState(false);

  async function takeNote() {
    if (busy) return;
    if (!hasNote) {
      setBusy(true);
      try {
        // The id comes from the event, so a second press (or another device) finds the same note.
        await noteWriter.create({
          id: noteId, title: displayTitle(event.title),
          markdown: eventNoteBody(event, t("All day"), t("Place: ")),
        });
      } catch (e) {
        writeErrors.report(e, addToast);
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    onClose();
    onOpenNode(noteId);
  }

  const clock = event.all_day ? t("All day") : eventClock(event);
  return (
    <Sheet label={displayTitle(event.title)} onClose={onClose} cardClassName="ext-sheet">
      <div className="ext-sheet-body">
        <h3 className="ext-sheet-title">{displayTitle(event.title)}</h3>
        <p className="ext-sheet-when">{[eventDays(event), clock].filter(Boolean).join(" · ")}</p>
        {event.location && <p className="ext-sheet-line">{event.location}</p>}
        {event.description && <p className="ext-sheet-description">{event.description}</p>}
        <p className="ext-sheet-from"><span className="ext-dot" style={{ "--ext-color": event.color } as CSSProperties} aria-hidden="true" />{t("From {calendar}", { calendar: event.calendar_name })}</p>
        <div className="ext-sheet-actions">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void takeNote()}>{hasNote ? t("Open the note") : t("Take notes")}</Button>
          <Button variant="ghost" size="sm" onClick={onClose}>{t("Close")}</Button>
        </div>
      </div>
    </Sheet>
  );
}
