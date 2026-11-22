// The note's ⋯ (and, on a phone, its Info button) wired to the store: the one
// place that decides what this person is offered for this note. The editor's
// header (OverviewEditorHost) and the phone's top bar over the other tabs
// (NoteTabActions) both render it, so the two never offer different lists.
import { layerClass } from "./ui";
import { drafts, nodeActions, noteActionsFor } from "../lib/data";
import { FIND_IN_NOTE_EVENT } from "../lib/findInNote";
import { useAppSelector, setOverviewView, setSelectedId, useOnline, useTagRows } from "../lib/appStore";
import { useCapabilities } from "../lib/capabilities";
import { importedModules, type NoteCommand } from "../modules";
import { useModuleFilter } from "../hooks/useModuleFilter";
import { useIsMobile } from "../hooks/useIsMobile";
import type { ContentNode } from "../lib/api";
import type { NoteExportOptions } from "../lib/noteExport";
import NoteActions, { type ExportFormat, type NoteDisplayRow } from "./NoteActions";
import { ViewStripEnd } from "./viewTabs";
import { useVersionHistoryDialog, type NodeVersion } from "./NoteVersionHistory";
import { emitWindowEvent } from "../lib/globalEvents";

/** The handlers BuilderWorkspace owns (export, the Info button); see OverviewEditorHost. */
export type NoteActionsWiring = {
  exportNote: (format: ExportFormat, options?: NoteExportOptions) => Promise<boolean>;
  copyMarkdown: () => Promise<boolean>;
  exportBusy: boolean;
  /** The Info button beside ⋯: a toggle on a wide screen, the way to the Info screen on a phone. */
  inspectorToggle?: { pressed: boolean; onToggle: () => void };
  /** Runs a module's note command (the 「功能」 tab's buttons, the palette). */
  runNoteCommand?: (command: NoteCommand) => void;
};

type Props = {
  node: ContentNode;
  wiring: NoteActionsWiring;
  /** Open the version dialog; absent when the note has no saved versions. */
  onVersionHistory?: () => void;
  /** The editor's own state (preview, display rows); absent over the other tabs. */
  editor?: { previewAvailable: boolean; displayRows: readonly NoteDisplayRow[] };
};

export function WiredNoteActions({ node, wiring, onVersionHistory, editor }: Props) {
  const isImported = useModuleFilter();
  const online = useOnline();
  const allTags = useTagRows();
  const view = useAppSelector((s) => s.overviewView);
  const caps = useCapabilities(online);
  const canEdit = caps.canEdit(node);
  // Modules add their own header controls (FrontendModule.noteHeaderAction: skills' 交給 AI).
  const headerActions = importedModules(isImported).flatMap(({ id, noteHeaderAction: Action }) =>
    Action ? [<Action key={id} node={node} readOnly={!canEdit} />] : []);
  // The same list the context menu, the ⌘K palette and the sidebar render from (lib/data noteActionList, D112);
  // module commands are in the info panel's 「功能」 tab, not here.
  const actions = noteActionsFor(node, { canEdit, isOwner: caps.isOwner, online, tags: allTags, hasVersions: !!onVersionHistory, isImported });
  return (
    <NoteActions
      key={node.id}
      headerActions={headerActions}
      inspectorToggle={wiring.inspectorToggle}
      actions={actions}
      displayRows={editor?.displayRows}
      onDuplicate={() => { void nodeActions.duplicate(node.id); }}
      onExport={wiring.exportNote}
      onCopyMarkdown={wiring.copyMarkdown}
      exportBusy={wiring.exportBusy}
      onDelete={() => { void nodeActions.delete(node.id); }}
      stats={{ nodeId: node.id, body: () => drafts.read(node.id)?.markdown ?? node.markdown ?? "", createdAt: node.created_at }}
      onVersionHistory={onVersionHistory}
      phoneEditor={{
        view: editor?.previewAvailable ? view : null,
        onSetView: setOverviewView,
        onFind: () => emitWindowEvent(FIND_IN_NOTE_EVENT),
      }}
    />
  );
}

/** The note's ⋯ over a tab that has no editor header (whiteboard, table, calendar…), in the same place as on the
 *  content tab: the right end of the page's title strip, or on a phone the top bar's right corner. */
export function NoteTabActions({ node, wiring, nodeVersions }: {
  node: ContentNode;
  wiring: NoteActionsWiring;
  nodeVersions: NodeVersion[];
}) {
  const phone = useIsMobile();
  const history = useVersionHistoryDialog({ node, nodeVersions, onSelectNode: setSelectedId });
  const actions = (
    <WiredNoteActions node={node} wiring={wiring}
      onVersionHistory={nodeVersions.length > 0 ? () => history.openHistory() : undefined} />
  );
  if (!phone) return <ViewStripEnd slot="more">{actions}{history.dialog}</ViewStripEnd>;
  return (
    <div className={`${layerClass.narrow} note-tab-actions obsidian-actions`}>
      {actions}
      {history.dialog}
    </div>
  );
}
