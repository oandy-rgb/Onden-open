// The right column of 「變更」: the selected note's time slider (NoteHistory, inline), opened on
// how the note looked at the end of the row's day.
import { useEffect } from "react";
import { nodeNeedsBody } from "../../lib/api";
import { useAppSelector, useAllNodes } from "../../lib/appStore";
import { dataSync } from "../../lib/data";
import { useT } from "../../lib/i18n";
import NoteHistory from "./NoteHistory";
import EmptyState from "../EmptyState";

type Props = {
  noteId: string;
  /** YYYY-MM-DD: open on the end of this day. */
  day: string;
  online: boolean;
  onOpenNote: (noteId: string) => void;
  /** A restore or copy changed the workspace: the list beside this reads again. */
  onChanged: () => void;
};

export default function WorkspaceHistoryNotePane({ noteId, day, online, onOpenNote, onChanged }: Props) {
  const t = useT();
  const nodes = useAllNodes();
  const node = nodes.find((n) => n.id === noteId) ?? null;
  // The text being typed, when this is the note open in the editor.
  const draft = useAppSelector((s) => s.selectedId === noteId ? s.overviewDraft : null);
  const needsBody = nodeNeedsBody(node);
  useEffect(() => { if (needsBody) void dataSync.hydrateNode(noteId); }, [needsBody, noteId]);

  if (!node) return <EmptyState size="inline" className="wh-detail-empty" title={t("This note's text is not available here yet.")} />;
  if (needsBody) return <EmptyState size="inline" className="wh-detail-empty" title={t("Loading…")} />;
  return (
    <NoteHistory
      key={`${noteId}|${day}`}
      inline
      node={node}
      initialDay={day}
      currentMarkdown={draft ?? node.markdown}
      nodes={nodes}
      from={node}
      online={online}
      onOpenNote={onOpenNote}
      onChanged={onChanged}
    />
  );
}
