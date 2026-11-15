import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { selectOverviewNodes, useAppSelector, useOnline } from "../lib/appStore";
import { tn } from "../lib/i18n";
import { useDecisionsContext } from "../hooks/DecisionsContext";
import InboxReview from "./InboxReview";
import ConflictList from "./ConflictList";
import BodyConflictList from "./BodyConflictList";
import "./NoteDecisions.css";
import { Pressable } from "./ui";

/** The decisions about one note, decided where they are shown: the agent's
 *  changes, then the places both sides changed. The same cards and writers the
 *  inbox pane used to have, narrowed to this note. */
export function NoteDecisionPanel({ nodeId, onOpenNode }: { nodeId: string; onOpenNode: (id: string) => void }) {
  const ctx = useDecisionsContext();
  const nodes = useAppSelector(selectOverviewNodes);
  const online = useOnline();
  if (!ctx) return null;
  const { inbox, fieldConflicts, bodyConflicts } = ctx;
  const here = (e: { target_id: string }) => e.target_id === nodeId;
  return (
    <>
      {/* No groups or filters: this note's changes are decided one by one. */}
      <InboxReview events={inbox.events.filter(here)} busyId={inbox.busyId} online={online}
        onApprove={inbox.onApprove} onReject={inbox.onReject} onBatchDecide={inbox.onBatchDecide}
        onOpenNode={onOpenNode} showFailedJobs={false} />
      <ConflictList conflicts={fieldConflicts.conflicts.filter(here)} nodes={nodes} onOpenNode={onOpenNode}
        onDismiss={fieldConflicts.dismiss} onRevert={ctx.onRevertFieldConflict} />
      <BodyConflictList conflicts={bodyConflicts.conflicts.filter(here)} nodes={nodes} onOpenNode={onOpenNode}
        onDismiss={bodyConflicts.dismiss} onResolve={ctx.onResolveBodyConflict} />
    </>
  );
}

/** One quiet line at the top of a note with something to decide:
 *  「有 N 處等你決定」. Tapping it opens the decisions right here. Nothing when
 *  nothing waits. */
export default function NoteDecisions({ nodeId, onOpenNode }: { nodeId: string; onOpenNode: (id: string) => void }) {
  const ctx = useDecisionsContext();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const count = ctx?.decisions.byNote.get(nodeId)?.total ?? 0;
  const nothingLeft = count === 0;
  const asked = ctx?.openRequest === nodeId;
  const clearAsk = ctx?.requestOpenAt;
  // The inbox opened this note "at that line": show the decisions and bring them into view.
  // The ask waits until the note's decisions are counted: taken while there are none
  // yet (the note opened before its share of the inbox arrived), the reset below
  // would fold the line again the moment they do.
  useEffect(() => {
    if (!asked || nothingLeft) return;
    setOpen(true);
    root.current?.scrollIntoView?.({ block: "nearest" });
    clearAsk?.(null);
  }, [asked, nothingLeft, clearAsk]);
  // Another note, or the last decision made: start closed next time. Reset while
  // rendering, not in an effect: an effect runs after the line is on screen, so a
  // tap made before it flushed would be closed again.
  const [shownFor, setShownFor] = useState({ nodeId, nothingLeft });
  if (shownFor.nodeId !== nodeId || shownFor.nothingLeft !== nothingLeft) {
    setShownFor({ nodeId, nothingLeft });
    setOpen(false);
  }
  if (!ctx || count === 0) return null;
  const panelId = `note-decisions-${nodeId}`;
  return (
    <div className="note-decisions" ref={root}>
      <Pressable type="button" className="note-decisions-line" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={12} aria-hidden="true" className={open ? "note-decisions-chev open" : "note-decisions-chev"} />
        {tn("1 thing waits for your decision", "{n} things wait for your decision", count)}
      </Pressable>
      {open && <div id={panelId} className="note-decisions-panel"><NoteDecisionPanel nodeId={nodeId} onOpenNode={onOpenNode} /></div>}
    </div>
  );
}
