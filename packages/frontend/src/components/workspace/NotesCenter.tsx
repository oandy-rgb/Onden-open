import { Suspense, type ComponentProps, type ReactNode } from "react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { useAppSelector, useOnline } from "../../lib/appStore";
import { useCapabilities } from "../../lib/capabilities";
import { nodeActions } from "../../lib/data";
import type { ModuleTarget } from "../../modules";
import { shellFeatureModule } from "../../lib/shellFeatures";
import { useSidebarTagPrefs } from "../../hooks/useSidebarTagPrefs";
import type { useOverviewMode } from "../../hooks/useOverviewMode";
import type { NotesView } from "../../hooks/useUiMode";
import type { useWorkspaceFocus } from "../../hooks/useWorkspaceFocus";
import ModuleNotImported from "../ModuleNotImported";
import { OwnerViewPane, useViewOwner } from "../viewTabs";
import type OverviewEditorHostComponent from "../OverviewEditorHost";
import { isRetiredBoardKind } from "../../lib/whiteboardNote";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

// H4: the lazy chunk is the store-bound HOST (which imports OverviewEditor
// statically) — the only subscriber to the draft slice, so keystrokes
// re-render it alone, not this tree.
const OverviewEditorHost  = lazyWithReload(() => import("../OverviewEditorHost"));
const SchemaLens          = lazyWithReload(() => import("../tagPage"));
// D3 node lenses — center-pane siblings of the editor and the board.
// D5 — the home node's auto-content strip (recent/today/pinned/loose-ends).
const HomeStart           = lazyWithReload(() => import("../HomeStart"));

type Props = {
  notesView: NotesView;
  /** The open saved-view tab (a view id) of the focused note or tag, in the editor lens. */
  viewTab: string | null;
  /** The board (canvas / graph) view, built by the shell. */
  board: ReactNode;
  focus: Pick<ReturnType<typeof useWorkspaceFocus>,
    "selectedNode" | "selectedTag" | "pageNode" | "pageTag" | "selectTab" | "openNote" | "followLink" | "showBoardInLens" | "openTag" | "openBoardId">;
  overview: Pick<ReturnType<typeof useOverviewMode>, "overviewSelectedNode" | "nodeVersions" | "openWikilink">;
  noteActions: ComponentProps<typeof OverviewEditorHostComponent>["noteActions"];
  /** Opens (or creates) today's note. */
  openDailyNote: () => Promise<unknown>;
  createNote: () => Promise<unknown>;
  setTodayMood: (mood: string) => Promise<void>;
  openModule: (id: string, target?: ModuleTarget) => void;
  canvasImported: boolean;
  refresh: () => Promise<void>;
  /** The Tags page (a tag page's 「全部標籤」). */
  openTagsOverview: () => void;
};

/** The notes workspace's center pane: the focused node in its lens. */
export default function NotesCenter({
  notesView, viewTab, board, focus, overview, noteActions,
  openDailyNote, createNote, setTodayMood,
  openModule, canvasImported, refresh, openTagsOverview,
}: Props) {
  const { selectedNode, selectedTag, openNote, openTag } = focus;
  const { overviewSelectedNode, nodeVersions } = overview;
  const data = useAppSelector((s) => s.data);
  const online = useOnline();
  // A tag's structure is the owner's (lib/capabilities canEdit of a class_tag).
  const { canEdit } = useCapabilities(online);
  const { pinned: pinnedTagViewIds } = useSidebarTagPrefs();
  const loading = <div className="lazy-loading-pane" />;
  const viewOwner = useViewOwner(focus.pageNode, focus.pageTag);

  // doc 01 P3 — a focused class_tag node opens to its SCHEMA in the center
  // (a class_tag IS a node you open with a schema lens), not the markdown editor.
  // Keyed on the REAL selection, not overviewSelectedNode's first-node
  // fallback: deselecting (e.g. clicking empty canvas space, which clears the
  // selection) must not let a tag that merely sorts first hijack the center
  // pane — on the canvas lens that ejected the user from the board.
  if (!canvasImported && selectedNode && isRetiredBoardKind(selectedNode)) {
    // A canvas note while the whiteboard is not imported: say so (its board
    // is kept) instead of opening it as a note.
    return (
      <ModuleNotImported moduleId={shellFeatureModule("whiteboard")} />
    );
  }
  // A saved-view tab of a note or a tag: its view over the whole note area.
  if (viewTab && viewOwner && notesView === "editor") {
    return <OwnerViewPane info={viewOwner} viewId={viewTab} onOpenNote={openNote} onOpenView={focus.selectTab} onSaved={refresh} />;
  }
  if (selectedTag && notesView !== "canvas") {
    return (
      <Suspense fallback={loading}>
        <SchemaLens tag={selectedTag} online={online} onSaved={refresh} nodes={data.nodes} onOpenNode={openNote} allTags={data.tags ?? []} onDeleteNode={nodeActions.delete}
          canManage={canEdit({ node_type: TAG_NODE_TYPE, space_id: null })} onOpenTagsOverview={openTagsOverview} />
      </Suspense>
    );
  }
  if (notesView === "editor" && focus.openBoardId === null) {
    return (
      <Suspense fallback={loading}>
        {/* D5 — on the home node, orientation comes for free: the auto
            strip sits above the node's own (optional) MOC markdown. */}
        {overviewSelectedNode && overviewSelectedNode.id === data.workspace.home_node_id && (
          <HomeStart
            allTags={data.tags ?? []}
            homeNodeId={overviewSelectedNode.id}
            nodes={data.nodes}
            tasks={data.tasks}
            pinnedTags={(data.tags ?? []).filter((tag) => pinnedTagViewIds.includes(tag.id))}
            onOpenNode={openNote}
            onOpenToday={() => void openDailyNote()}
            onSetTodayMood={(mood) => void setTodayMood(mood)}
            onOpenTagView={openTag}
            onOpenModule={openModule}
          />
        )}
        {/* H4: the host subscribes to the draft slice itself — typing
            re-renders it alone, never this tree. */}
        <OverviewEditorHost
          onOpenWikilink={(label, targetId, blockId) => void overview.openWikilink(label, targetId, undefined, blockId)}
          onCreateFirst={() => void createNote()}
          onFollowLink={focus.followLink}
          onAssignGroup={nodeActions.assignToGroup}
          onOpenCanvas={focus.showBoardInLens}
          nodeVersions={nodeVersions}
          noteActions={noteActions}
        />
      </Suspense>
    );
  }
  return <Suspense fallback={loading}>{board}</Suspense>;
}
