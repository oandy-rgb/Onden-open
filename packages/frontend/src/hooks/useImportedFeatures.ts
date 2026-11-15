import { useMemo } from "react";
import { useTagRows, useAllNodes } from "../lib/appStore";
import { moduleTagOf } from "../lib/tagModules";
import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import { BUILT_IN_MODULES, MODULES, moduleEntry, moduleInUse, useSubscriptionCount, type ModuleFilter, type NavGroupPlacement, type NavIndicatorProps } from "../modules";
import type { Tag } from "../lib/api";
import { useModuleFilter } from "./useModuleFilter";
import type { ModuleUseData } from "../lib/moduleUse";

/** One feature that is on: what it opens (`opens`, see modules/moduleEntry),
 *  its module tag (#複習) and its nav mark (FrontendModule.NavIndicator),
 *  when it has them. `inUse` (lib/moduleUse) only decides whether the default
 *  nav layout puts its page in a bar; 「更多」 lists it either way. Every nav
 *  surface takes the mark from here. */
/** What the navigation reads of a module: its id and the name and icon of its entry. */
export type FeatureModule = { id: string; library: { title: string; Icon: LucideIcon; navGroup?: NavGroupPlacement } };
export type ImportedFeature = { mod: FeatureModule; opens: boolean; tag: Tag | null; inUse: boolean; Indicator?: ComponentType<NavIndicatorProps> | null };

/** The features that are on, in registry order: each module that has
 *  something to open or a module tag, then the built-in modules that have a
 *  page of their own (always on; in 更多 until pinned: `inUse` is false). The top bar and the phone's 「更多」
 *  sheet both take them (hooks/shellNavigation), so the two never
 *  disagree. `use` absent counts every feature as in use (callers that list
 *  what exists). */
export function importedFeatures(isImported: ModuleFilter, tags: readonly Tag[], use?: ModuleUseData): ImportedFeature[] {
  const features = MODULES.filter((mod) => isImported(mod.id)).flatMap((mod): ImportedFeature[] => {
    const opens = moduleEntry(mod.id) !== null;
    const tag = mod.library.moduleTag ? moduleTagOf(tags, mod.id) : null;
    return opens || tag ? [{ mod, opens, tag, inUse: !use || moduleInUse(mod.id, use), Indicator: mod.NavIndicator ?? null }] : [];
  });
  const builtIn = BUILT_IN_MODULES.flatMap(({ id, screen, NavIndicator }): ImportedFeature[] =>
    screen && screen.inNav !== false ? [{ mod: { id, library: { title: screen.label, Icon: screen.Icon } }, opens: true, tag: null, inUse: !use, Indicator: NavIndicator ?? null }] : []);
  return [...features, ...builtIn];
}

export function useImportedFeatures(): ImportedFeature[] {
  const isImported = useModuleFilter();
  const tags = useTagRows();
  const nodes = useAllNodes();
  const subscriptions = useSubscriptionCount(isImported);
  return useMemo(() => importedFeatures(isImported, tags ?? [], { nodes: nodes ?? [], tags: tags ?? [], subscriptions }), [isImported, tags, nodes, subscriptions]);
}
