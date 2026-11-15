// Parts of the shell that a module switches on, named by what they are rather
// than by the module that supplies them. The whiteboard's boards and day notes
// are woven into core screens (the sidebar, the palette, the home page, quick
// capture), so those ask "is this feature on" — never "is module X imported".
// A module declares the feature it supplies (FrontendModule.shellFeature);
// modules/index registers it here when it loads. A leaf with no imports, so
// lib/data and lib/dayNode can ask without importing the module registry (which
// imports lib/data).

/** whiteboard: boards, a note's board lens and memberships (modules/canvas).
 *  day-notes: today's note, the Journal, the day template (modules/daily).
 *  tasks: the Tasks page, quick-add and the journal's task list (modules/tasks).
 *  ai: the info panel's AI tab, @-mentions, 「交給 AI」, the AI actions on a selection or paragraph,
 *  pending AI suggestions, AI roles and keys in Settings, the 「AI 改過」 history filter (modules/ai).
 *  ext-calendars: events from subscribed calendars on the day timeline (modules/external_calendars).
 *  meaning-search: notes found by meaning, after the exact matches, in the one note search (modules/semantic). */
export type ShellFeature = "whiteboard" | "day-notes" | "tasks" | "ai" | "ext-calendars" | "meaning-search";

const providers = new Map<ShellFeature, string>();
const alwaysOnFeatures = new Set<ShellFeature>();

/** `alwaysOn`: the supplying module has no switch, so the feature is on
 *  whatever a workspace's stored module list says (modules/index isAlwaysOn). */
export function registerShellFeature(feature: ShellFeature, moduleId: string, alwaysOn = false): void {
  const existing = providers.get(feature);
  if (existing && existing !== moduleId) throw new Error(`[modules] shell feature ${feature} is supplied by both ${existing} and ${moduleId}`);
  providers.set(feature, moduleId);
  if (alwaysOn) alwaysOnFeatures.add(feature);
}

/** The id of the module that supplies `feature`. Throws before modules/index
 *  has loaded: an answer from a missing registry would silently say "off". */
export function shellFeatureModule(feature: ShellFeature): string {
  const id = providers.get(feature);
  if (!id) throw new Error(`[modules] no module supplies the ${feature} feature (modules/index not loaded?)`);
  return id;
}

/** Whether `feature` is on for a workspace's stored module list (absent or
 *  null = every module: an older server or a workspace from before the library,
 *  as modules/index moduleFilterFor). */
export function shellFeatureOnIn(modules: readonly string[] | null | undefined, feature: ShellFeature): boolean {
  return !Array.isArray(modules) || alwaysOnFeatures.has(feature) || modules.includes(shellFeatureModule(feature));
}
