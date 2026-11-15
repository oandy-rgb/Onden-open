// A rewind in the feed: 「還原到 10/23 下午06:00 · N 篇」, in the shape of an AI run's card, with the
// notes it touched and 「復原這次還原」. The undo is a new operation under the person's current rights
// (rewind.ts): what they wrote after the rewind stays, a line both changed goes to the inbox.
import { historyWriter } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { timeLabel } from "../../lib/timeLabels";
import type { DayRewind } from "@onden/contract";
import WorkspaceHistoryUndoCard, { type UndoCardText } from "./WorkspaceHistoryUndoCard";
import { whenLabel } from "./rewindCut";

type Props = {
  rewind: DayRewind;
  online: boolean;
  onOpenInbox: () => void;
  onNotice: (message: string) => void;
  /** The rewind was undone: the feed reads again. */
  onChanged: () => void;
  /** Dimmed: it happened after the point being looked at (it would be undone by a rewind to there). */
  afterCut?: boolean;
};

export default function WorkspaceHistoryRewindCard({ rewind, online, onOpenInbox, onNotice, onChanged, afterCut = false }: Props) {
  const t = useT();
  const title = t("Restored to {when} · {n} notes", { when: whenLabel(rewind.to), n: rewind.notes.length });
  const kindLabel = { restore: t("Text restored"), undelete: t("Brought back"), delete: t("Moved to Recently deleted") } as const;
  const text: UndoCardText = {
    tag: t("Restore"), when: timeLabel(rewind.at), ariaLabel: title, summary: title,
    undoButton: t("Undo this restore"),
    sheetTitle: t("Undo this restore"),
    sheetExplain: t("Checked notes go back to how they were before the restore. Paragraphs you changed afterwards are kept; ones both of you changed wait in your inbox under “Waiting for your decision”."),
    confirm: (n) => t("Undo {n} notes", { n }),
    undoneLine: (undone) => undone ? t("Undone · notes are back to how they were before the restore") : t("Partly undone"),
    keptLine: (n) => t("{n} notes were changed again after the restore and were left as they are", { n }),
    undoneNotice: (n) => t("Undid the restore of {n} notes", { n }),
  };
  return (
    <WorkspaceHistoryUndoCard
      text={text} className="wh-rewind-card" afterCut={afterCut} online={online} undone={rewind.undone}
      notes={rewind.notes.map((n) => ({ id: n.id, title: n.title, spaceId: n.space_id, meta: kindLabel[n.kind], sheetTag: kindLabel[n.kind] }))}
      onOpenInbox={onOpenInbox} onNotice={onNotice} onChanged={onChanged}
      undo={(ids) => historyWriter.undoRewind(rewind.rewind_id, ids)}
      isFullyUndone={(report, chosen, all) => chosen.length === all.length && report.undone.length === chosen.length}
    />
  );
}
