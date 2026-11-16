// Every switchable module, switched off, leaves no trace on any entry point
// (業主規則 2026-11-01：「每個新功能都必須是可以關掉的模組，關掉後不能在任何地方留下痕跡」).
//
// One census (`surfacesOf`) lists, for a module filter, every place the shell
// can show a module through its data source: the nav and 更多, the create
// sheet, the `/` menu, the palette (note commands, open commands, dialogs),
// the info panel (switches, 功能 rows, tag functions), tag pages, the home
// strip, the day timeline, the reading hub, block actions, settings. The
// tests run it per module (`it.each`), so a module added to MODULES is
// checked with no new test:
//   • off: nothing in the census names it;
//   • on: every entry it declares is in the census (so the check above can
//     not pass because the census is empty).
// A new FrontendModule field fails `declared fields are all in the census`
// until it is given a surface here. Backend side: backend/src/test/moduleOffNoTrace*.
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_PAGES, arrangeNavigation, getMoreNavigationGroups } from "../hooks/shellNavigation";
import { noteActionList, NOTE_HEADER_ACTIONS } from "../lib/data/noteActionList";
import { createKindsFor } from "../lib/createKinds";
import { shellFeatureModule, shellFeatureOnIn } from "../lib/shellFeatures";
import { importedFeatures } from "../hooks/useImportedFeatures";
import { splitTagSections } from "../lib/tagTree";
import type { ContentNode, Tag } from "../lib/api";
import {
  BUILT_IN_MODULES, MODULES, MODULE_SETTINGS, NOTE_VIEW_MODULES, hiddenNoteViewLayouts, TAG_FUNCTIONS, enabledTagFunctions, importedModules, inModuleLibrary,
  isAlwaysOn, moduleFilterFor, noteCommandsOf, noteSwitchesOf, readingSectionsFor, slashInsertsOf, tagPageSectionsOf, collectDayItems,
  type FrontendModule, type ModuleFilter,
} from "../modules";

const here = dirname(fileURLToPath(import.meta.url));
const SWITCHABLE = MODULES.filter((m) => !isAlwaysOn(m));
const ALL_IDS = MODULES.map((m) => m.id);
/** The production filter with `off` switched off (always-on modules cannot be). */
const without = (off: string): ModuleFilter => moduleFilterFor(ALL_IDS.filter((id) => id !== off));

type Surface = { surface: string; moduleId: string };

const actions = { setMode: vi.fn(), onOpenModule: vi.fn(), onOpenFeature: vi.fn() };
const moduleTags = MODULES.filter((m) => m.library.moduleTag).map((m) => ({ id: `tag-${m.id}`, name: m.id, schema_module: m.id }) as unknown as Tag);
const anyNote = { id: "n1", node_type: "content", parent_id: null, markdown: "", title: "x" } as unknown as ContentNode;

/** Which modules stand behind a nav destination id (the reading hub is several). */
function modulesBehind(destinationId: string, isImported: ModuleFilter): string[] {
  if (MODULES.some((m) => m.id === destinationId)) return [destinationId];
  if (destinationId === "reading") return readingSectionsFor(isImported).map((s) => s.moduleId);
  return [];
}

/** Every module-owned thing the shell offers through a data source, for a filter. */
export function surfacesOf(isImported: ModuleFilter): Surface[] {
  const out: Surface[] = [];
  const add = (surface: string, moduleId: string) => out.push({ surface, moduleId });
  const features = importedFeatures(isImported, moduleTags);

  // Navigation: the bars, 更多 (desktop and phone), the core pages a module switches on.
  const featureOn = (feature: Parameters<NonNullable<Parameters<typeof arrangeNavigation>[4]>>[0]) => isImported(shellFeatureModule(feature));
  const nav = arrangeNavigation({ mode: "notes" }, actions, features, null, featureOn);
  for (const [where, list] of [["pinned", nav.pinned], ["unpinned", nav.unpinned], ["phoneMore", nav.phoneMore], ["phoneBar", nav.phoneBar]] as const) {
    for (const d of list) for (const moduleId of modulesBehind(d.id, isImported)) add(`nav:${where}`, moduleId);
  }
  for (const group of getMoreNavigationGroups({}, nav.phoneMore)) {
    for (const item of group.items) for (const moduleId of modulesBehind(item.id, isImported)) add("nav:more-sheet", moduleId);
  }
  for (const page of nav.candidates) {
    const core = CORE_PAGES.find((p) => p.id === page.id);
    if (core?.feature) add("nav:core-page", shellFeatureModule(core.feature));
  }
  for (const f of features) if (f.tag) add("nav:feature-tag", f.mod.id);
  // The shell features woven into core screens (day notes, tasks, boards): what the hooks ask.
  const on = ALL_IDS.filter(isImported);
  for (const feature of ["whiteboard", "day-notes", "tasks", "ai", "ext-calendars", "meaning-search"] as const) if (shellFeatureOnIn(on, feature)) add("shell-feature", shellFeatureModule(feature));
  for (const s of readingSectionsFor(isImported)) add("reading-hub", s.moduleId);

  // Creating: the + menu and create sheet.
  for (const kind of createKindsFor(isImported)) if (kind.module) add("create-sheet", kind.module);

  // Writing: the `/` menu, the selection bubble, the palette's note commands, the ⋯ menu.
  for (const { moduleId } of slashInsertsOf(isImported)) add("slash-menu", moduleId);
  for (const { moduleId } of noteCommandsOf(isImported)) add("note-command", moduleId);
  const commands = noteCommandsOf(isImported);
  for (const a of noteActionList(anyNote, { canEdit: true, isOwner: true, online: true, commands: commands.map((c) => c.command) } as never)) {
    if (a.command && NOTE_HEADER_ACTIONS.includes(a.id as never)) add("note-header-menu", commands.find((c) => c.command === a.command)!.moduleId);
  }
  for (const m of importedModules(isImported)) {
    if (m.noteHeaderAction) add("note-header-action", m.id);
    if (m.openCommand) add("palette-open", m.id);
    if (m.dialogEntry) add("palette-dialog", m.id);
    if (m.noteFunctionRows) add("info-function-rows", m.id);
    if (m.HomeSection) add("home-strip", m.id);
    if (m.dayItems) add("day-timeline", m.id);
  }

  // The info panel, tag pages and tag chips.
  for (const { moduleId } of noteSwitchesOf(isImported)) add("info-note-switch", moduleId);
  for (const { moduleId } of tagPageSectionsOf(isImported)) add("tag-page-section", moduleId);
  const everyAbility = { schema_module: null, effective_modules: TAG_FUNCTIONS.map((f) => f.id) } as never;
  for (const fn of enabledTagFunctions(everyAbility, isImported)) add("tag-function", fn.module ?? fn.id);
  const { fromModules, removed } = splitTagSections(moduleTags, isImported);
  for (const tag of fromModules) add("tag-list-functions", tag.schema_module!);
  // A note's view row and its ＋ menu (「簡報」).
  const hiddenViews = hiddenNoteViewLayouts(isImported, "node");
  for (const mod of NOTE_VIEW_MODULES) if (!hiddenViews.has(mod.id)) add("note-view", mod.id);
  void removed;
  return out;
}

const declares = (m: FrontendModule): string[] => [
  ...(m.screen ? ["nav:pinned"] : []),
  ...(m.readingSections?.length ? ["reading-hub"] : []),
  ...(m.slashInserts?.length ? ["slash-menu"] : []),
  ...(m.noteCommands?.length || m.noteSwitch ? ["note-command"] : []),
  ...(m.noteHeaderAction ? ["note-header-action"] : []),
  ...(m.openCommand ? ["palette-open"] : []),
  ...(m.dialogEntry ? ["palette-dialog"] : []),
  ...(m.noteFunctionRows ? ["info-function-rows"] : []),
  ...(m.HomeSection ? ["home-strip"] : []),
  ...(m.noteView ? ["note-view"] : []),
  ...(m.dayItems ? ["day-timeline"] : []),
  ...(m.noteSwitch ? ["info-note-switch"] : []),
  ...(m.tagPageSection ? ["tag-page-section"] : []),
  ...(m.tagFunction ? ["tag-function"] : []),
  ...(m.shellFeature ? ["shell-feature"] : []),
];

afterEach(() => vi.restoreAllMocks());

/** Give every module a day item, so the timeline's filter is exercised without data. */
function stubDayItems() {
  for (const m of MODULES) {
    if (m.dayItems) vi.spyOn(m, "dayItems").mockReturnValue([{ kind: "task", title: m.id, ref: null, past: false }]);
  }
}
const dayItemOwners = (isImported: ModuleFilter) => {
  const ctx = { date: "2026-11-01", today: "2026-11-01", nowMs: 0, nodes: [], tasks: [], tags: [] };
  return collectDayItems(ctx, isImported).map((i) => i.title);
};

describe("a switched-off module leaves no trace on any entry", () => {
  it("has at least one module that can be switched off", () => {
    expect(SWITCHABLE.length).toBeGreaterThan(5);
  });

  it.each(SWITCHABLE.map((m) => [m.id] as const))("%s: off → no entry names it", (id) => {
    stubDayItems();
    const leftovers = surfacesOf(without(id)).filter((s) => s.moduleId === id).map((s) => s.surface);
    expect(leftovers).toEqual([]);
    expect(dayItemOwners(without(id))).not.toContain(id);
  });

  it.each(SWITCHABLE.map((m) => [m.id] as const))("%s: off → its tag leaves 功能 for removed modules", (id) => {
    const mod = MODULES.find((m) => m.id === id)!;
    // A note-switch module's tag is inside (lib/nodeTags isNoteSwitchTag): no list shows it at all.
    if (!mod.library.moduleTag || mod.noteSwitch) return;
    const { fromModules, removed } = splitTagSections(moduleTags, without(id));
    expect(fromModules.map((t) => t.schema_module)).not.toContain(id);
    expect(removed.map((t) => t.schema_module)).toContain(id);
  });

  it.each(SWITCHABLE.map((m) => [m.id] as const))("%s: on → every entry it declares is listed", (id) => {
    stubDayItems();
    const mod = MODULES.find((m) => m.id === id)!;
    const present = new Set(surfacesOf(moduleFilterFor(ALL_IDS)).filter((s) => s.moduleId === id).map((s) => s.surface));
    for (const want of declares(mod)) {
      if (want === "nav:pinned") expect([...present].some((s) => s.startsWith("nav:")), `${id} ${want}`).toBe(true);
      else expect(present, `${id} ${want}`).toContain(want);
    }
    if (mod.dayItems) expect(dayItemOwners(moduleFilterFor(ALL_IDS))).toContain(id);
  });

  it("the census names every FrontendModule field a module may declare", () => {
    // A new field on FrontendModule must get a surface in `surfacesOf` (or be
    // listed here with the reason it shows nowhere).
    const NO_SURFACE = new Set([
      "id", "library", // identity; the card is Settings › 功能 itself
      "shellFeature", // asked through createKindsFor / CORE_PAGES (census: create-sheet, nav:core-page)
      "sitePublisher", // the first-run offer: hooks/useWelcomeBanner checks isModuleImported
      "suggestsLinks", // linkSuggestionsShown(isImported)
      "generatedSourceTypes", // sidebar tidy (known: not filtered by import, see docs/architecture/core-vs-modules.md)
      "view", // view layouts are always on (isAlwaysOn)
      "settings", "SettingsPreview", // only on Settings › 功能 › the module (below)
      "NavIndicator", // follows the nav destination
      "tagFunction", "noteSwitch", "noteCommands", "screen", "readingSections", "slashInserts", "noteHeaderAction",
      "openCommand", "dialogEntry", "noteFunctionRows", "HomeSection", "dayItems", "tagPageSection", "noteView",
    ]);
    const used = new Set(MODULES.flatMap((m) => Object.keys(m)));
    const unknown = [...used].filter((k) => !NO_SURFACE.has(k));
    expect(unknown).toEqual([]);
  });

  it("module settings sit only on Settings › 功能 › the module, never in another tab's list", () => {
    // BUILT_IN_SETTINGS (settings/registry) takes built-in modules only; the
    // feature modules' rows are MODULE_SETTINGS, drawn on the module's own page,
    // which is listed only while the module is on (useSettingsModules).
    const shown = (isImported: ModuleFilter) => MODULES.filter((m) => inModuleLibrary(m) && isImported(m.id)).map((m) => m.id);
    for (const m of SWITCHABLE) {
      expect(shown(without(m.id))).not.toContain(m.id);
      expect(shown(moduleFilterFor(ALL_IDS))).toContain(m.id);
    }
    for (const row of MODULE_SETTINGS) expect(MODULES.some((m) => m.id === row.moduleId), row.moduleId).toBe(true);
  });

  it("an always-on module is an explicit decision: view layouts, the whiteboard and slides only", () => {
    const alwaysOn = MODULES.filter(isAlwaysOn).map((m) => m.id).sort();
    expect(alwaysOn).toEqual(["calendar", "canvas", "gallery", "kanban", "slides", "table"]);
  });
});

describe("core code reads module lists only through the imported-module functions", () => {
  const srcDir = join(here, "..");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "modules" || name === "test" ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });

  it("no core file lists SLASH_INSERTS or NOTE_COMMANDS unfiltered (slashInsertsOf / noteCommandsOf take the module filter)", () => {
    // The one allowed read is the palette's id→id table of every note command (not a listing).
    const offenders = files(srcDir).flatMap((file) => readFileSync(file, "utf8").split("\n")
      .map((line, i) => ({ line, at: `${file.slice(srcDir.length + 1)}:${i + 1}` }))
      .filter(({ line }) => /\b(SLASH_INSERTS|NOTE_COMMANDS)\b/.test(line) && !/^\s*(\/\/|\*|\/\*|import )/.test(line)
        && !line.includes("Object.fromEntries(NOTE_COMMANDS.map"))
      .map(({ at }) => at));
    expect(offenders).toEqual([]);
  });
});

describe("the registry and the module folders agree", () => {
  const dirs = (path: string) => readdirSync(path).filter((name) => statSync(join(path, name)).isDirectory());
  const frontendDirs = dirs(join(here, "../modules"));
  const backendDirs = dirs(join(here, "../../../backend/src/modules"));
  const registered = [...MODULES, ...BUILT_IN_MODULES].map((m) => m.id);

  it("every frontend module folder is registered, and every registered module has a folder", () => {
    expect(frontendDirs.sort()).toEqual([...registered].sort());
    for (const id of registered) expect(existsSync(join(here, "../modules", id, ...["index.ts"])) || existsSync(join(here, "../modules", id, "index.tsx")), id).toBe(true);
  });

  it("every backend module folder is registered (backend/src/test/moduleRegistry.test.ts holds the other direction)", () => {
    const frontendBackendTwins = registered.filter((id) => id !== "graph");
    expect(backendDirs.sort()).toEqual([...frontendBackendTwins].sort());
  });
});
