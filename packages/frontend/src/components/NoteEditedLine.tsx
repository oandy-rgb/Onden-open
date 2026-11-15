import { t, tn } from "../lib/i18n";
import { agoLabel, dateLabel } from "../lib/timeLabels";
import { Pressable } from "./ui";

/** What opens the note's history. `since` (ISO time) asks the history view to
 *  land on the step after that moment; a view that does not know it opens as usual. */
export type OpenNoteHistory = (opts?: { since?: string }) => void;

/** 「8 天前修改」 under the title. With a way to open history the whole phrase
 *  is the link (like 「上次編輯」 in Google Docs); without one (read-only
 *  contexts, no saved versions) it is plain text. */
export default function NoteEditedLine({ updatedAt, onOpenHistory, aiEdits = 0 }: {
  updatedAt: string;
  onOpenHistory?: OpenNoteHistory;
  /** Times an AI changed the note: 「· AI 改過 N 次」 joins the phrase (and the link). */
  aiEdits?: number;
}) {
  const ago = agoLabel(updatedAt);
  const aiNote = aiEdits > 0 ? tn("AI edited it once", "AI edited it {n} times", aiEdits) : "";
  const time = (
    <>
      <time dateTime={updatedAt} title={dateLabel(updatedAt, "dateTime")}>{t("Edited {ago}", { ago })}</time>
      {aiNote && <> · <span className="note-edited-ai">{aiNote}</span></>}
    </>
  );
  return (
    <span className="note-edited-line">
      {onOpenHistory ? (
        <Pressable type="button" className="note-history-link tap-target" onClick={() => onOpenHistory()}
          aria-label={t("Edited {ago}, open this note's history", { ago }) + (aiNote ? `, ${aiNote}` : "")}>
          {time}
        </Pressable>
      ) : time}
    </span>
  );
}
