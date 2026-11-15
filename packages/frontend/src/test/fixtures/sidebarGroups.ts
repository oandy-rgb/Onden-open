// OverviewSidebar's groups (components/sidebarGroups.ts) with mock handlers,
// for tests that mount the sidebar without the shell. Pass `tree` overrides
// for expanded groups or a drag in progress.
import { vi } from "vitest";
import type { SidebarTree } from "../../components/sidebarGroups";

export function sidebarGroups(opts: { tree?: Partial<SidebarTree> } = {}) {
  return {
    nav: { openNote: vi.fn(), openTag: vi.fn() },
    actions: { deleteNode: vi.fn(), renameNode: vi.fn(), openContextMenu: vi.fn() },
    rename: { nodeId: null, setNodeId: vi.fn(), draft: "", setDraft: vi.fn() },
    tree: {
      dragId: null, dropTarget: null, dropSpaceId: null, tagDropId: null, springHint: null, springOpened: new Set<string>(), springKept: new Set<string>(), dragOverlay: null, expandedGroups: new Set<string>(),
      onPointerDown: vi.fn(), consumeTouchContextMenu: vi.fn(() => false), toggleGroup: vi.fn(), expandAll: vi.fn(), collapseAll: vi.fn(),
      ...opts.tree,
    },
    create: vi.fn(),
  };
}
