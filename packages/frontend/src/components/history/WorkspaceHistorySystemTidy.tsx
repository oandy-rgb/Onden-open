// 「系統整理」in the day's feed: one line for a pass of the system over notes' text that no person edited (old paragraph
// marks moved out of the text, or written back). Not a row per note — the notes are listed only when opened, by title.
// Nothing here is undoable: a person did not do it, and the paragraphs and links it touched read the same.
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { timeLabel } from "../../lib/timeLabels";
import { displayTitle } from "../../lib/noteLabel";
import type { DayTidy } from "@onden/contract";
import { Pressable } from "../ui";

type Props = {
  tidy: DayTidy;
  /** Opens that note's history for the day (a row of the list). */
  onOpenNote: (noteId: string) => void;
  selectedNoteId?: string | null;
};

export default function WorkspaceHistorySystemTidy({ tidy, onOpenNote, selectedNoteId = null }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const n = tidy.notes.length;
  const summary = tidy.kind === "marks_written_back"
    ? t("The system wrote the paragraph marks back into {n} notes", { n })
    : t("The system tidied the paragraph marks in {n} notes", { n });
  return (
    <article className="wh-run wh-tidy-card" aria-label={summary}>
      <header className="wh-run-head">
        <span className="wh-run-tag">{t("System tidy-up")}</span>
        <span className="wh-run-when">{timeLabel(tidy.at)}</span>
      </header>
      <p className="wh-run-summary">{summary}</p>
      <p className="wh-note-meta">{t("Nothing you wrote changed: only how the paragraphs are kept behind the scenes.")}</p>
      <Pressable type="button" className="wh-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? t("Hide the notes") : t("Show which notes")}
      </Pressable>
      {open && (
        <ul className="wh-run-notes">
          {tidy.notes.map((note) => (
            <li key={note.id}>
              <Pressable type="button" className={"wh-note-link wh-touch" + (note.id === selectedNoteId ? " selected" : "")} aria-current={note.id === selectedNoteId || undefined} onClick={() => onOpenNote(note.id)}>
                <span className="wh-note-titleline"><span className="wh-note-title">{displayTitle(note.title)}</span></span>
              </Pressable>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
