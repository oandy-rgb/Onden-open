// The left sidebar's inputs, grouped by what they are for (depth audit D4).
// WorkspaceSidebar builds each group once with a stable identity; the
// memoized OverviewSidebar and its parts take the groups they use. Store data
// (nodes, selection, pane, search, tags) is not here: the parts read it from
// lib/appStore themselves.

import type { ContentNode } from "../lib/api";

/** Where the sidebar can send the person. */
export type SidebarNav = {
  openNote: (id: string) => void;
  /** Open a tag's page (by id). */
  openTag: (tagId: string) => void;
};

/** Where a row's context menu opens from. */
export type SidebarMenuKind = "sidebar-node" | "sidebar-pointer";

/** What a row can do to its note. */
export type SidebarNodeActions = {
  deleteNode: (id: string) => void;
  /** A hidden note is shown in the list again. */
  renameNode: (id: string, draft: string) => void;
  /** For a pointer row, `nodeId` is the pointer and `secondaryId` its target. */
  openContextMenu: (e: React.MouseEvent, kind: SidebarMenuKind, nodeId: string, secondaryId?: string) => void;
};

/** Rename-in-place, shared with the context menu's "Rename". */
export type SidebarRename = {
  nodeId: string | null;
  setNodeId: (id: string | null) => void;
  draft: string;
  setDraft: (draft: string) => void;
};

/** Tree drag state and group expansion (owned by the shell: the sidebar
 *  remounts on a mode switch, and would reopen groups the person closed). */
export type SidebarTree = {
  dragId: string | null;
  /** `moveTo`: the space (label) a drop here would move the note to, after a confirmation. */
  dropTarget: { id: string; pos: "above" | "below" | "into"; moveTo?: string } | null;
  /** The space heading a held note would be moved under (to that space's top level). */
  dropSpaceId: string | null;
  /** The tag row a held note would be tagged by (the tag list's drop highlight). */
  tagDropId: string | null;
  /** The folded row a held note is waiting over (it opens after `ms`), for its hint. */
  springHint: { id: string; ms: number } | null;
  /** Rows opened by that wait: shown open for this drag only (already part of `expandedGroups`). */
  springOpened: ReadonlySet<string>;
  /** Tags a drop kept open (the tag list adds them to its own open set). */
  springKept: ReadonlySet<string>;
  dragOverlay: { title: string; isGroup: boolean; x: number; y: number; width: number; height: number; moveTo?: string } | null;
  expandedGroups: Set<string>;
  /** `onHoldRelease`: a touch held and let go in place (open the row's menu). */
  onPointerDown: (e: React.PointerEvent, item: ContentNode, isGroup: boolean, onHoldRelease?: (x: number, y: number) => void) => void;
  /** True (and the event swallowed) while a touch press owns the gesture. */
  consumeTouchContextMenu: (e: React.MouseEvent) => boolean;
  toggleGroup: (id: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
};

/** The agent-review queues (D7) as the inbox pane shows them. */
export type { SidebarInbox } from "../hooks/sidebarInboxTypes";
