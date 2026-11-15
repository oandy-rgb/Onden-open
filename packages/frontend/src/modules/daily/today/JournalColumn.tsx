// The 今天 page's middle column: the day's note, with a box to write in it right here.
//
// The text is drawn read-only (DayNoteBody, as the Journal page draws it) and what is typed in the box
// below goes to the end of the note through the normal note writer (rssQuote.appendToNote: optimistic,
// sent or durably queued, merged with edits made elsewhere), exactly as 「記一下」 does in a side-by-side
// pane. The note editor itself is a single instance of the shell tied to the open note (two editors must
// never hold one note, decisions-ui 並排), so it is not embedded: 「開啟筆記」 opens it. A day with no note
// shows 「寫點什麼…」; nothing is made until the first line is added (then dayNotes.openDay creates the
// note, the single entry that does). A later day has no journal yet and none is started from here.

import { useRef, useState } from "react";
import { ExternalLink, PanelLeftClose } from "lucide-react";
import { Button, TextArea } from "../../../components/ui";
import { addToast } from "../../../lib/appStore";
import { dayNotes, writeErrors } from "../../../lib/data";
import { useT } from "../../../lib/i18n";
import { isEnterKey, isImeComposing } from "../../../lib/keys";
import { dayIdLabel } from "../../../lib/timeLabels";
import { loadRssQuote } from "../../index";
import DayNoteBody from "../day/DayNoteBody";
import { useDayNote } from "../day/useDayNote";

type Props = {
  date: string;
  today: string;
  onOpenNode: (id: string) => void;
  /** Fold the column away (the person does not keep a journal). Absent where it cannot be folded. */
  onFold?: () => void;
};

export default function JournalColumn({ date, today, onOpenNode, onFold }: Props) {
  const t = useT();
  const { nodes, day } = useDayNote(date);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const canWrite = date <= today;

  async function add() {
    const line = text.trim();
    if (!line || sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const target = day ?? (await dayNotes.openDay(date))?.node;
      if (!target) return;
      const result = await (await loadRssQuote()).appendToNote(target.id, line);
      setText("");
      if (result.status === "queued") addToast(writeErrors.queuedMessage(), "info");
    } catch (error) {
      // What was typed stays in the box.
      writeErrors.report(error, addToast);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="today-journal" aria-label={t("Journal")} data-date={date}>
      <header className="today-col-head">
        <h2 className="today-col-title">{t("Journal")}</h2>
        <span className="today-col-sub">{dayIdLabel(date, "long")}</span>
        {day && <Button variant="icon" size="sm" aria-label={t("Open {title}", { title: day.title })} title={t("Open note")} onClick={() => onOpenNode(day.id)}><ExternalLink size={14} aria-hidden="true" /></Button>}
        {onFold && <Button variant="icon" size="sm" aria-label={t("Fold the journal")} title={t("Fold the journal")} onClick={onFold}><PanelLeftClose size={14} aria-hidden="true" /></Button>}
      </header>
      <div className="today-journal-body">
        <DayNoteBody day={day} nodes={nodes} onOpenNode={onOpenNode}
          empty={canWrite ? null : <p className="today-journal-note">{t("This day has no journal yet.")}</p>} />
      </div>
      {canWrite && (
        <form className="today-journal-write" onSubmit={(event) => { event.preventDefault(); void add(); }}>
          <TextArea className="today-journal-input" rows={3} value={text} aria-label={t("Write something…")} placeholder={t("Write something…")}
            disabled={busy} aria-keyshortcuts="Control+Enter Meta+Enter" onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Enter is a new line; adding is Ctrl/⌘ + Enter, never while an input method is composing.
              if (isEnterKey(event) && (event.ctrlKey || event.metaKey) && !isImeComposing(event)) { event.preventDefault(); void add(); }
            }} />
          <div className="today-journal-actions">
            <Button type="submit" variant="primary" size="sm" disabled={busy || text.trim() === ""}>{t("Add to the journal")}</Button>
          </div>
        </form>
      )}
    </section>
  );
}
