// 「等你決定」 at the top of the inbox page: the notes with something to decide
// (an agent's changes, paragraphs both sides changed), each opening the note at
// its own line. Requests that are not about a note (publish the site, install a
// tag pack) are decided here. Nothing renders when nothing waits.

import { LoadError, Pressable } from "../../components/ui";
import { ChevronRight } from "lucide-react";
import { selectOverviewNodes, useAppSelector, useOnline } from "../../lib/appStore";
import { useT, tn } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import type { NoteDecision } from "../../lib/decisions";
import { useDecisionsContext } from "../../hooks/DecisionsContext";
import InboxReview from "../../components/InboxReview";
import FailedJobsNotice from "../../components/FailedJobsNotice";

type Translate = ReturnType<typeof useT>;

/** What kind of thing waits on a note, in words. */
function kindWords(d: NoteDecision, t: Translate): string {
  return [
    d.agentChanges > 0 ? t("AI's changes") : null,
    d.bodyConflicts > 0 ? t("Paragraphs both of you changed") : null,
    d.fieldConflicts > 0 ? t("Fields changed on two devices") : null,
  ].filter((part): part is string => part !== null).join(" · ");
}

export default function DecideSection({ onOpenNode }: { onOpenNode: (id: string) => void }) {
  const t = useT();
  const ctx = useDecisionsContext();
  const nodes = useAppSelector(selectOverviewNodes);
  const online = useOnline();
  if (!ctx) return null;
  const { decisions, inbox } = ctx;
  const notes = [...decisions.byNote.values()].filter((d) => d.total > 0);
  const heldRequests = inbox.approvals ?? [];
  const failedJobs = <FailedJobsNotice online={online} />;
  // A failed read is not an empty queue: say so even when nothing else is waiting.
  const loadError = inbox.loadFailed && inbox.onRetryLoad
    ? <LoadError online={online} onRetry={inbox.onRetryLoad} failed={t("Couldn't load the changes waiting for review.")} />
    : null;
  if (decisions.total === 0) return <>{loadError}{failedJobs}</>;
  const open = (id: string) => { ctx.requestOpenAt(id); onOpenNode(id); };
  return (
    <section className="capture-decide" aria-labelledby="capture-decide-title">
      <h2 id="capture-decide-title" className="capture-decide-title">
        {t("Waiting for your decision")}
        <span className="capture-decide-count">{decisions.total}</span>
      </h2>
      {loadError}
      {notes.length > 0 && (
        <ul className="capture-decide-list">
          {notes.map((d) => {
            const title = displayTitle(nodes.find((n) => n.id === d.nodeId)?.title);
            return (
              <li key={d.nodeId}>
                <Pressable type="button" className="capture-decide-row" onClick={() => open(d.nodeId)}
                  aria-label={t("Open “{title}” to decide", { title })}>
                  <span className="capture-decide-text">
                    <span className="capture-decide-note">{title}</span>
                    <span className="capture-decide-kind">{kindWords(d, t)}</span>
                  </span>
                  <span className="capture-decide-n">{tn("1 place", "{n} places", d.total)}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </Pressable>
              </li>
            );
          })}
        </ul>
      )}
      {(decisions.otherEvents.length > 0 || heldRequests.length > 0) && (
        <InboxReview events={decisions.otherEvents} approvals={heldRequests} busyId={inbox.busyId} online={online}
          onApprove={inbox.onApprove} onReject={inbox.onReject} onBatchDecide={inbox.onBatchDecide}
          onDecideHeld={inbox.onDecideHeld} onOpenNode={onOpenNode} showFailedJobs={false} />
      )}
      {failedJobs}
    </section>
  );
}
