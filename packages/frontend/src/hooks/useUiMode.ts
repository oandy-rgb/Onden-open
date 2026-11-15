// Top-level UI mode coordination for BuilderApp.
//
// Extracted from BuilderApp.tsx during Day 4 hook refactor. Bundles
// related mode-toggling state used to switch between top-level views
// (notes/tasks/website/timeline) and sub-views (editor/canvas,
// mobile tab choice, action panel).
//
// Reference: trilium-main `note_context.ts` keeps the active-view bundle
// in one place; same shape here, just plain hooks instead of a class.

import { useCallback, useState } from "react";
import type { NodeLens } from "../lib/nodeLens";
import { focusSidebarTags, setSelectedId } from "../lib/appStore";
import { navigate, phoneStacks } from "./useUrlLocation";

// Tags are no destination: tag NODES open in notes (schema lens) and the
// sidebar lists them (components/SidebarTagTree); packs live in Settings.
export type CoreMode = "notes" | "today" | "tasks" | "timeline" | "graph";
/** A core mode, or the id of a module screen (modules/index MODULE_SCREENS). */
export type AppMode = CoreMode | (string & {});
export type NotesView = NodeLens;
export type MobileView = "nodes" | "graph" | "inspector" | "events";
// D6: "tags" drawer retired — tag shaping lives on the tag node's schema lens.
// Module screens are full pages (modes), never drawers.
export type OverviewMobileTab = "list" | "edit" | "info";

export function useUiMode(initialMode: AppMode = "notes", initialNotesView: NotesView = "editor", initialViewTab: string | null = null) {
  const [mode, setModeRaw] = useState<AppMode>(initialMode);
  const [notesView, setNotesView] = useState<NotesView>(initialNotesView);
  // The open saved-view tab of the focused note or tag (its view id), in the
  // editor lens; null = 「內容」 (or the whiteboard, which is the canvas lens).
  const [viewTab, setViewTab] = useState<string | null>(initialViewTab);
  const [mobileView, setMobileView] = useState<MobileView>("graph");
  const [overviewMobileTab, setOverviewMobileTab] = useState<OverviewMobileTab>("list");

  // 「前往標籤」: the notes home with the sidebar's tag list open and focused
  // (the desktop's section, the phone's 標籤 tab).
  const showTags = useCallback(() => {
    setModeRaw("notes");
    setOverviewMobileTab("list");
    // The phone's list level is the notes page with nothing opened.
    if (phoneStacks()) navigate(() => setSelectedId(null), { history: "push" });
    focusSidebarTags();
  }, []);

  return {
    mode,
    setMode: setModeRaw,
    showTags,
    notesView,
    setNotesView,
    viewTab,
    setViewTab,
    mobileView,
    setMobileView,
    overviewMobileTab,
    setOverviewMobileTab,
  };
}
