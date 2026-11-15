import { nodeHasClassTag } from "../lib/nodeTags";
import { propertyWriter, taskWriter, usePendingWrites, drafts, dataSync, nodeMutations } from "../lib/data";
// The store-bound wrapper around OverviewEditor (H4 keystroke isolation).
//
// This is the ONLY component that subscribes to the draft slice — a keystroke
// re-renders this host + the editor below it, while BuilderApp (sidebar,
// topbar, inspector, canvas) doesn't render at all. OverviewEditor itself
// stays a presentational component; everything hot or store-resident is
// pulled here, everything that needs BuilderApp context (mode switching,
// node creation) stays a prop.

import { useEffect, useMemo, useRef } from "react";
import { authorKindOf } from "../lib/history";
import { OPEN_NOTE_HISTORY_EVENT } from "../hooks/usePaletteState";
import OverviewEditor from "./OverviewEditor";
import EmptyState from "./EmptyState";
import { navigate } from "../lib/historyIntent";
import type { NoteDisplayRow } from "./NoteActions";
import { WiredNoteActions, type NoteActionsWiring } from "./WiredNoteActions";
import NoteRelations from "./NoteRelations";
import type { OpenNoteHistory } from "./NoteEditedLine";
import { useVersionHistoryDialog, type NodeVersion } from "./NoteVersionHistory";
import { useAppSelector, addToast, setSelectedId, setOverviewView, selectOverviewSelectedNode, useWorkspaceChecked, useOnline, useTagRows, useSelectedId, useAllNodes } from "../lib/appStore";
import { nodeNeedsBody } from "../lib/api";
import type { Tag } from "../lib/api";
import { t } from "../lib/i18n";
import { onWindow } from "../lib/globalEvents";
import { useAiEnabled } from "../hooks/useModuleFilter";

// Stable fallbacks — an inline [] would churn identity on every keystroke
// render of this host.
const NO_TAGS: Tag[] = [];
const NO_VERSIONS: NodeVersion[] = [];

type Props = {
  onOpenWikilink: (label: string, targetId?: string | null, blockId?: string) => void;
  onCreateFirst: () => void;
  /** Open a related note from the relations under the body (a link follow:
   *  it goes on the back stack). Stable (BuilderApp's focus handlers), so the
   *  memoized NoteRelations skips keystroke renders. */
  onFollowLink?: (id: string) => void;
  onAssignGroup?: (nodeId: string, parentId: string | null) => unknown;
  onOpenCanvas?: (canvasId: string) => void;
  /** The open note's saved versions (useOverviewMode): the header's "Version
   *  history" and the ⋯ menu open the compare/restore dialog on them. */
  nodeVersions?: NodeVersion[];
  // Per-note header actions whose handlers live in BuilderApp (export, the
  // Info button). Threaded so the menu reuses the EXISTING wiring; the rest is
  // wired in WiredNoteActions.
  noteActions?: NoteActionsWiring;
};

export default function OverviewEditorHost({ onOpenWikilink, onCreateFirst, onFollowLink, onAssignGroup, onOpenCanvas, nodeVersions = NO_VERSIONS, noteActions }: Props) {
  const node = useAppSelector(selectOverviewSelectedNode);
  const selectedId = useSelectedId();
  const draft = useAppSelector((s) => s.overviewDraft);
  const titleDraft = useAppSelector((s) => s.overviewTitleDraft);
  const draftStatus = useAppSelector((s) => s.saveStatus);
  // A queued save stops waiting once the offline queue has drained: saved, or
  // rejected when its replay was refused (a drained queue alone is not saved).
  const pendingWrites = usePendingWrites();
  const saveStatus = draftStatus === "queued" && pendingWrites === 0 && node ? drafts.queuedOutcome(node.id) : draftStatus;
  const view = useAppSelector((s) => s.overviewView);
  const online = useOnline();
  const nodes = useAllNodes();
  const workspaceChecked = useWorkspaceChecked();
  const allTags = useTagRows();
  // The same compare/restore dialog as the timeline's recent saves.
  const history = useVersionHistoryDialog({ node: node ?? null, nodeVersions, onSelectNode: onFollowLink ?? setSelectedId, acceptRequests: true });
  // `since` (NoteEditedLine's 「AI 改過」): land on the first version saved
  // after the reader last saw the note; without it, on the newest.
  const openHistory: OpenNoteHistory | undefined = nodeVersions.length > 0
    ? (opts) => history.openHistory(opts?.since ? firstVersionAfter(nodeVersions, opts.since) : undefined)
    : undefined;
  // 「AI 改過 N 次」 after the edit time: the saved versions an AI made (a restore is not an edit by its author).
  // The 「AI 改過」 count and its link are the AI feature's: not shown while AI is off (the versions stay).
  const aiOn = useAiEnabled();
  const aiEdits = useMemo(() => !aiOn ? 0 : nodeVersions.filter((v) => authorKindOf(v) === "agent" && !v.markers?.includes("restored")).length, [aiOn, nodeVersions]);
  // The command palette's 「這篇筆記的歷史」 opens the same dialog.
  const openHistoryRef = useRef(openHistory); openHistoryRef.current = openHistory;
  useEffect(() => {
    const open = () => openHistoryRef.current?.();
    return onWindow(OPEN_NOTE_HISTORY_EVENT, open);
  }, []);

  const attrClassTags = useMemo(
    () => node
      ? (allTags ?? []).filter((t) => t.schema_id !== null && nodeHasClassTag(node, t.id))
      : [],
    [node, allTags],
  );

  // The address names a note this workspace does not have: deleted (here, on another device), an old link, access
  // removed. Once the workspace is loaded and checked (a cold boot's URL note has not reached the store before that)
  // there is nothing on its way: say so and give a way out, instead of a loading pane that never ends.
  const noteMissing = selectedId !== null && node?.id !== selectedId && workspaceChecked;
  if (noteMissing) {
    return (
      <EmptyState variant="notFound" size="page" title={t("It no longer exists, or you can't see it.")}
        ctaLabel={t("Back to notes list")} onCta={() => navigate(() => setSelectedId(null), { history: "replace" })} />
    );
  }

  // Two not-ready states share the pane: (1) a slim-bootstrap row whose body
  // is still on the server (nodeNeedsBody — hydrateNode is fetching it), and
  // (2) a URL-addressed node that hasn't reached the store yet (cold boot) —
  // without this guard the empty state appears for a note that is still on
  // its way.
  if (nodeNeedsBody(node) || (selectedId !== null && node?.id !== selectedId)) {
    // Offline and this device holds no copy of the body (a large workspace that
    // has not finished its offline download): say so instead of an endless
    // loading skeleton. hydrateNode retries when the connection returns.
    if (!online && node && nodeNeedsBody(node)) {
      return (
        <div className="lazy-offline-pane" role="status">
          {t("This note has not been downloaded to this device yet. Connect to open it.")}
        </div>
      );
    }
    return <div className="lazy-loading-pane" />;
  }

  // Per-note header actions: the same wired ⋯ as the phone's other tabs (WiredNoteActions).
  const actionsEl = node && noteActions ? (editor: { previewAvailable: boolean; displayRows: readonly NoteDisplayRow[] }) => (
    <WiredNoteActions node={node} wiring={noteActions}
      onVersionHistory={openHistory} editor={editor} />
  ) : undefined;

  return (<>
    <OverviewEditor
      node={node}
      onOpenHistory={openHistory}
      aiEdits={aiEdits}
      onOpenVersion={nodeVersions.length > 0 ? (versionId) => history.openHistory(versionId ?? undefined) : undefined}
      onAssignGroup={onAssignGroup}
      noteActions={actionsEl}
      relations={node && onFollowLink ? (
        <NoteRelations node={node} onOpenNote={onFollowLink}
          onOpenCanvas={onOpenCanvas} />
      ) : undefined}
      titleDraft={titleDraft}
      onTitleChange={(title) => { if (node) drafts.type(node.id, { title }); }}
      draft={draft}
      onDraftChange={(markdown) => { if (node) drafts.type(node.id, { markdown }); }}
      view={view}
      setView={setOverviewView}
      saveStatus={saveStatus}
      onSave={() => { if (node) void drafts.save(node.id); }}
      online={online}
      nodes={nodes}
      onOpenWikilink={onOpenWikilink}
      onCreateFirst={onCreateFirst}
      onSelectNode={setSelectedId}
      extractTags={allTags ?? NO_TAGS}
      onExtract={nodeMutations.extractToEntity}
      onRefresh={() => void dataSync.refresh()}
      attrClassTags={attrClassTags}
      onAttrSet={node
        ? async (key, value, valueType) => {
            await propertyWriter.set(node.id, key, value, {
              value_type: valueType as "text" | "number" | "date" | "bool" | "node_ref",
              is_inheritable: false,
            });
          }
        : undefined}
      onCreateTask={node
        ? async (title) => {
            if (!title.trim()) return false;
            try {
              await taskWriter.create(node.id, title);
              // Confirm the handoff — the checkbox just ticking gave no signal a
              // real task was minted; tell the user where it landed.
              addToast(t("Task created — find it in Tasks"), "info");
              return true;
            } catch {
              // The writer has already reported the failure.
              return false;
            }
          }
        : undefined}
    />
    {history.dialog}
  </>);
}

/** The oldest version saved after `since` (versions arrive newest first); none
 *  newer → undefined, which opens on the newest. */
function firstVersionAfter(versions: ReadonlyArray<{ id: string; changed_at: string }>, since: string): string | undefined {
  const t = Date.parse(since);
  let pick: string | undefined;
  for (const v of versions) { if (Date.parse(v.changed_at) > t) pick = v.id; else break; }
  return pick;
}
