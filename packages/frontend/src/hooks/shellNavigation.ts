import {
  BookOpen,
  CalendarCheck,
  History,
  LayoutDashboard,
  ListChecks,
  Network,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import type { AppMode, CoreMode } from "./useUiMode";
import type { ImportedFeature } from "./useImportedFeatures";
import { MODULE_SCREENS, MODULES, READING_SECTIONS, moduleEntry, type NavGroupPlacement, type NavIndicatorProps } from "../modules";
import { readingEntrySection } from "../lib/readingHub";
import { reopenDestination, type TabTop } from "./useUrlLocation";
import { resolveNavLayout, type NavLayout } from "../lib/navLayout";
import type { ShellFeature } from "../lib/shellFeatures";

// The one navigation model, shared by the desktop top bar (AppNavigation)
// and the phone (MobileNav):
//   • core pages, always shown, in this order: 筆記 任務 關係圖 歷史;
//   • then one destination per feature that is on and has a page of its own
//     (hooks/useImportedFeatures). A module with only a tag (技能)
//     技能) has no destination: it opens from Settings › 功能 › its page, and
//     its tag is a row of the sidebar's tag list. The inbox is not one either
//     (BuiltInModule.screen.inNav): the phone's 筆記 tab and the desktop
//     sidebar's first row open it.
// Which of them sit directly in the nav, and in what order, is the person's
// choice (「釘到導覽列」, lib/navLayout; arrangeNavigation below). Never edited,
// it is the layout from before pins: the desktop bar shows the core pages and
// the features in use (lib/moduleUse), the phone's bottom bar 任務
// (DEFAULT_PHONE_PINS) plus 捕捉 and 更多. The desktop bar folds trailing module
// destinations into 「更多 ▾」 when they do not fit. 「更多」 lists every other
// destination that is on, used or not: the same list as the nav editor's
// 「在「更多」裡」 (both are arrangeNavigation's), under the same names.

/** Where the shell is: which destination lights up. */
export type NavLocation = {
  mode: AppMode;
  /** The open action-panel overlay (ask / actors / …): core pages show no
   *  active state while one covers the page. */
  activePanel?: string | null;
};

export type NavActions = {
  setMode: (mode: AppMode) => void;
  /** Open a module screen or reading section by its view id. */
  onOpenModule: (view: string) => void;
  /** Open what an imported module adds (its screen, the boards). */
  onOpenFeature: (id: string) => void;
};

export type NavDestination = {
  id: string;
  /** i18n key. */
  label: string;
  Icon: LucideIcon;
  open: () => void;
  current: boolean;
  /** The marks after its label (FrontendModule.NavIndicator of the modules
   *  it opens); a container that folds it shows them as one dot. */
  indicators: ComponentType<NavIndicatorProps>[];
  /** A core page: the desktop bar never folds it into 「更多 ▾」. */
  core?: boolean;
  /** The group it sits in under 「更多」 (groupDestinations). */
  group?: NavGroupPlacement;
  /** The view (AppMode) it opens — what a side-by-side pane shows (lib/splitView);
   *  null when it opens something that is not a page. */
  view: string | null;
};

/** How a page sits in the workspace: beside the notes sidebar (and the info
 *  panel for the focused note), or across the whole width with no sidebar. */
export type PageLayout = "sidebar" | "full";

type CorePage = {
  id: CoreMode; label: string; Icon: LucideIcon; layout: PageLayout;
  /** The page exists only while a module supplies this feature (lib/shellFeatures). */
  feature?: ShellFeature;
  /** The page exists while at least one of these features is on (今天 needs the journal or the tasks). */
  anyFeature?: readonly ShellFeature[];
  group?: NavGroupPlacement;
  /** Whether the page is at its top (tapping its tab again goes there); absent = always (a page with nothing opened inside it). */
  top?: TabTop;
};

/** Whether a shell feature is on; the default shows every page (tests, older servers). */
export type FeatureOn = (feature: ShellFeature) => boolean;
const ALL_FEATURES: FeatureOn = () => true;

/** The core pages, in nav order. 筆記 is always the first entry of both
 *  bars; which others sit in a bar is the nav layout's (lib/navLayout). */
export const CORE_PAGES: readonly CorePage[] = [
  { id: "notes", label: "Notes", Icon: LayoutDashboard, layout: "sidebar", top: (loc) => loc.nodeId === null }, // the list
  // Tasks is a list of its own (今天／即將到來／隨時／某天), so a note list
  // beside it would be a second, unrelated list. A task's note opens in 筆記
  // (clicking the note name on the row). The graph shows the whole workspace and
  // opens a note on click, so it has no note list beside it either.
  { id: "tasks", label: "Tasks", Icon: ListChecks, layout: "full", feature: "tasks", group: { id: "time", order: 2 } },
  { id: "graph", label: "Graph", Icon: Network, layout: "full", top: (_loc, focus) => focus === null }, // centred on no note
  // History (the workspace's changes, deleted notes). It has its own list and
  // detail columns, so a note list beside it would be a third list. Not in the
  // default nav (lib/navLayout DEFAULT_UNPINNED): it opens from 更多.
  { id: "timeline", label: "Workspace changes", Icon: History, layout: "full", group: { id: "time", order: 3 } },
];

/** 今天: the day's journal, things and timeline on one page (a trial beside 日記 and 任務, which stay). It is an
 *  optional destination: last in the default order and not a core page, so a narrow desktop bar folds it into
 *  「更多 ▾」 before anything else and it never takes a place from another entry; a layout someone saved is never
 *  changed (it starts in 更多). The page needs the journal or the tasks to be on. */
export const TODAY_PAGE: CorePage = { id: "today", label: "Today", Icon: CalendarCheck, layout: "full", anyFeature: ["day-notes", "tasks"], group: { id: "time", order: 0 } };

/** The layout of the page `mode` names: a core page says it on CORE_PAGES; a
 *  module screen or reading section (日記, 複習, 網站, 閱讀…) is always a full page.
 *  The one answer for whether the workspace shows the note sidebar and the
 *  info panel. Narrow screens hide the sidebar outside 筆記 regardless (CSS). */
export function pageLayout(mode: AppMode): PageLayout {
  return [...CORE_PAGES, TODAY_PAGE].find((page) => page.id === mode)?.layout ?? "full";
}

/** What tapping a destination does: on a phone its tab returns to where it was left, or to its top when it is the
 *  tab on screen (hooks/useUrlLocation reopenDestination); otherwise (a desktop, never opened) `open` as before. */
const tapped = (id: string, current: boolean, open: () => void, atTop?: TabTop) => () => { if (!reopenDestination(id, current, atTop)) open(); };

/** The reading hub (閱讀) is one destination over every imported module's
 *  reading sections; it opens on the section last read. */
const READING_ID = "reading";

/** The name (i18n key) of the page a view shows: a pane's header for a
 *  function page. Core pages, module screens and reading sections. */
export function viewLabel(view: string): string {
  const core = [...CORE_PAGES, TODAY_PAGE].find((page) => page.id === view);
  if (core) return core.label;
  if (READING_SECTIONS.some((section) => section.id === view)) return "Reading";
  const mod = MODULES.find((m) => m.id === view);
  if (mod) return mod.library.title;
  // A built-in module's screen (the inbox) has no library entry.
  return MODULE_SCREENS.get(view)?.label ?? view;
}

/** The nav destination an imported feature opens (its module id, or the
 *  reading hub's), or null when it has no page of its own. */
export function featureDestinationId(feature: ImportedFeature): string | null {
  return feature.opens ? moduleNavDestinationId(feature.mod.id) : null;
}

/** The nav destination a module would open once imported (its id, or the
 *  reading hub's), or null when it has no page of its own. The import
 *  confirmation asks this before the module is imported. */
export function moduleNavDestinationId(moduleId: string): string | null {
  const entry = moduleEntry(moduleId);
  if (!entry) return null;
  if (!MODULE_SCREENS.has(entry.view)) return READING_ID;
  return moduleId;
}

function moduleDestination(feature: ImportedFeature, at: NavLocation, actions: NavActions, readingViews: readonly { id: string }[]): NavDestination | null {
  const { mod } = feature;
  const indicators = feature.Indicator ? [feature.Indicator] : [];
  const entry = feature.opens ? moduleEntry(mod.id) : null;
  if (!entry) return null;
  if (featureDestinationId(feature) === READING_ID) {
    const current = readingViews.some((section) => section.id === at.mode);
    return {
      id: READING_ID, label: "Reading", Icon: BookOpen,
      open: tapped(READING_ID, current, () => { const view = readingEntrySection(readingViews); if (view) actions.onOpenModule(view); }),
      current,
      indicators,
      view: readingEntrySection(readingViews) ?? null,
    };
  }
  const current = at.mode === entry.view; // a module screen stays lit under an action panel (it is a full page)
  return {
    id: mod.id, label: mod.library.title, Icon: mod.library.Icon, group: mod.library.navGroup,
    open: tapped(mod.id, current, () => actions.onOpenFeature(mod.id)),
    current,
    indicators,
    view: entry.view,
  };
}

/** The navigation's destinations: the core pages, then the imported
 *  modules' pages (registry order, the reading hub once). */
export function getNavDestinations(at: NavLocation, actions: NavActions, features: readonly ImportedFeature[], featureOn: FeatureOn = ALL_FEATURES): { core: NavDestination[]; modules: NavDestination[] } {
  const imported = new Set(features.map(({ mod }) => mod.id));
  const readingViews = READING_SECTIONS.filter((section) => imported.has(section.moduleId));
  const modules: NavDestination[] = [];
  for (const feature of features) {
    const destination = moduleDestination(feature, at, actions, readingViews);
    if (!destination) continue;
    // The reading hub is one destination over several modules: their marks join.
    const same = modules.find((d) => d.id === destination.id);
    if (same) same.indicators.push(...destination.indicators);
    else modules.push(destination);
  }
  const moduleCurrent = modules.some((d) => d.current);
  const core = CORE_PAGES.filter((page) => (!page.feature || featureOn(page.feature)) && (!page.anyFeature || page.anyFeature.some(featureOn))).map(({ id, label, Icon, group, top }) => {
    const current = at.mode === id && !at.activePanel && !moduleCurrent;
    return {
      id, label, Icon, group,
      open: tapped(id, current, () => actions.setMode(id), top),
      current,
      indicators: [],
      core: true,
      view: id,
    };
  });
  // 今天 comes last, after the module pages, and is not core: it folds first when the bar is short.
  const today = (!TODAY_PAGE.anyFeature || TODAY_PAGE.anyFeature.some(featureOn))
    ? [{ id: TODAY_PAGE.id, label: TODAY_PAGE.label, Icon: TODAY_PAGE.Icon, group: TODAY_PAGE.group, open: tapped(TODAY_PAGE.id, at.mode === TODAY_PAGE.id && !at.activePanel && !moduleCurrent, () => actions.setMode(TODAY_PAGE.id)),
      current: at.mode === TODAY_PAGE.id && !at.activePanel && !moduleCurrent, indicators: [], view: TODAY_PAGE.id } satisfies NavDestination]
    : [];
  return { core, modules: [...modules, ...today] };
}

/** The nav as the person arranged it (lib/navLayout): 筆記, then the pinned
 *  destinations in their order; the phone's bar takes the first
 *  `layout.phone`. `candidates` are every destination but 筆記, in default
 *  order (the ids a layout may name). */
export type ShellNavigation = {
  notes: NavDestination;
  layout: NavLayout;
  candidates: NavDestination[];
  /** The desktop bar's entries after 筆記, in order. */
  pinned: NavDestination[];
  /** The rest: the desktop's 「更多 ▾」 and the nav editor's 「在「更多」裡」. */
  unpinned: NavDestination[];
  /** The phone's 「更多」: every candidate the bottom bar does not show, in
   *  default order. It is `unpinned` plus the entries pinned only past the
   *  phone's cut (「電腦才顯示」), which would otherwise have no way in. */
  phoneMore: NavDestination[];
  /** The phone bar's entries after 筆記 (捕捉 and 更多 are the bar's own). */
  phoneBar: NavDestination[];
};

export function arrangeNavigation(at: NavLocation, actions: NavActions, features: readonly ImportedFeature[], stored: NavLayout | null, featureOn: FeatureOn = ALL_FEATURES): ShellNavigation {
  const { core, modules } = getNavDestinations(at, actions, features, featureOn);
  const notes = core.find((d) => d.id === "notes")!;
  const candidates = [...core.filter((d) => d.id !== "notes"), ...modules];
  // Only the default layout leaves a feature that is on but unused out of the bars.
  const usedIds = new Set(features.filter((feature) => feature.inUse).map(featureDestinationId));
  const unused = modules.filter((d) => d.id !== TODAY_PAGE.id && !usedIds.has(d.id)).map((d) => d.id);
  const layout = resolveNavLayout(stored, candidates.map((d) => d.id), unused);
  const byId = new Map(candidates.map((d) => [d.id, d]));
  const pinned = layout.order.map((id) => byId.get(id)!);
  const unpinned = candidates.filter((d) => !layout.order.includes(d.id));
  const phoneBar = pinned.slice(0, layout.phone);
  const inPhoneBar = new Set(phoneBar.map((d) => d.id));
  return { notes, layout, candidates, pinned, unpinned, phoneMore: candidates.filter((d) => !inPhoneBar.has(d.id)), phoneBar };
}

/** How many of the trailing (module) destinations the desktop bar can show
 *  in `budget` pixels; the rest go to 「更多 ▾」. Core pages always show.
 *  Widths are the rendered buttons'; `gap` is the space between two. */
export function fittingModuleCount({ budget, gap, core, modules, more, moreAlways = false }: {
  budget: number; gap: number; core: readonly number[]; modules: readonly number[]; more: number;
  /** 「更多 ▾」 shows whatever fits (it holds the unpinned destinations). */
  moreAlways?: boolean;
}): number {
  const row = (widths: readonly number[]) => widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
  if (row([...core, ...modules, ...(moreAlways ? [more] : [])]) <= budget) return modules.length;
  for (let count = modules.length - 1; count > 0; count--) {
    if (row([...core, ...modules.slice(0, count), more]) <= budget) return count;
  }
  return 0;
}

export type MoreNavigationCallbacks = {
  /** Settings › Modules; absent for people who cannot import modules. */
  onManageModules?: () => void;
};

export type MoreNavigationItem = {
  id: string;
  label: string;
  Icon: LucideIcon;
  onSelect: () => void;
  /** The nav destination it opens (a core page, a module's page): it can be
   *  pinned to the bar. 「管理功能」 cannot. */
  destination?: string;
  /** The marks after its label (NavDestination.indicators). */
  indicators: ComponentType<NavIndicatorProps>[];
};

export type MoreNavigationGroup = {
  id: string;
  label: string;
  items: MoreNavigationItem[];
};

/** 「更多」 and the nav editor's 「在「更多」裡」 name and order their destinations
 *  the same way: 「時間」 (a destination's `group`, by its `order`: 日子, 任務, 歷史),
 *  then 「整理」 (the other core pages), then 「功能」 (the other feature pages).
 *  Empty groups are left out. `label` is an i18n key. */
export type DestinationGroup = { id: "time" | "organize" | "features"; label: string; destinations: NavDestination[] };

export function groupDestinations(destinations: readonly NavDestination[]): DestinationGroup[] {
  const time = destinations.filter((d) => d.group?.id === "time").sort((a, b) => a.group!.order - b.group!.order);
  const rest = destinations.filter((d) => d.group?.id !== "time");
  const groups: DestinationGroup[] = [
    { id: "time", label: "Time", destinations: time },
    { id: "organize", label: "Organize", destinations: rest.filter((d) => d.core) },
    { id: "features", label: "Features", destinations: rest.filter((d) => !d.core) },
  ];
  return groups.filter((group) => group.destinations.length > 0);
}

/** The phone's 「更多」 sheet: navigation only. Account, sync status,
 * Settings and sign-out live behind the top-bar avatar. `destinations` are
 * the nav destinations not in the bottom bar (ShellNavigation.phoneMore), as
 * they are named and ordered in the nav editor: groupDestinations
 * orders them (時間, 整理, 功能); 「功能」 ends with 「管理功能」 (Settings ›
 * 功能). A feature with no page of its own is not here (nor in the editor):
 * it opens from Settings › 功能 › its page, and its tag is in the sidebar.
 * Presentations own closing, focus and translating labels. Empty groups and
 * optional actions without handlers are omitted. */
export function getMoreNavigationGroups({ onManageModules }: MoreNavigationCallbacks,
  destinations: readonly NavDestination[]): MoreNavigationGroup[] {
  const item = ({ id, label, Icon, open, indicators }: NavDestination): MoreNavigationItem =>
    ({ id, label, Icon, onSelect: open, destination: id, indicators });
  const groups: MoreNavigationGroup[] = groupDestinations(destinations)
    .map(({ id, label, destinations: members }) => ({ id, label, items: members.map(item) }));
  if (onManageModules) {
    const manage = { id: "manage-modules", label: "Manage modules", Icon: SlidersHorizontal, onSelect: onManageModules, indicators: [] };
    const features = groups.find((group) => group.id === "features");
    if (features) features.items.push(manage);
    else groups.push({ id: "features", label: "Features", items: [manage] });
  }
  return groups;
}
