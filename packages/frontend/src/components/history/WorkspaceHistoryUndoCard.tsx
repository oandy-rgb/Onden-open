// The card History shows for something that can be undone in one go — an AI run, a rewind. The flow is
// the same for both: the notes it touched, 「Undo」 opens a sheet to pick which of them, the undo runs, and the
// card tells what came of it (done, partly, lines both sides changed in the inbox, notes left alone).
// What differs is passed in: the rows, the words, and the two server calls. Stays open on a failure,
// with the choices as they were.
import { useState, type ReactNode } from "react";
import { Button, Pressable, Sheet } from "../ui";
import { useT } from "../../lib/i18n";
import { writeErrors } from "../../lib/data";
import { useHistorySpace } from "./historySpace";
import { displayTitle } from "../../lib/noteLabel";
import { Checkbox } from "../ui";

export type UndoCardNote = {
  id: string;
  title: string;
  spaceId: string | null;
  /** The small line under the title: what was done to this note. */
  meta: string;
  /** What the sheet shows beside the title instead of the space name. */
  sheetTag?: string;
  /** Made by the thing being undone: nothing to go back to, so it is listed but not offered. */
  created?: boolean;
};

/** What an undo or redo reports: the notes it changed and, when relevant, the ones it could not. */
export type UndoReport = { undone: string[]; conflicts?: string[]; kept?: string[]; skipped?: string[] };
export type UndoOutcome = { undone: number; conflicts: number; kept: number; skipped: number };

export type UndoCardText = {
  /** Heading line over the card's tag and time: the tag (agent name / 「Restore」) and the time. */
  tag: string;
  when: string;
  ariaLabel: string;
  /** A sentence under the head (the run's summary, the rewind's title). */
  summary?: string | null;
  undoButton: string;
  sheetTitle: string;
  sheetExplain: string;
  /** The button that runs the undo, for `n` chosen notes. */
  confirm: (n: number) => string;
  /** The line at the top of the undone block. */
  undoneLine: (undone: boolean, outcome: UndoOutcome | null) => string;
  /** The line for notes changed again after the original action, when that applies. */
  keptLine?: (n: number) => string;
  /** The toast after an undo / a redo. */
  undoneNotice: (n: number) => string;
  redoneNotice?: (n: number) => string;
  redoButton?: string;
};

type Props = {
  text: UndoCardText;
  className?: string;
  notes: UndoCardNote[];
  online: boolean;
  undone: boolean;
  /** Dimmed: it happened after the point being looked at (a rewind to there would undo it). */
  afterCut?: boolean;
  /** Rows open the note's history; without it they are plain lines. */
  onOpenNote?: (noteId: string) => void;
  selectedNoteId?: string | null;
  onOpenInbox: () => void;
  onNotice: (message: string) => void;
  /** An undo went through: the screen reads again what it shows. */
  onChanged?: () => void;
  onGoBackBefore?: () => void;
  undo: (noteIds: string[]) => Promise<UndoReport | undefined>;
  redo?: (noteIds: string[]) => Promise<UndoReport | undefined>;
  /** Whether this undo left the whole card undone (else it stays open for the rest). */
  isFullyUndone: (report: UndoReport, chosen: string[], all: string[]) => boolean;
};

/** Notes listed before "N more". */
const NOTES_SHOWN = 3;

export default function WorkspaceHistoryUndoCard(props: Props) {
  const { text, className = "", notes, online, afterCut = false, onOpenNote, selectedNoteId = null, onOpenInbox, onNotice, onChanged, onGoBackBefore } = props;
  const t = useT();
  const { labelFor } = useHistorySpace();
  const allIds = notes.filter((n) => !n.created).map((n) => n.id);
  const [showAll, setShowAll] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(allIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The state the server reported; set once this session undid or redid it.
  const [undone, setUndone] = useState(props.undone);
  const [outcome, setOutcome] = useState<UndoOutcome | null>(null);
  // The notes the undo actually changed, for 「Bring back」 to put back.
  const [reverted, setReverted] = useState<string[]>([]);

  const visibleNotes = showAll ? notes : notes.slice(0, NOTES_SHOWN);
  const hiddenCount = notes.length - NOTES_SHOWN;

  const openSheet = () => { setPicked(new Set(allIds)); setError(null); setSheetOpen(true); };
  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /** Runs `call`, keeps the card's state honest about what happened, shows a failure inline. */
  const run = async (call: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await call(); } catch (e) { setError(writeErrors.message(e)); } finally { setBusy(false); }
  };

  const doUndo = () => {
    const chosen = allIds.filter((id) => picked.has(id));
    if (chosen.length === 0) return;
    return run(async () => {
      // undefined: applied, its report lost (the writer has told so) — read as every chosen note undone.
      const answered = await props.undo(chosen);
      const report = answered ?? { undone: chosen };
      setSheetOpen(false);
      setOutcome({ undone: report.undone.length, conflicts: report.conflicts?.length ?? 0, kept: report.kept?.length ?? 0, skipped: report.skipped?.length ?? 0 });
      setReverted(report.undone);
      setUndone(props.isFullyUndone(report, chosen, allIds));
      if (answered) onNotice(text.undoneNotice(report.undone.length));
      onChanged?.();
    });
  };

  const doRedo = () => run(async () => {
    const report = await props.redo!(reverted.length > 0 ? reverted : allIds);
    setUndone(false);
    setOutcome(null);
    setReverted([]);
    if (report && text.redoneNotice) onNotice(text.redoneNotice(report.undone.length));
    onChanged?.();
  });

  const goBack = (cls: string): ReactNode => onGoBackBefore && <Pressable type="button" className={cls} onClick={onGoBackBefore}>{t("Go back to before this")}</Pressable>;
  const spaceTag = (n: UndoCardNote) => labelFor(n.spaceId);

  return (
    <article className={"wh-run " + className + (afterCut ? " wh-after-cut" : "")} aria-label={text.ariaLabel}>
      <header className="wh-run-head">
        <span className="wh-run-tag">{text.tag}</span>
        <span className="wh-run-when">{text.when}</span>
        {afterCut && <span className="wh-cut-badge">{t("Will be undone")}</span>}
      </header>
      {text.summary && <p className="wh-run-summary">{text.summary}</p>}

      <ul className={"wh-run-notes" + (undone ? " undone" : "")}>
        {visibleNotes.map((n) => {
          const titleLine = (
            <span className="wh-note-titleline">
              <span className="wh-note-title">{displayTitle(n.title)}</span>
              {spaceTag(n) && <span className="wh-note-space">{spaceTag(n)}</span>}
            </span>
          );
          return onOpenNote ? (
            <li key={n.id}>
              <Pressable type="button" className={"wh-note-link wh-touch" + (n.id === selectedNoteId ? " selected" : "")} aria-current={n.id === selectedNoteId || undefined} onClick={() => onOpenNote(n.id)}>
                {titleLine}
                <span className="wh-note-meta">{n.meta}</span>
              </Pressable>
            </li>
          ) : (
            <li key={n.id} className="wh-rewind-card-note">
              {titleLine}
              <span className="wh-note-meta">{n.meta}</span>
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 && (
        <Pressable type="button" className="wh-link" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? t("Show fewer") : t("{n} more", { n: hiddenCount })}
        </Pressable>
      )}

      {undone || outcome ? (
        <div className="wh-run-undone" role="status">
          <p>{text.undoneLine(undone, outcome)}</p>
          {outcome && outcome.conflicts > 0 && (
            <p>
              {t("{n} notes have paragraphs both of you changed. They wait in your inbox.", { n: outcome.conflicts })}
              {" "}
              <Pressable type="button" className="wh-link" onClick={onOpenInbox}>{t("Go to the inbox")}</Pressable>
            </p>
          )}
          {outcome && outcome.kept > 0 && text.keptLine && <p>{text.keptLine(outcome.kept)}</p>}
          {outcome && outcome.skipped > 0 && <p>{t("{n} notes you can't edit were left alone", { n: outcome.skipped })}</p>}
          {undone && props.redo && text.redoButton && (
            <Button variant="secondary" size="sm" className="wh-touch" disabled={!online || busy} onClick={() => void doRedo()}>{text.redoButton}</Button>
          )}
          {undone && goBack("wh-link")}
        </div>
      ) : null}
      {!undone && allIds.length > 0 && (
        <div className="wh-run-actions">
          <Button variant="ghost" size="sm" className="wh-touch" disabled={!online || busy} onClick={openSheet}>{text.undoButton}</Button>
          {goBack("wh-link wh-run-goback")}
        </div>
      )}
      {error && !sheetOpen && <p className="wh-error" role="alert">{error}</p>}

      {sheetOpen && (
        <Sheet label={text.sheetTitle} className="wh-sheet-layer" busy={busy} onClose={() => setSheetOpen(false)} cardClassName="wh-sheet" desktop="bottom">
          <h3>{text.sheetTitle}</h3>
          <p className="wh-sheet-explain">{text.sheetExplain}</p>
          <ul className="wh-sheet-list">
            {notes.map((n) => (
              <li key={n.id}>
                {n.created ? (
                  <span className="wh-check wh-touch">
                    <span>{displayTitle(n.title)}</span>
                    <span className="wh-note-space">{t("New in this run — not removed by an undo")}</span>
                  </span>
                ) : (
                <label className="wh-check wh-touch">
                  <Checkbox checked={picked.has(n.id)} onChange={() => toggle(n.id)} />
                  <span>{displayTitle(n.title)}</span>
                  {(n.sheetTag ?? spaceTag(n)) && <span className="wh-note-space">{n.sheetTag ?? spaceTag(n)}</span>}
                </label>
                )}
              </li>
            ))}
          </ul>
          {error && <p className="wh-error" role="alert">{error}</p>}
          <div className="wh-sheet-actions">
            <Button variant="secondary" className="wh-touch" disabled={busy} onClick={() => setSheetOpen(false)}>{t("Cancel")}</Button>
            <Button variant="primary" className="wh-touch" disabled={busy || picked.size === 0 || !online} onClick={() => void doUndo()}>{text.confirm(picked.size)}</Button>
          </div>
        </Sheet>
      )}
    </article>
  );
}
