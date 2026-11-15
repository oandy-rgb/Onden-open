import { Suspense, useCallback, useEffect, useState } from "react";
import { lazyWithReload } from "../lib/lazyWithReload";
import type { ContentNode } from "../lib/api";
import { useAppSelector, useOnline, useAllNodes } from "../lib/appStore";
import { subscribeNoteHistoryRequests, takeNoteHistoryRequest, type NoteHistoryVersion } from "../lib/history";

const NoteHistory = lazyWithReload(() => import("./history").then((m) => ({ default: m.NoteHistory })));
export type NodeVersion = NoteHistoryVersion;

/**
 * The compare/restore dialog for a note's versions, opened from anywhere (the
 * note header's "N days ago", the ⋯ menu, a row of the workspace History).
 * The screen gets a snapshot of the versions from its opening: a background
 * save can coalesce the clicked version out of the live list while the lazy
 * chunk is loading. `dialog` renders the open dialog and the restore feedback.
 */
export function useVersionHistoryDialog({ node, nodeVersions, onSelectNode, acceptRequests = false }: {
  node: ContentNode | null;
  nodeVersions: NodeVersion[];
  onSelectNode: (id: string) => void;
  /** Answer `openNoteHistory` calls: only the note editor's host does. */
  acceptRequests?: boolean;
}) {
  const nodes = useAllNodes();
  const online = useOnline();
  const [history, setHistory] = useState<{ nodeId: string; versions: NodeVersion[]; initialVersionId?: string; initialDay?: string } | null>(null);
  const nodeId = node?.id ?? null;
  useEffect(() => { setHistory(null); }, [nodeId]);
  const historyOpen = !!node && history?.nodeId === node.id;
  const openHistory = useCallback((initialVersionId?: string, initialDay?: string) => {
    if (nodeId) setHistory({ nodeId, versions: [...nodeVersions], initialVersionId, initialDay });
  }, [nodeId, nodeVersions]);
  // Only the open dialog needs the live draft; the version list does not
  // subscribe to unrelated edits.
  const historyDraft = useAppSelector((state) => historyOpen && state.selectedId === node?.id ? state.overviewDraft : null);
  // Another screen asked for this note's history (openNoteHistory): the note may
  // only just have been selected, so look again whenever the open note changes.
  const [requests, setRequests] = useState(0);
  useEffect(() => acceptRequests ? subscribeNoteHistoryRequests(() => setRequests((n) => n + 1)) : undefined, [acceptRequests]);
  useEffect(() => {
    if (!acceptRequests || !nodeId) return;
    const request = takeNoteHistoryRequest(nodeId);
    if (request) openHistory(request.versionId, request.day);
  }, [acceptRequests, nodeId, requests, openHistory]);

  const dialog = node && historyOpen && history ? (
    <Suspense fallback={null}>
      <NoteHistory
        key={node.id}
        node={node}
        versions={history.versions}
        initialVersionId={history.initialVersionId}
        initialDay={history.initialDay}
        currentMarkdown={historyDraft ?? node.markdown}
        nodes={nodes}
        from={node}
        online={online}
        onOpenNote={onSelectNode}
        // A late close from a previous note must not close a new dialog.
        onClose={() => setHistory((current) => current === history ? null : current)}
      />
    </Suspense>
  ) : null;
  return { openHistory, dialog };
}
