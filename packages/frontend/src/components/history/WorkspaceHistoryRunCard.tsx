import { historyWriter } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { timeLabel } from "../../lib/timeLabels";
import type { DayAgentRun } from "@onden/contract";
import WorkspaceHistoryUndoCard, { type UndoCardText } from "./WorkspaceHistoryUndoCard";

type Props = {
  run: DayAgentRun;
  online: boolean;
  onOpenNoteHistory: (noteId: string) => void;
  onOpenInbox: () => void;
  /** Two columns: the note whose history is open on the right, if it is one of this run's. */
  selectedNoteId?: string | null;
  /** A short confirmation line for the screen's status area. */
  onNotice: (message: string) => void;
  /** An undo or redo went through: the screen reads again what it shows. */
  onChanged?: () => void;
  /** 「回到這之前」: look at the workspace just before this run started. */
  onGoBackBefore?: () => void;
  /** Dimmed: the run is newer than the point being looked at, so a rewind to there would undo it. */
  afterCut?: boolean;
};

/** What this run did to one note, in words: "改了 2 段、新增 1 段". */
function changeSummary(note: DayAgentRun["notes"][number], t: ReturnType<typeof useT>): string {
  const parts: string[] = [];
  if (note.changed > 0) parts.push(t("Changed {n} paragraphs", { n: note.changed }));
  if (note.added > 0) parts.push(t("Added {n} paragraphs", { n: note.added }));
  if (note.removed > 0) parts.push(t("Removed {n} paragraphs", { n: note.removed }));
  return parts.join(" · ") || t("Changed");
}

/** An AI run in the feed, with 「Undo this run」 (the card is WorkspaceHistoryUndoCard). */
export default function WorkspaceHistoryRunCard({ run, online, onOpenNoteHistory, onOpenInbox, onNotice, onChanged, selectedNoteId = null, onGoBackBefore, afterCut = false }: Props) {
  const t = useT();
  const when = timeLabel(run.started_at);
  const agent = run.agent_name;
  const text: UndoCardText = {
    tag: agent, tagIsName: true, when,
    ariaLabel: t("{agent} run at {time}", { agent, time: when }),
    summary: run.summary?.trim() || null,
    undoButton: t("Undo this run"),
    sheetTitle: t("Undo {agent}'s changes", { agent }),
    sheetExplain: t("Checked notes go back to how they were before {time}. Paragraphs you changed afterwards are kept; ones both of you changed wait in your inbox under “Waiting for your decision”.", { time: when }),
    confirm: (n) => t("Undo changes to {n} notes", { n }),
    undoneLine: (_undone, outcome) => outcome ? t("Undone · {n} notes are back to how they were before {time}", { n: outcome.undone, time: when }) : t("Undone"),
    undoneNotice: (n) => t("Undid {agent}'s changes to {n} notes", { agent, n }),
    redoButton: t("Bring back {agent}'s changes", { agent }),
    redoneNotice: (n) => t("Brought back {agent}'s changes to {n} notes", { agent, n }),
  };
  return (
    <WorkspaceHistoryUndoCard
      text={text} notes={run.notes.map((n) => ({ id: n.id, title: n.title, spaceId: n.space_id, meta: changeSummary(n, t), created: n.created }))}
      online={online} undone={run.undone} afterCut={afterCut}
      onOpenNote={onOpenNoteHistory} selectedNoteId={selectedNoteId} onOpenInbox={onOpenInbox} onNotice={onNotice} onGoBackBefore={onGoBackBefore}
      undo={(ids) => historyWriter.undoAgentRun(run.run_id, ids)}
      redo={(ids) => historyWriter.redoAgentRun(run.run_id, ids)}
      onChanged={onChanged}
      // Only when every note that can go back did: else the card stays open with its button for the rest.
      isFullyUndone={(report, chosen, all) => chosen.length === all.length && report.undone.length === chosen.length}
    />
  );
}
