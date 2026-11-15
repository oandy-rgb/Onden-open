import { openOverviewSearch, selectCanvases, setOverviewPane, setOverviewView, setSelectedId, useAppSelector, useOnline, useSelectedId, useAllNodes } from "../lib/appStore";
import { canvasWriter, drafts } from "../lib/data";
import { useCapabilities } from "../lib/capabilities";
import type { useAppData } from "../lib/useAppData";
import type { UseCommandPaletteOptions } from "./useCommandPalette";
import type { useBoardWorkspace } from "./useBoardWorkspace";
import { usePaletteState } from "./usePaletteState";
import type { useCreateDialog } from "./useCreateDialog";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import type { useNodeCreation } from "./useNodeCreation";
import { useNoteExport } from "./useNoteExport";
import { useStableCallback } from "./useStableCallback";
import type { useUiMode } from "./useUiMode";
import type { useWorkspaceFocus } from "./useWorkspaceFocus";
import type { useWorkspaceModules } from "./useWorkspaceModules";
import type { useWorkspacePanes } from "./useWorkspacePanes";
import { isNote } from "@onden/markdown/contract";

type Options = {
  ui: Pick<ReturnType<typeof useUiMode>, "mode" | "setMode" | "showTags" | "notesView" | "setNotesView">;
  focus: Pick<ReturnType<typeof useWorkspaceFocus>, "selectedNode" | "openNote" | "openBoardId" | "goBack" | "canGoBack" | "goForward" | "canGoForward">;
  createDialog: Pick<ReturnType<typeof useCreateDialog>, "createOpen" | "setCreateOpen">;
  creation: Pick<ReturnType<typeof useNodeCreation>, "create" | "openDailyNote" | "exportMarkdown">;
  board: Pick<ReturnType<typeof useBoardWorkspace>, "tidyActiveCanvas" | "autoArrangeCanvasAsTree" | "canvasSearch" | "setCanvasSearch">;
  modules: Pick<ReturnType<typeof useWorkspaceModules>, "openModule" | "runNoteCommand" | "openDialogEntry">;
  panes: Pick<ReturnType<typeof useWorkspacePanes>, "setFocusMode" | "toggleSidebar" | "toggleInspector" | "toggleFocus">;
  createNodeRaw: ReturnType<typeof useAppData>["createNode"];
  /** Ctrl+\\: open the current tab beside, or close the right side (hooks/useSplitView). */
  toggleSplit?: () => void;
  /** Whether the focused node earns a Canvas lens (a board or children). */
  canvasAvailable: boolean;
  refresh: () => Promise<void>;
  openSettings: () => void;
  /** The colour dialog for one note (a component, so the shell passes it in). */
  openNoteColor: (nodeId: string) => void;
};

/**
 * Commands on the workspace: the ⌘K palette, the global keyboard shortcuts,
 * and the note header's actions — one set of handlers for all three.
 */
export function useWorkspaceCommands({
  ui, focus, createDialog, creation, board, modules, panes, toggleSplit,
  createNodeRaw, canvasAvailable, refresh, openSettings, openNoteColor,
}: Options) {
  const { mode, setMode, showTags, notesView, setNotesView } = ui;
  const { selectedNode, openNote } = focus;
  const nodes = useAllNodes();
  const canvases = useAppSelector(selectCanvases);
  const activeCanvasId = useAppSelector((s) => s.activeCanvas?.id ?? null);
  const selectedId = useSelectedId();
  const online = useOnline();
  const capabilities = useCapabilities(online);

  const noteExport = useNoteExport(mode === "notes" && notesView === "editor" && isNote(selectedNode));

  const paletteState = usePaletteState();
  const paletteOptions: UseCommandPaletteOptions = {
    setMode,
    showTags,
    setNotesView,
    setSelectedId,
    setCreateOpen: createDialog.setCreateOpen,
    setOverviewPane,
    refresh,
    nodes,
    canvases,
    activeCanvasId,
    selectedNode,
    selectCanvas: canvasWriter.select,
    capabilities,
    // Gate the palette's "Switch to Canvas" exactly like the strip's Canvas tab.
    canvasAvailable,
    // Command-palette "Create note '<query>'" — search-and-capture in one gesture.
    createNamedNote: async (title: string) => {
      const n = await createNodeRaw(title, "markdown", nodes.length);
      if (n) { openNote(n.id); setNotesView("editor"); }
      return !!n;
    },
    create: creation.create,
    openDailyNote: async () => !!(await creation.openDailyNote()),
    exportMarkdown: creation.exportMarkdown,
    tidyActiveCanvas: board.tidyActiveCanvas,
    exportNoteHtml: () => noteExport.exportNote("html"),
    copyNoteMarkdown: noteExport.copyMarkdown,
    autoArrangeCanvasAsTree: board.autoArrangeCanvasAsTree,
    openModule: modules.openModule,
    runNoteCommand: modules.runNoteCommand,
    openDialogEntry: modules.openDialogEntry,
    openNoteColor,
    toggleSidebar: panes.toggleSidebar,
    toggleInspector: panes.toggleInspector,
    toggleFocusMode: panes.toggleFocus,
    openSettings,
  };
  const openPalette = useStableCallback(() => { paletteState.setPaletteOpen(true); paletteState.setPaletteQuery(""); });

  // Global keyboard shortcuts + context-menu dismiss.
  useKeyboardShortcuts({
    boardOpen: focus.openBoardId !== null,
    mode,
    notesView,
    selectedId,
    setSelectedId,
    createOpen: createDialog.createOpen,
    setCreateOpen: createDialog.setCreateOpen,
    createNote: () => creation.create("note"),
    canvasSearch: board.canvasSearch,
    setCanvasSearch: board.setCanvasSearch,
    onOpenOverviewSearch: openOverviewSearch,
    setPaletteOpen: paletteState.setPaletteOpen,
    setPaletteQuery: paletteState.setPaletteQuery,
    setPaletteIndex: paletteState.setPaletteIndex,
    saveOverviewDraft: () => selectedNode ? drafts.save(selectedNode.id) : undefined,
    setOverviewView,
    openDailyNote: creation.openDailyNote,
    toggleInspector: panes.toggleInspector,
    toggleSidebar: panes.toggleSidebar,
    toggleSplit,
    setFocusMode: panes.setFocusMode,
    history: focus,
  });

  // Per-note header actions (the editor's ⋯ menu) — the same wiring the
  // palette calls.
  const noteActions = {
    exportNote: noteExport.exportNote,
    copyMarkdown: noteExport.copyMarkdown,
    exportBusy: noteExport.busy,
    runNoteCommand: modules.runNoteCommand,
  };

  return { palette: { state: paletteState, options: paletteOptions }, openPalette, noteActions };
}
