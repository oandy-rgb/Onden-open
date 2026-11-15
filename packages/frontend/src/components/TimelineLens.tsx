import { Suspense } from "react";
import { lazyWithReload } from "../lib/lazyWithReload";
import "./NodeLenses.css";
import "./HistoryLens.css";
import { useT } from "../lib/i18n";
import { useIsMobile } from "../hooks/useIsMobile";

const WorkspaceHistory = lazyWithReload(() => import("./history").then((m) => ({ default: m.WorkspaceHistory })));

// The History screen: what changed across the whole workspace. One note's own history is the
// time slider (NoteHistory), reached from the note's "modified N days ago", its ⋯ menu, or a
// row here — it is not a mode of this screen.

type Props = {
  online?: boolean;
  onOpen?: (id: string) => void;
};

export default function TimelineLens({ online = true, onOpen }: Props) {
  const t = useT();
  const phone = useIsMobile();
  return (
    <div className="node-lens-pane history-lens-pane">
      {/* A phone names the page in the top bar. */}
      {!phone && (
        <header className="node-lens-header history-lens-header">
          <h2 className="node-lens-title">{t("History")}</h2>
        </header>
      )}
      <div className="node-lens-body history-lens-body">
        <Suspense fallback={<div className="lazy-loading-pane" />}>
          <WorkspaceHistory online={online} onOpenNote={(id) => onOpen?.(id)} />
        </Suspense>
      </div>
    </div>
  );
}
