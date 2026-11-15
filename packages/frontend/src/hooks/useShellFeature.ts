import { useAppSelector } from "../lib/appStore";
import { shellFeatureOnIn, type ShellFeature } from "../lib/shellFeatures";

// Apart from useModuleFilter so a module's own screens can ask whether their
// feature is on without importing the module registry (which imports them).

/** Whether a shell feature (lib/shellFeatures) is on in this workspace. */
export function useShellFeature(feature: ShellFeature): boolean {
  const modules = useAppSelector((s) => s.data.workspace?.modules);
  return shellFeatureOnIn(modules, feature);
}

/** Whether tasks (任務) are on. When not, the Tasks page, quick-add and the
 *  journal's task list are hidden; tasks are kept (modules/tasks). */
export function useTasksEnabled(): boolean {
  return useShellFeature("tasks");
}

/** Whether AI is on. When not, every AI entry is hidden (the info panel's AI tab,
 *  @-mentions, 「交給 AI」, suggestions, roles and keys); its data is kept (modules/ai). */
export function useAiEnabled(): boolean {
  return useShellFeature("ai");
}
