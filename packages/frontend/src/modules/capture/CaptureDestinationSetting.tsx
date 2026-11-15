// Settings: where a capture goes when the person names no place. One choice,
// kept for the account: the inbox (the default), today's journal (only while
// the journal is on) or one note. A capture can still be sent somewhere else
// one time from the capture sheet; that never changes this.

import { useState } from "react";
import { useAllNodes } from "../../lib/appStore";
import { useT } from "../../lib/i18n";
import { useDailyNotesEnabled } from "../../hooks/useModuleFilter";
import { Button } from "../../components/ui";
import type { SettingContext } from "../../lib/settingsTypes";
import CaptureWherePicker from "./CaptureWherePicker";
import { captureDestinationPref, captureDestinationWords, destinationOf, storedOf } from "./captureDestination";
import { usableDestination } from "./captureDestination";
import { canHoldNewNotes } from "../../lib/newNoteTarget";

export default function CaptureDestinationSetting({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const nodes = useAllNodes();
  const journalOn = useDailyNotesEnabled();
  const { value, save } = captureDestinationPref.useValue();
  const [picking, setPicking] = useState(false);
  const wanted = destinationOf(value);
  // What happens now: a journal that is off, or a note that is gone, reads as the inbox.
  const usable = usableDestination(wanted, {
    journalOn,
    noteCanHold: (id) => { const note = nodes.find((n) => n.id === id); return !!note && canHoldNewNotes(note); },
  });
  const fellBack = usable.kind !== wanted.kind || (usable.kind === "note" && wanted.kind === "note" && usable.noteId !== wanted.noteId);

  return (
    <div className="capture-destination">
      <p className="settings-hint">{t("Captures go to: {place}", { place: captureDestinationWords(usable, nodes) })}</p>
      {fellBack && <p className="settings-hint">{t("The place you chose is not available now, so captures go to the inbox.")}</p>}
      <div className="settings-row settings-row--actions">
        <Button type="button" variant="secondary" onClick={() => setPicking((open) => !open)} aria-expanded={picking}>
          {t("Change…")}
        </Button>
        {wanted.kind !== "inbox" && (
          <Button type="button" variant="ghost" onClick={() => { save("inbox"); setPicking(false); }}>{t("Use the inbox")}</Button>
        )}
      </div>
      {picking && (
        <CaptureWherePicker online={ctx.online} nodes={nodes} current={wanted} journalOn={journalOn}
          onPick={(next) => { save(storedOf(next)); setPicking(false); }} onClose={() => setPicking(false)} />
      )}
    </div>
  );
}
