import { useMemo } from "react";
import { useAppSelector } from "../lib/appStore";
import { linkSuggestionsShown, moduleFilterFor, moduleStatusFor, type ModuleFilter, type ModuleStatusOf } from "../modules";
import { useShellFeature } from "./useShellFeature";

/** The workspace's modules that are on, as a filter (module library). Surfaces
 *  that list modules pass it to the registry so modules that are off stay out. */
export function useModuleFilter(): ModuleFilter {
  const modules = useAppSelector((s) => s.data.workspace?.modules);
  return useMemo(() => moduleFilterFor(modules), [modules]);
}

/** Where each module stands: on, off, or waiting for the owner's one-time yes
 *  (modules/index moduleStatusFor). */
export function useModuleStatus(): ModuleStatusOf {
  const modules = useAppSelector((s) => s.data.workspace?.modules);
  const toConfirm = useAppSelector((s) => s.data.workspace?.modules_to_confirm);
  return useMemo(() => moduleStatusFor(modules, toConfirm), [modules, toConfirm]);
}

export { useShellFeature, useTasksEnabled, useAiEnabled } from "./useShellFeature";

/** Whether the workspace has the whiteboard (白板) on. When not, every
 *  whiteboard entry is hidden and its boards are kept (modules/canvas). */
export function useCanvasImported(): boolean {
  return useShellFeature("whiteboard");
}

/** Whether daily notes (日記) are on. When not, the Today entries, the home
 *  mood picker, the day template and the journal page are hidden; day notes
 *  are kept as ordinary notes. */
export function useDailyNotesEnabled(): boolean {
  return useShellFeature("day-notes");
}

/** Whether a board draws related-note suggestions: only while the module
 *  that files them (semantic search) is on. The edges are kept. */
export function useLinkSuggestionsShown(): boolean {
  return linkSuggestionsShown(useModuleFilter());
}
