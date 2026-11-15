import { Suspense, useMemo } from "react";
import type { useNodeCreation } from "../../hooks/useNodeCreation";
import type { useNodeLifecycle } from "../../hooks/useNodeLifecycle";
import type { useNodeSelection } from "../../hooks/useNodeSelection";
import type { useSidebarDrag } from "../../hooks/useSidebarDrag";
import { useStableHandlers } from "../../hooks/useStableCallback";
import { nodeActions } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { loadMoveToSpaceConfirm } from "../lateShell";
import OverviewSidebar from "../OverviewSidebar";
import type {
  SidebarMenuKind, SidebarNav, SidebarNodeActions, SidebarRename, SidebarTree,
} from "../sidebarGroups";
import { displayTitle } from "../../lib/noteLabel";

type Props = {
  /** Drag state and group expansion. Owned by the shell, not this component:
   *  the sidebar remounts when the mode changes, and its auto-expand would
   *  reopen groups the user collapsed. */
  drag: ReturnType<typeof useSidebarDrag>;
  /** Rename-in-place state, shared with the context menu's "Rename". */
  rename: Pick<ReturnType<typeof useNodeSelection>, "renamingNodeId" | "setRenamingNodeId" | "renameDraft" | "setRenameDraft">;
  lifecycle: Pick<ReturnType<typeof useNodeLifecycle>, "renameNode" | "openCtxMenu">;
  creation: Pick<ReturnType<typeof useNodeCreation>, "create">;
  nav: {
    openNote: (id: string) => void;
    openTag: (tagId: string) => void;
  };
  onCreateTag: (name: string) => Promise<void>;
};

/**
 * The left navigation sidebar (doc 01 P1): lens-stable like the inspector.
 * Shown inside the notes 3-pane AND as a .workspace-grid col-1 sibling in
 * every other lens, so you can navigate nodes from tasks/tags/timeline
 * without an eject. The two call sites are mutually exclusive by mode.
 *
 * Its one job is the sidebar's groups (sidebarGroups.ts): the memoized
 * OverviewSidebar skips a render only when every group keeps its identity,
 * so every handler is wrapped once here and each group object changes only
 * when a value in it does.
 */
const MoveToSpaceConfirm = lazyWithReload(loadMoveToSpaceConfirm);

export default function WorkspaceSidebar({ drag, rename, lifecycle, creation, nav, onCreateTag }: Props) {
  const t = useT();
  const h = useStableHandlers({
    openNote: nav.openNote,
    openTag: nav.openTag,
    renameNode: lifecycle.renameNode,
    openContextMenu: (e: React.MouseEvent, kind: SidebarMenuKind, nodeId: string, secondaryId?: string) => {
      if (kind === "sidebar-pointer") {
        lifecycle.openCtxMenu(e, { kind, pointerId: nodeId, targetId: secondaryId ?? "", x: e.clientX, y: e.clientY });
      } else {
        lifecycle.openCtxMenu(e, { kind, nodeId, x: e.clientX, y: e.clientY });
      }
    },
    onPointerDown: drag.onSbPointerDown,
    consumeTouchContextMenu: drag.consumeTouchContextMenu,
    toggleGroup: drag.toggleGroup,
    expandAll: drag.expandAllGroups,
    collapseAll: drag.collapseAllGroups,
    create: creation.create,
    onCreateTag,
    setRenamingNodeId: rename.setRenamingNodeId,
    setRenameDraft: rename.setRenameDraft,
  });
  // Handlers only: these never change.
  const groups = useMemo(() => ({
    nav: { openNote: h.openNote, openTag: h.openTag } satisfies SidebarNav,
    // nodeActions' functions are module-level, so already stable.
    actions: { deleteNode: nodeActions.delete, renameNode: h.renameNode, openContextMenu: h.openContextMenu } satisfies SidebarNodeActions,
    create: h.create,
  }), [h]);
  const { sbDragId, sbDropTarget, sbDropSpace, sbTagDropId, sbDragOverlay, expandedGroups, springHint, springOpened, springKept } = drag;
  const tree = useMemo((): SidebarTree => ({
    dragId: sbDragId, dropTarget: sbDropTarget, dropSpaceId: sbDropSpace?.id ?? null, tagDropId: sbTagDropId, springHint, springOpened, springKept, dragOverlay: sbDragOverlay, expandedGroups,
    onPointerDown: h.onPointerDown, consumeTouchContextMenu: h.consumeTouchContextMenu, toggleGroup: h.toggleGroup, expandAll: h.expandAll, collapseAll: h.collapseAll,
  }), [sbDragId, sbDropTarget, sbDropSpace, sbTagDropId, springHint, springOpened, springKept, sbDragOverlay, expandedGroups, h]);
  const { renamingNodeId, renameDraft } = rename;
  const renameGroup = useMemo((): SidebarRename => ({
    nodeId: renamingNodeId, setNodeId: h.setRenamingNodeId, draft: renameDraft, setDraft: h.setRenameDraft,
  }), [renamingNodeId, renameDraft, h]);

  const { sbSpaceMove } = drag;
  return (
    <>
      <OverviewSidebar
        {...groups}
        tree={tree}
        rename={renameGroup}
        onCreateTag={h.onCreateTag}
      />
      {sbSpaceMove && (
        <Suspense fallback={null}>
        <MoveToSpaceConfirm node={sbSpaceMove.node} to={sbSpaceMove.to}
          parentTitle={sbSpaceMove.parentId ? drag.nodeTitle(sbSpaceMove.parentId) : null}
          title={t("Move “{title}” to…", { title: displayTitle(sbSpaceMove.node.title) })} backLabel={t("Cancel")}
          onBack={drag.cancelSpaceMove} onClose={drag.cancelSpaceMove} onMoved={() => void drag.finishSpaceMove()} />
        </Suspense>
      )}
    </>
  );
}
