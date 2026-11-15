// 「那天的樣子」 / 「回到這之前」: the workspace (or one space) as it was at a point, against now. Read
// only: a sentence of numbers, the notes that differ in three groups (the same ones are only counted), a
// then-against-now look at each, and the one button that leads to the confirmation. Lives in the right
// column when the page is wide, in a full-screen dialog when it is not.
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button, CloseButton, LoadError, Modal, Pressable } from "../ui";
import { useT } from "../../lib/i18n";
import { changeSummaryText, fetchWorkspaceAt } from "../../lib/history";
import type { AtNote } from "@onden/contract";
import RewindConfirm from "./RewindConfirm";
import RewindNoteDiff from "./RewindNoteDiff";
import { useHistorySpace } from "./historySpace";
import { cutWhen, type Cut } from "./rewindCut";
import { failed, useLoad } from "./useLoad";
import { displayTitle } from "../../lib/noteLabel";
import EmptyState from "../EmptyState";
import type { RewindResult } from "@onden/contract";

type Props = {
  cut: Cut;
  online: boolean;
  /** Full-screen dialog (a narrow page) instead of a panel in the right column. */
  dialog: boolean;
  onClose: () => void;
  /** A rewind was done: the feed reads again and the screen says what happened. */
  onRewound: (result: RewindResult | undefined) => void;
};

export default function RewindPreview({ cut, online, dialog, onClose, onRewound }: Props) {
  const t = useT();
  const { spaceId, labelFor } = useHistorySpace();
  const [state, reload] = useLoad(() => fetchWorkspaceAt(cut.at, spaceId), [cut.at, spaceId]);
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const when = cutWhen(cut);
  const heading = cut.kind === "day" ? t("How it looked at {when}", { when }) : t("How it looked before {when}", { when });

  const body = (() => {
    if (state.status === "loading") return <EmptyState size="inline" title={t("Loading…")} />;
    if (state.status === "error") {
      return (
        <LoadError failed={t("Couldn't load the history.")} online={online} onRetry={reload} message={failed(state) ? undefined : t("This server can't show earlier versions yet.")} />
      );
    }
    const { counts, notes } = state.value;
    const groups: Array<{ status: AtNote["status"]; title: string }> = [
      { status: "changed", title: t("Changed since") },
      { status: "deleted_since", title: t("Deleted since") },
      { status: "created_since", title: t("Added since") },
    ];
    return (
      <>
        <p className="wh-rewind-summary">
          {t("Compared with now: {changed} notes changed, {created} added, {deleted} deleted since", {
            changed: counts.changed, created: counts.created_since, deleted: counts.deleted_since,
          })}
        </p>
        {notes.length === 0 && <EmptyState size="inline" title={t("Everything is the same as now.")} />}
        {groups.map(({ status, title }) => {
          const list = notes.filter((n) => n.status === status);
          if (list.length === 0) return null;
          return (
            <section key={status} className="wh-rewind-group" data-group={status}>
              <h3 className="wh-rewind-group-title">{title} <span className="wh-day-count">· {list.length}</span></h3>
              <ul className="wh-notes">
                {list.map((n) => (
                  <li key={n.id}>
                    <Pressable type="button" className="wh-note-link wh-touch" aria-expanded={open === n.id} onClick={() => setOpen(open === n.id ? null : n.id)}>
                      <span className="wh-note-text">
                        <span className="wh-note-titleline">
                          <span className="wh-note-title">{displayTitle(status === "created_since" ? n.title_now : n.title_then)}</span>
                          {labelFor(n.space_id) && <span className="wh-note-space">{labelFor(n.space_id)}</span>}
                        </span>
                        {n.change && <span className="wh-note-meta">{changeSummaryText(t, n.change)}</span>}
                      </span>
                      <ChevronRight size={16} aria-hidden="true" className={"wh-chevron" + (open === n.id ? " open" : "")} />
                    </Pressable>
                    {open === n.id && <RewindNoteDiff noteId={n.id} at={cut.at} online={online} />}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <p className="wh-sheet-explain">{t("Restoring only changes the notes' text and which notes exist.")}</p>
        {!online && <p className="wh-sheet-explain">{t("You're offline. Restoring needs a connection.")}</p>}
        <div className="wh-rewind-actions">
          <Button variant="primary" className="wh-touch" disabled={!online || notes.length === 0} onClick={() => setConfirming(true)}>
            {t("Restore to this point")}
          </Button>
        </div>
        {confirming && (
          <RewindConfirm
            cut={cut}
            notes={notes}
            online={online}
            onClose={() => setConfirming(false)}
            onDone={(result) => { setConfirming(false); onRewound(result); }}
          />
        )}
      </>
    );
  })();

  if (dialog) {
    return (
      <Modal label={heading} className="wh-rewind-layer" onClose={onClose}>
        <div className="wh-rewind wh-rewind--dialog">
          <header className="wh-rewind-head">
            <h2>{heading}</h2>
            <CloseButton className="wh-touch" onClick={onClose} />
          </header>
          <div className="wh-rewind-body">{body}</div>
        </div>
      </Modal>
    );
  }
  return (
    <section className="wh-rewind" aria-label={heading}>
      <header className="wh-rewind-head">
        <h2>{heading}</h2>
        <CloseButton className="wh-touch" onClick={onClose} />
      </header>
      <div className="wh-rewind-body">{body}</div>
    </section>
  );
}
