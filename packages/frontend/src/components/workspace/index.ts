// The notes workspace's panes and the shell's shared overlays, laid out by
// BuilderApp.
export { default as NotesWorkspace } from "./NotesWorkspace";
export { default as NotesCenter } from "./NotesCenter";
export { default as WorkspaceSidebar } from "./WorkspaceSidebar";
export { default as WorkspaceInspector } from "./WorkspaceInspector";
// The right-click menu loads on first use (BuilderWorkspace), so it is a loader, not an export.
export const loadWorkspaceContextMenu = () => import("./WorkspaceContextMenu");
// The ⌘K palette and its engine load when it first opens (WorkspaceOverlays; lib/offlineWarmup.ts fetches them ahead).
export const loadPaletteHost = () => import("./PaletteHost");
export { default as WorkspaceOverlays } from "./WorkspaceOverlays";
export { useWorkspaceChunks, useOfflineWarmup } from "./bootHooks";
