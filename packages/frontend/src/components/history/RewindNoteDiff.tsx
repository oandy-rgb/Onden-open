// One note, then against now, in paragraphs — inside the rewind preview. Reads the two texts only when opened.
import { useT } from "../../lib/i18n";
import { LoadError } from "../ui";
import { fetchNoteAt } from "../../lib/history";
import { useHistorySpace } from "./historySpace";
import { failed, useLoad } from "./useLoad";
import EmptyState from "../EmptyState";
import { TextCompare } from "../compare";
import type { NoteAt } from "@onden/contract";

export default function RewindNoteDiff({ noteId, at, online }: { noteId: string; at: string; online: boolean }) {
  const t = useT();
  const { spaceId } = useHistorySpace();
  const [note, reload] = useLoad(() => fetchNoteAt(noteId, at, spaceId), [noteId, at, spaceId]);
  if (note.status === "loading") return <EmptyState size="inline" title={t("Loading…")} />;
  if (failed(note) || note.status === "error") {
    return <LoadError failed={t("Couldn't load the history.")} online={online} onRetry={reload} />;
  }
  return <NoteThenNow note={note.value} />;
}

function NoteThenNow({ note }: { note: NoteAt }) {
  const t = useT();
  if (note.status === "created_since") return <p className="wh-rewind-diff-note">{t("This note didn't exist yet then.")}</p>;
  if (note.markdown_then === null) return <p className="wh-rewind-diff-note">{t("The text from then is no longer stored.")}</p>;
  if (note.status === "deleted_since") {
    return (
      <div className="wh-rewind-diff">
        <p className="wh-rewind-diff-label">{t("How it looked then")}</p>
        <p className="wh-rewind-diff-text">{note.markdown_then.trim() || t("This version has no text.")}</p>
      </div>
    );
  }
  const retitled = note.title_then !== note.title_now;
  return (
    <div className="wh-rewind-diff">
      {retitled && (
        <p className="wh-rewind-diff-note">
          {t("The title was “{then}”, now “{now}”.", { then: note.title_then, now: note.title_now })}
        </p>
      )}
      {note.markdown_then === note.markdown_now
        ? !retitled && <p className="wh-rewind-diff-note">{t("The text is the same as now.")}</p>
        : <TextCompare before={note.markdown_then} after={note.markdown_now} beforeLabel={t("Then")} afterLabel={t("Now")} />}
    </div>
  );
}
