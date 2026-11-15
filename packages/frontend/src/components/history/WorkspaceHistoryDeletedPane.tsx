// The right column of 「最近刪除」: what the selected note said when it was deleted (read only),
// with the button to bring it back.
import { Suspense } from "react";
import { Button, LoadError } from "../ui";
import { useAllNodes } from "../../lib/appStore";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { useT } from "../../lib/i18n";
import { fetchDeletedBody } from "../../lib/history";
import { failed, useLoad } from "./useLoad";
import { displayTitle } from "../../lib/noteLabel";
import EmptyState from "../EmptyState";
import type { DeletedNote } from "@onden/contract";

const OverviewPreview = lazyWithReload(() => import("../OverviewPreview"));

type Props = {
  /** The selected deleted note; null for the blank-notes row or nothing selected. */
  note: DeletedNote | null;
  /** The blank-notes row is selected: how many it folds. */
  blankCount: number;
  online: boolean;
  busy: boolean;
  onRescue: (note: DeletedNote) => void;
};

export default function WorkspaceHistoryDeletedPane({ note, blankCount, online, busy, onRescue }: Props) {
  const t = useT();
  if (blankCount > 0) return <EmptyState size="inline" className="wh-detail-empty" title={t("{n} blank notes, nothing to see", { n: blankCount })} />;
  if (!note) return <EmptyState size="inline" className="wh-detail-empty" title={t("Pick a deleted note to see what it said")} />;
  if (note.blank) return <EmptyState size="inline" className="wh-detail-empty" title={t("{n} blank notes, nothing to see", { n: 1 })} />;
  return <DeletedNoteBody key={note.id} note={note} online={online} busy={busy} onRescue={onRescue} />;
}

function DeletedNoteBody({ note, online, busy, onRescue }: Omit<Props, "note" | "blankCount"> & { note: DeletedNote }) {
  const t = useT();
  const nodes = useAllNodes();
  const [body, reload] = useLoad(() => fetchDeletedBody(note.id), [note.id]);
  return (
    <div className="wh-deleted-detail">
      <header className="wh-deleted-detail-head">
        <h2>{displayTitle(note.title)}</h2>
        <Button variant="primary" className="wh-touch" disabled={!online || busy} onClick={() => onRescue(note)}>{t("Bring back")}</Button>
      </header>
      <div className="wh-deleted-detail-body">
        {body.status === "loading" && <EmptyState size="inline" title={t("Loading…")} />}
        {failed(body) && (
          <LoadError failed={t("Couldn't load the history.")} online={online} onRetry={reload} />
        )}
        {body.status === "error" && body.unavailable && <EmptyState size="inline" title={t("This note's text is not available here yet.")} />}
        {body.status === "ready" && (body.value.markdown.trim() === ""
          ? <EmptyState size="inline" title={t("This version has no text.")} />
          : <Suspense fallback={<EmptyState size="inline" title={t("Loading…")} />}>
              <OverviewPreview draft={body.value.markdown} nodes={nodes} onOpenWikilink={() => {}} />
            </Suspense>)}
      </div>
    </div>
  );
}
