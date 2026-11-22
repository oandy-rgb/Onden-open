// Frontend module registry — the twin of packages/backend/src/modules/index.ts.
// The shell reads every module surface from here (screens, home and inbox
// sections, commands, settings, tag functions) and never names a module.
// Removing a module is deleting its directory and its line below. Keep the
// tag-function ids equal to the backend modules declaring `tagFunction: true`
// (checked by test/tagFunctionRegistry.test.ts).

import { functionModule, moduleTagOf, tagHasModule, type TagAbilities, type TagFunctionSpec } from "../lib/tagModules";
import { sortDayItems, type DayItem } from "@onden/markdown";
import type { BuiltInModule, NoteViewModule, DayItemsContext, DialogEntry, FrontendModule, NoteSwitchSpec, TagPageSectionProps, ModuleScreen, NoteCommand, ReadingSection, SitePublisher } from "./types";
import { Sparkles, type LucideIcon } from "lucide-react";
import type { Tag } from "../lib/api";
import type { SettingDef } from "../lib/settingsTypes";
import { tagUsed, type ModuleUseData } from "../lib/moduleUse";
import { registerShellFeature } from "../lib/shellFeatures";
import { nodeHasTag, registerAppliedByAppModule, registerNoteSwitchModule } from "../lib/nodeTags";
import { getAppState } from "../lib/appStore";
import { t } from "../lib/i18n";
import { reviewModule } from "./review";
import { rssModule, useRssSourceCount } from "./rss";
import { externalCalendarsModule } from "./external_calendars";
import { websiteModule } from "./website";
import { canvasModule } from "./canvas";
import { skillsModule } from "./skills";
import { slidesModule } from "./slides";
import { tableViewModule, loadTableLayout } from "./table";
import { calendarViewModule, loadCalendarLayout } from "./calendar";
import { kanbanViewModule, loadKanbanLayout } from "./kanban";
import { galleryViewModule, loadGalleryLayout } from "./gallery";
import { semanticModule } from "./semantic";
import { dailyModule } from "./daily";
import { tasksModule, loadQuickAddSheet } from "./tasks";
import { importersModule } from "./importers";
import { graphModule } from "./graph";
import { captureModule, loadQuickCapture } from "./capture";
import { handwritingModule } from "./handwriting";
import { aiModule } from "./ai";
import { isNote } from "@onden/markdown/contract";

export type * from "./types";
// The Graph place's screen (core reaches it here, not in modules/graph).
export { GraphScreen } from "./graph";
// The Tasks page and quick-add sheet are shell parts (core mode, palette, overlays)
// that live in the tasks module; core reaches them here, not in modules/tasks.
export { TasksMode, loadTasksMode, QuickAddTask, openQuickAddTask, TaskSheetHost, openTaskSheet, FocusHost, FocusTopMark } from "./tasks";
// The day's timeline with 規劃今天 / 收工 sits on the Tasks page and on the Journal page: modules do
// not import each other, they meet here.
export { DayPlanner } from "./daily"; // the lazy day/DayPane
// Quick capture: the box the shell mounts and opens, and the rule that keeps
// unfiled captures out of the note tree (lib/sidebarTidy).
export { QuickCapture, openQuickCapture, isPendingCapture, pendingCaptures, capturesOnDay } from "./capture";

/** Modules that are always available (no switch, not in Settings › Features).
 *  Their backend twins are the backend modules without `library`. */
export const BUILT_IN_MODULES: readonly BuiltInModule[] = [importersModule, graphModule, captureModule, handwritingModule];

/** The inbox page (modules/capture). It is no nav destination: the shell shows it as
 *  the phone's third 筆記 tab and the desktop sidebar's first row (`id` is what
 *  requestOpenFeature takes to open it in the main area). `Mark` counts what waits. */
export const INBOX_PAGE = captureModule.screen
  ? { id: captureModule.id, Component: captureModule.screen.Component, Mark: captureModule.NavIndicator ?? null }
  : null;

/** The built-in modules' settings, each in the tab of Settings it names (Data and
 *  backup › Import, 快速記錄, 手寫). They are always on, so none sits on a feature's page. */
export const BUILT_IN_SETTINGS: readonly SettingDef[] = BUILT_IN_MODULES.flatMap((m) => m.settings ?? []);

export const MODULES: readonly FrontendModule[] = [reviewModule, rssModule, websiteModule, canvasModule, skillsModule, slidesModule, tableViewModule, calendarViewModule, kanbanViewModule, galleryViewModule, semanticModule, dailyModule, tasksModule, aiModule, externalCalendarsModule];

// Core screens that cannot be one module screen ask for a shell feature
// (lib/shellFeatures) the module supplies, not for the module by id.
for (const mod of MODULES) if (mod.shellFeature) registerShellFeature(mod.shellFeature, mod.id, isAlwaysOn(mod));
// A note switch keeps its module tag out of every list (lib/nodeTags isNoteSwitchTag).
for (const mod of MODULES) if (mod.noteSwitch) registerNoteSwitchModule(mod.id);
// A tag only its module applies is in no tag picker (lib/nodeTags isAppliedByAppTag).
for (const mod of BUILT_IN_MODULES) if (mod.appliesOwnTag) registerAppliedByAppModule(mod.id);

/** The imported modules' note switches, in registry order. The info panel shows
 *  one only while it is on (components/NoteSwitches); an off one is turned on
 *  from the note's ⋯ menu or ⌘K (NOTE_COMMANDS below). */
export function noteSwitchesOf(isImported: ModuleFilter = ALL_MODULES): Array<{ moduleId: string; Icon: LucideIcon; spec: NoteSwitchSpec }> {
  return MODULES.flatMap((mod) => mod.noteSwitch && isImported(mod.id) ? [{ moduleId: mod.id, Icon: mod.library.Icon, spec: mod.noteSwitch }] : []);
}

/** The imported modules' sections for a tag page, in registry order. */
export function tagPageSectionsOf(isImported: ModuleFilter = ALL_MODULES): Array<{ moduleId: string; Section: NonNullable<FrontendModule["tagPageSection"]> }> {
  return MODULES.flatMap((mod) => mod.tagPageSection && isImported(mod.id) ? [{ moduleId: mod.id, Section: mod.tagPageSection }] : []);
}
export type { TagPageSectionProps };

/** Code that modules load on use but that must work offline: lib/offlineWarmup
 *  fetches these once while online so the service worker keeps them (each is the
 *  same file the module's lazyWithReload loads). */
export async function loadOfflineModuleScreens(): Promise<void> {
  await loadQuickCapture();
  // Each module's rows on the info panel's 功能 tab (hooks/useNoteFunctions loads them when the panel opens).
  await Promise.all(MODULES.map((mod) => mod.noteFunctionRows?.()));
  await loadQuickAddSheet();
  await Promise.all([loadTableLayout(), loadCalendarLayout(), loadKanbanLayout(), loadGalleryLayout()]);
}

/** The word `{word}` a module recognises on a checkbox line (tasks: `task`), or null when it has none. The editor
 *  writes it to make a line a task; the module's own save turns it into a task (it is never a tag). */
export function moduleLineWord(moduleId: string, tags: readonly Tag[] = []): string | null {
  const word = MODULES.find((m) => m.id === moduleId)?.library.lineWord ?? null;
  if (word === null) return null;
  // The workspace's word is the module tag's current name while that tag exists (renamed, or `任務` because a plain
  // `task` tag was there first); with no module tag, the word, unless the user's own tag already has that name
  // (the backend, services/tasksStore.taskLineWord, answers the same).
  const own = moduleTagOf(tags, moduleId);
  if (own) return own.name;
  return tags.some((tag) => tag.name.toLowerCase() === word) ? ALT_LINE_WORD[moduleId] ?? word : word;
}
const ALT_LINE_WORD: Readonly<Record<string, string>> = { tasks: "任務", review: "複習" };

/** The skills module's id, for the shell's 「存成技能」 (lib/createSkillNote). */
export const SKILLS_MODULE = skillsModule.id;

/** The modules that file related-note suggestions (semantic search). A
 *  board draws suggestions only while one of them is imported. */
const SUGGESTION_MODULES: readonly string[] = MODULES.filter((m) => m.suggestsLinks).map((m) => m.id);

/** Whether suggested links are shown, given the imported modules. */
export function linkSuggestionsShown(isImported: ModuleFilter): boolean {
  return SUGGESTION_MODULES.some((id) => isImported(id));
}

/** Which modules the workspace has imported (module library). Every surface
 *  below takes one; the default shows every module (tests, older servers). */
export type ModuleFilter = (id: string) => boolean;
export const ALL_MODULES: ModuleFilter = () => true;

/** The filter for a workspace's list of modules that are on; absent/null =
 *  every module (an older server or local copy). */
export function moduleFilterFor(modules: readonly string[] | null | undefined): ModuleFilter {
  if (!Array.isArray(modules)) return ALL_MODULES;
  const imported = new Set(modules);
  // Always-on and built-in modules are never switched (2026-10-28), whatever the list says.
  return (id) => imported.has(id) || ALWAYS_ON_IDS.has(id) || isBuiltInModuleId(id);
}

function isBuiltInModuleId(id: string): boolean {
  return BUILT_IN_MODULES.some((mod) => mod.id === id);
}

/** Where a built-in module stands: `on`; `off` (the owner turned it off, data
 *  kept); `ask` (it spends money, reaches outside websites or publishes, so it
 *  waits for the owner's one-time yes — then it is on, and never asks again
 *  even if turned off and on). */
export type ModuleStatus = "on" | "off" | "ask";
export type ModuleStatusOf = (id: string) => ModuleStatus;

export function moduleStatusFor(modules: readonly string[] | null | undefined, toConfirm: readonly string[] | null | undefined): ModuleStatusOf {
  const on = moduleFilterFor(modules);
  const ask = new Set(toConfirm ?? []);
  return (id) => on(id) ? "on" : ask.has(id) ? "ask" : "off";
}

const siteModule = MODULES.find((m) => m.sitePublisher);
/** The module that publishes notes as a site, if this build ships one. */
export const SITE_MODULE: string | null = siteModule?.id ?? null;
/** Its operations (the first-run intro site), if this build ships one. */
export const SITE_PUBLISHER: SitePublisher | null = siteModule?.sitePublisher ?? null;

/** source_types of notes the modules create by themselves (sidebarTidy). */
export const GENERATED_SOURCE_TYPES: ReadonlySet<string> = new Set(MODULES.flatMap((m) => m.generatedSourceTypes ?? []));

/** The imported modules, in registry order. */
export function importedModules(isImported: ModuleFilter = ALL_MODULES): FrontendModule[] {
  return MODULES.filter((m) => isImported(m.id));
}

/** Everything the imported modules put on one day of the 日子 page, in time order
 *  (timed first). Each module hands over what it knows from the local copy. */
export function collectDayItems(context: DayItemsContext, isImported: ModuleFilter = ALL_MODULES): DayItem[] {
  return sortDayItems(MODULES.filter((m) => isImported(m.id)).flatMap((m) => m.dayItems?.(context) ?? []));
}

/** A module's own add dialog, opened from its tag page and the palette. */
export function dialogEntryOf(moduleId: string): DialogEntry | undefined {
  return MODULES.find((m) => m.id === moduleId)?.dialogEntry;
}

export const TAG_FUNCTIONS: readonly TagFunctionSpec[] = MODULES.flatMap((m) => m.tagFunction ? [m.tagFunction].flat() : []);

/** The registered functions notes with this tag get, in registry order (its
 *  module tag identity, what it extends, legacy switches); a module that is
 *  not imported provides nothing. */
export function enabledTagFunctions(tag: TagAbilities, isImported: ModuleFilter = ALL_MODULES): TagFunctionSpec[] {
  return TAG_FUNCTIONS.filter((fn) => isImported(functionModule(fn)) && tagHasModule(tag, fn.id));
}

/** Module screens, keyed by module id (also the `?view=` value). */
export const MODULE_SCREENS: ReadonlyMap<string, ModuleScreen> = new Map(
  [...MODULES, ...BUILT_IN_MODULES].flatMap((m) => m.screen ? [[m.id, m.screen] as const] : []),
);

/** Every reading-hub section, in hub order, with the module that adds it. */
export const READING_SECTIONS: ReadonlyArray<ReadingSection & { moduleId: string }> = MODULES
  .flatMap((m) => (m.readingSections ?? []).map((section) => ({ ...section, moduleId: m.id })))
  .sort((a, b) => a.order - b.order);

/** The reading hub's sections from imported modules. No sections, no hub. */
export function readingSectionsFor(isImported: ModuleFilter = ALL_MODULES): Array<ReadingSection & { moduleId: string }> {
  return READING_SECTIONS.filter((s) => isImported(s.moduleId));
}

export function isReadingSection(view: string): boolean {
  return READING_SECTIONS.some((s) => s.id === view);
}

/** A full-page view: a module screen or a reading-hub section. */
export function isModuleScreen(view: string): boolean {
  return MODULE_SCREENS.has(view) || isReadingSection(view);
}

/** Where opening a module lands: its screen or its first reading section.
 *  Null for a module with nothing of its own to open (the whiteboard is one:
 *  boards are notes, found in the note list and made from the create sheet). */
export function moduleEntry(id: string): { view: string } | null {
  const mod = [...MODULES, ...BUILT_IN_MODULES].find((m) => m.id === id);
  if (!mod) return null;
  const view = mod.screen ? id : "readingSections" in mod ? mod.readingSections?.[0]?.id : undefined;
  return view ? { view } : null;
}

/** Whether a function is in use in this workspace (the module's own rule, else
 *  its module tag being used): the default nav layout bars only these
 *  (hooks/useImportedFeatures `inUse`); 「更多」 lists them all. */
export function moduleInUse(id: string, data: ModuleUseData): boolean {
  const mod = MODULES.find((m) => m.id === id);
  return mod?.library.inUse ? mod.library.inUse(data) : tagUsed(id, data);
}

/** Feeds the person can see, for `ModuleUseData.subscriptions`: subscriptions are a
 *  server table the note list cannot show, so the count rides the reader's shared
 *  poll (a hook; it fetches nothing while the module is off). */
export function useSubscriptionCount(isImported: ModuleFilter): number {
  return useRssSourceCount(isImported("rss"));
}

/** The `/` menu items of every module, with the module that adds each. */
export const SLASH_INSERTS = MODULES.flatMap((m) => (m.slashInserts ?? []).map((insert) => ({ moduleId: m.id, insert })));

/** The `/` menu items of the imported modules (the editor's menu and the palette). */
export function slashInsertsOf(isImported: ModuleFilter = ALL_MODULES): typeof SLASH_INSERTS {
  return SLASH_INSERTS.filter(({ moduleId }) => isImported(moduleId));
}

/** A note switch that is off, as a note command that turns it on (lib/noteSwitch). */
function switchOnCommand(moduleId: string, spec: NoteSwitchSpec): NoteCommand {
  return {
    id: `switch-${moduleId}`,
    label: spec.label,
    keywords: [moduleId],
    row: {
      Icon: Sparkles, action: "Turn on",
      describe: () => t(spec.label),
      related: () => false,
      hint: "Let your AI use this note as a skill",
    },
    available: (node) => {
      const tag = isNote(node) ? moduleTagOf(getAppState().data.tags ?? [], moduleId) : undefined;
      return isNote(node) && !(tag && nodeHasTag(node, tag.id));
    },
    run: async ({ node }) => {
      const { setNoteSwitch } = await import("../lib/noteSwitch");
      await setNoteSwitch(node, moduleId, true, getAppState().data.tags ?? []);
    },
  };
}

export const NOTE_COMMANDS = MODULES.flatMap((m) => [
  ...(m.noteCommands ?? []).map((command) => ({ moduleId: m.id, command })),
  ...(m.noteSwitch ? [{ moduleId: m.id, command: switchOnCommand(m.id, m.noteSwitch) }] : []),
]);

/** The note commands of the imported modules (the 功能 tab, the palette, the ⋯ menus). */
export function noteCommandsOf(isImported: ModuleFilter = ALL_MODULES): typeof NOTE_COMMANDS {
  return NOTE_COMMANDS.filter(({ moduleId }) => isImported(moduleId));
}

/** The module a note command belongs to (its screen is what `open` opens). */
export function noteCommandModule(command: NoteCommand): string | null {
  return NOTE_COMMANDS.find((entry) => entry.command === command)?.moduleId ?? null;
}

/** The view modules — every layout a tag's saved views can take, the table
 *  included (docs/architecture/views-as-modules.md). */
export const VIEW_MODULES: ReadonlyArray<FrontendModule & { view: NonNullable<FrontendModule["view"]> }> =
  MODULES.flatMap((m) => m.view ? [{ ...m, view: m.view }] : []);

/** The modules that add a tab to a NOTE's view row (the slides' 「簡報」, handwriting's 「手寫」). */
export const NOTE_VIEW_MODULES: readonly NoteViewModule[] = [
  ...MODULES.flatMap((m) => m.noteView ? [{ id: m.id, library: m.library, noteView: m.noteView }] : []),
  ...BUILT_IN_MODULES.flatMap(({ id, noteView }) => noteView ? [{ id, library: { title: noteView.title, Icon: noteView.Icon }, noteView: { Pane: noteView.Pane, fillsHeight: noteView.fillsHeight } }] : []),
];

/** The note-view layouts (「簡報」) a page may not show or offer: a tag's page has
 *  none, and a note's only while the module that draws it is on. */
export function hiddenNoteViewLayouts(isImported: ModuleFilter, ownerKind: "tag" | "node"): ReadonlySet<string> {
  return new Set(NOTE_VIEW_MODULES.filter((mod) => ownerKind === "tag" || !isImported(mod.id)).map((mod) => mod.id));
}

/** A view module's tag (#表格, #月曆…): a tag extends it while it has a view
 *  of that layout, and its page gathers their notes. It describes tags, never
 *  a note (rule 6 — the server refuses), and it is not a function or an
 *  inherited tag on the tag page: tags get it by adding a view tab. */
export function isViewModuleTag(tag: Pick<Tag, "schema_module">): boolean {
  return VIEW_MODULES.some((mod) => mod.id === tag.schema_module);
}

/** Whether a module is always on: a way of looking at notes (a tag layout, or
 *  the whiteboard) that is chosen with 「＋」 on a page, has no switch and is
 *  not listed in Settings › Features. The one rule behind `moduleFilterFor`,
 *  the shell features and `inModuleLibrary`. */
export function isAlwaysOn(mod: Pick<FrontendModule, "view" | "library">): boolean {
  return Boolean(mod.view) || mod.library.alwaysOn === true;
}

const ALWAYS_ON_IDS: ReadonlySet<string> = new Set(MODULES.filter(isAlwaysOn).map((m) => m.id));

/** Whether Settings › Features lists a module: the always-on ones are not. */
export function inModuleLibrary(mod: Pick<FrontendModule, "view" | "library">): boolean {
  return !isAlwaysOn(mod);
}

/** Every feature's own settings, each with the feature it belongs to. */
export const MODULE_SETTINGS = [
  ...MODULES.flatMap((m) => (m.settings ?? []).map((setting) => ({ ...setting, moduleId: m.id }))),
];

/** Writing a passage or a line into a note is the reading module's own mechanism (rss/rssQuote);
 *  side by side (components/splitView) uses it too. Loaded on use, outside the boot JS. */
export { loadRssQuote } from "./rss";
