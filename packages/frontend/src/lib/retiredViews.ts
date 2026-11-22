// Pages that no longer exist, and where an address that still names one goes instead. One rule, read by every way a place
// is named: the address's `view=` (hooks/useUrlLocation parseLocation) and the side-by-side pane (`right=page:…` and the
// saved pane, lib/splitViewStore).
import { getWorkspaceModules } from "./appStore";
import { shellFeatureOnIn } from "./shellFeatures";

/** 「今天」 was a page (2026-11-13 to 11-18) and is gone: a place that still says `today` is 任務, else 日記, else 筆記.
 *  Before the workspace has loaded its module list every module counts as on (shellFeatureOnIn). */
export function viewOfRetiredToday(modules: readonly string[] | null | undefined = getWorkspaceModules()): "tasks" | "daily" | "notes" {
  if (shellFeatureOnIn(modules, "tasks")) return "tasks";
  if (shellFeatureOnIn(modules, "day-notes")) return "daily";
  return "notes";
}
