// What a frontend module contributes to the app shell. The shell reads these
// through modules/index.ts and never names a module, so deleting a module's
// directory and its line in the registry removes it whole.

import type { ComponentType, LazyExoticComponent } from "react";
import type { LucideIcon } from "lucide-react";
import type { DayItem } from "@onden/markdown";
import type { ContentNode, NodeEdge, NodeTask, Tag } from "../lib/api";
import type { TagFunctionSpec } from "../lib/tagModules";
import type { SettingDef } from "../lib/settingsTypes";
import type { ModuleUseData } from "../lib/moduleUse";
import type { ShellFeature } from "../lib/shellFeatures";
import type { ExecResponse } from "../lib/viewExec";
import type { SuggestionItem } from "@onden/contract";
import type { CanvasMembership } from "@onden/contract";
import type { TabId } from "../lib/settingsTab";

/** Where a module screen should open: one item, one source, the cards
 *  under one note, or one of its pages. Each module reads the fields it understands. */
export type ModuleTarget = {
  itemId?: string; sourceId?: string; rootId?: string; rootTitle?: string;
  /** One of the module's own pages (review: "status"); the screen's first page when absent. */
  page?: string;
};
export type ModuleOpen = (target?: ModuleTarget) => void;

/** The first-run "build your first website" operation of the site module. */
export type SitePublisher = {
  /** Creates the intro pages where they can be published and publishes
   *  them. Resolves the published site's link and the Home page's id; or
   *  `needsReview` when the publish would carry the space's other notes too
   *  (nothing is published; the Website screen's preview asks first); or
   *  null when the site was not published (the reason was shown). */
  buildIntroSite: () => Promise<{ url: string; homeId: string } | { needsReview: true; homeId: string } | null>;
};

export type ModuleScreenProps = {
  online: boolean;
  target: ModuleTarget | null;
  onOpenNode: (id: string) => void;
  onRefresh: () => Promise<void> | void;
  /** Go to another page by id (`tasks`, a module's id). Absent where the screen is embedded. */
  onOpenView?: (id: string) => void;
  /** True while the screen wants the whole viewport (an open article on a
   *  phone); the shell then hides its own chrome. */
  onImmersiveChange: (immersive: boolean) => void;
  /** Shown under a tab that already names it (the phone's 收件匣 tab): the
   *  page leaves out its own title. */
  inTab?: boolean;
};

/** A module's full-page destination, listed in the app navigation while
 *  the module is imported (hooks/shellNavigation) and addressable as
 *  `?view=<module id>`. */
export type ModuleScreen = {
  /** i18n key. */
  label: string;
  Icon: LucideIcon;
  Component: LazyExoticComponent<ComponentType<ModuleScreenProps>>;
  /** `false`: the page is reached from somewhere else (the inbox: the phone's
   *  筆記 tab, the desktop sidebar's first row), so it is not a nav destination:
   *  it cannot be pinned and 更多 does not list it. `?view=` still opens it. */
  inNav?: false;
};

/** One section of the reading hub (閱讀). Today only RSS adds one (read
 *  later and highlights are ordinary notes). The hub lists the sections of imported modules, in `order`,
 *  and each is addressable as `?view=<id>` (an id equal to the module id
 *  keeps `open()` and old links landing on it). */
/** FrontendModule.NavIndicator's props. */
export type NavIndicatorProps = { dotOnly?: boolean };

export type ReadingSection = {
  id: string;
  /** i18n key. */
  label: string;
  Icon: LucideIcon;
  order: number;
  Component: LazyExoticComponent<ComponentType<ModuleScreenProps>>;
  /** A small mark after the section's label (RSS: its NavIndicator).
   *  Renders nothing when there is nothing new. */
  Badge?: ComponentType;
};

export type HomeSectionProps = {
  open: ModuleOpen;
  homeNodeId: string;
  nodes: ContentNode[];
  tags: Tag[];
  onOpenNode: (id: string) => void;
};

/** What a module is asked for the 日子 page: everything it knows about one day. */
export type DayItemsContext = {
  /** The day asked about, YYYY-MM-DD on the workspace clock. */
  date: string;
  /** The workspace's today (a task is past on an earlier day). */
  today: string;
  nowMs: number;
  nodes: ContentNode[];
  tasks: NodeTask[];
  tags: Tag[];
};

/** Context a note command runs with. */
export type NoteCommandContext = {
  node: ContentNode;
  open: ModuleOpen;
  /** Open a note in the editor (a deck's source, a saved result). */
  openNode: (id: string) => void;
  refresh: () => Promise<void> | void;
};

/** How a note command reads in the info panel's 「功能」 tab: one row, an icon,
 *  a plain sentence about THIS note and a button. Extra fields turn it into the
 *  expandable row (see NoteFunctionRow): `details`, and `related`/`hint`
 *  for a command that can be used on the note but has no tie to it yet. */
export type NoteCommandRow = {
  Icon: LucideIcon;
  /** The small name over the sentence (an i18n key); defaults to the module's library title. */
  name?: string;
  /** The sentence, already translated, built from the note ("12 cards under
   *  this note"); never an id or a count of something the person cannot see. */
  describe: (node: ContentNode, body: string) => string;
  /** The button's text (an i18n key): the verb alone ("Review"). */
  action: string;
  /** Up to 3 lines shown when the row is open (already translated). */
  details?: (node: ContentNode, body: string) => string[];
  /** Whether the note already has a tie to this function; left out = it has
   *  (the row is about the note). False: the row is listed under 「還能用在這則」
   *  with `hint` as its one-sentence description and `action` as its button. */
  related?: (node: ContentNode, body: string) => boolean;
  /** i18n key: what the function would do for this note (rows with `related` false). */
  hint?: string;
};

/** One row of the info panel's 「功能」 tab, whatever made it: a note command's
 *  `row` or a module's `noteFunctionRows`. The panel draws these and knows no
 *  module by name. Texts are already translated unless marked i18n key. */
export type NoteFunctionRow = {
  id: string;
  Icon: LucideIcon;
  /** The function's name (small text over the status). */
  name: string;
  /** Tied to this note: in the upper list. Not tied (but usable): under
   *  「還能用在這則」, where `status` is the one-sentence description. */
  related: boolean;
  status: string;
  /** A number badge; `alert` colours it with the theme colour (something waits for the person). */
  badge?: { n: number; alert?: boolean };
  /** Up to 3 lines shown when the row is open. */
  details?: string[];
  action?: { label: string; run: () => void | Promise<void> };
  jump?: { label: string; run: () => void };
  /** The module draws the whole row itself (the website's publish status and
   *  buttons); the fields above only decide where it is listed. */
  Custom?: ComponentType<NoteHeaderActionProps>;
};

/** Where a function's jump can take the person (the workspace shell owns navigation). */
export type NoteFunctionNav = {
  openNote: (id: string) => void;
  /** Open a page by mode id ("tasks"). */
  setMode: (mode: string) => void;
  openCanvas: (canvasId: string) => void;
  /** Bring the note's text back on a screen that replaces it (the phone's Info screen). */
  showContent?: () => void;
};

/** What a module's `noteFunctionRows` may read: the open note and the data the
 *  panel already holds. Pure input, so a row is a plain function of it. */
export type NoteFunctionEnv = {
  node: ContentNode;
  /** The text on screen (the open draft, else the saved body). */
  body: string;
  canEdit: boolean;
  online: boolean;
  nodes: readonly ContentNode[];
  edges: readonly NodeEdge[];
  /** Tasks written in or added under notes (the Tasks page's rows). */
  tasks: readonly NodeTask[];
  canvasMemberships: readonly CanvasMembership[];
  /** The note's AI suggestions that wait for a decision (null: none or not read yet). */
  suggestions: AiSuggestionsSummary | null;
  nav: NoteFunctionNav;
};

/** A module's rows for one note: the default export of its `noteFunctionRows` file. */
export type NoteFunctionRowsOf = (env: NoteFunctionEnv) => NoteFunctionRow[];

/** The pending AI suggestions of a note: `places` waiting, and how to decide them all. */
export type AiSuggestionsSummary = {
  pending: number;
  /** The waiting places, in the order the AI filed them. */
  items: SuggestionItem[];
  acceptAll: () => void | Promise<void>;
};

/** An action on the selected note, shown in the info panel's 「功能」 section
 *  and the command palette. `label` is an i18n key. */
export type NoteCommand = {
  id: string;
  label: string;
  keywords: string[];
  /** Its row in the info panel (a command without one is only in the palette). */
  row?: NoteCommandRow;
  /** Hide the action for notes it cannot apply to. `env.online` is the
   *  connection (lib/data noteActionList passes it), for commands that need
   *  the server. */
  available?: (node: ContentNode, body: string, env: { online: boolean }) => boolean;
  run: (ctx: NoteCommandContext) => Promise<void> | void;
};

/** An item this module adds to the `/` menu of the note editor, for text it
 *  writes at the caret. `title` is an i18n key and also what
 *  typing after `/` filters on. `run` gets the open note; it inserts through
 *  lib/editorInsert, after the `/` has been removed. */
export type SlashInsert = {
  id: string;
  title: string;
  Icon: LucideIcon;
  run: (ctx: { node: ContentNode }) => void;
};

/** What a module's dialog entry may do in the shell. */
export type DialogEntryContext = { onOpenNode: (id: string) => void };

/** A module's own "add" dialog (a SKILL.md file).
 *  It opens from the module's tag page or its settings page and from the command
 *  palette, not from the create list. `label` is an i18n key. */
export type DialogEntry = { label: string; Icon: LucideIcon; keywords: string[]; open: (ctx: DialogEntryContext) => void };

/** A palette action that opens the module's screen. `label` is an i18n key;
 *  `group`/`hint` default to the palette's "Actions" / "action". */
export type OpenCommand = { id: string; label: string; keywords: string[]; group?: string; hint?: string };

/** What a module's note header action or function row gets: the open note, and whether the
 *  person may edit it. */
export type NoteHeaderActionProps = { node: ContentNode; readOnly: boolean };

/** A view module (docs/architecture/views-as-modules.md): a layout a tag's
 *  saved views can take — calendar, board, cards. The module id is the layout
 *  name. Adding such a view asks for one field, stored on the view: `group_by`
 *  (board) or `layout_config[key]` (calendar's date field, cards' cover). */
export type ViewLayoutProps = {
  exec: ExecResponse;
  viewId: string;
  onSelectNode?: (id: string) => void;
  /** The view's rows changed (a card moved, a cell edited): reload them. */
  onMutated?: () => void;
  /** The tag whose fields the person may change (a tag's table, for someone
   *  who may edit the tag): a column name then opens that field's settings. */
  editFieldsOf?: string;
};

/** What a note view's pane is given (a view module's `Layout` draws a tag's
 *  rows; a note view is drawn from the note itself). */
export type NoteViewPaneProps = {
  node: ContentNode;
  /** The person may change the note (it also decides who may choose a layout). */
  canEdit: boolean;
  onOpenNode: (id: string) => void;
};

/** A way of seeing ONE NOTE, as a tab of its view row beside 「內容」 (the slides'
 *  「簡報」). The tab is a stored view whose `layout` is the module's id, so the
 *  module being off hides it (viewTabs), and the backend refuses to add one. Not a
 *  view module: it makes no tag and is not offered on a tag's page. */
export type NoteViewSpec = {
  Pane: LazyExoticComponent<ComponentType<NoteViewPaneProps>>;
  /** The pane is a fixed-size surface (a page book with its own scrolling) that takes the height left under the
   *  tab strip, instead of a page that grows with its content. */
  fillsHeight?: boolean;
};

/** A built-in module's tab of a note's view row (handwriting's 「手寫」): the pane, and the title and icon the tab and the
 *  「＋」 list show — a library module gives those through `library`, a built-in one has none. */
export type BuiltInNoteViewSpec = NoteViewSpec & { title: string; Icon: LucideIcon };

/** One way of seeing a note, whichever module draws it (what `NOTE_VIEW_MODULES` lists). */
export type NoteViewModule = { id: string; library: { title: string; Icon: LucideIcon }; noteView: NoteViewSpec };

export type ViewModuleSpec = {
  /** Draws the view's rows (components/collections/CollectionView renders the
   *  active view's layout by looking its module up in VIEW_MODULES). */
  Layout: ComponentType<ViewLayoutProps>;
  /** The setting this layout declares for its views (the `config` a view function declares, function-references
   *  proposal §3.5): the one thing it asks when a view is added, kept in the view's `layout_config[key]` and read from
   *  there — a field's name is never guessed at. Left out when the layout asks nothing (the table). */
  param?: {
    key: "date_field" | "group_by" | "cover_field";
    /** i18n key of the question, e.g. "Date field". */
    label: string;
    /** Field types offered first; other fields follow unless `onlyTypes`. */
    types: string[];
    onlyTypes?: boolean;
    /** Built-in columns also offered (calendar: created / updated). */
    builtIns?: Array<{ key: string; label: string }>;
    /** The view works without it (cards fall back to an image-looking field). */
    optional?: boolean;
  };
};

/** A switch for whether the note takes part in the module (「當成技能」): on, it
 *  is a row of the note's info panel; off, a command in the note's ⋯ menu and
 *  ⌘K that turns it on. It adds and removes the module's inside tag
 *  (`library.moduleTag`), which no list, chip or picker ever shows
 *  (lib/nodeTags isNoteSwitchTag). `label` is an i18n key. */
export type NoteSwitchSpec = {
  label: string;
  /** The module's fields for this note, drawn under the switch while it is on
   *  (loaded when shown). */
  Fields?: LazyExoticComponent<ComponentType<NoteHeaderActionProps>>;
};

/** What a section a module adds to a tag page gets. */
export type TagPageSectionProps = { tag: Tag; online: boolean; canManage: boolean; onOpenNode: (id: string) => void };

/** Where a nav destination sits in 「更多」 and the nav editor's 「在「更多」裡」
 *  (hooks/shellNavigation groupDestinations): in the named group, ordered
 *  by `order` (lower first). Left out, it is under 整理 (core) or 功能. */
export type NavGroupPlacement = { id: "time"; order: number };

/** Where a feature sits in Settings › Features (lib/libraryLayout): the group
 *  (what it is for) and its place in it (lower first). */
export type LibraryGroupPlacement = { id: "search" | "time" | "reading" | "ai" | "publish"; order: number };

export type FrontendModule = {
  /** Same id as the backend module (packages/backend/src/modules). */
  id: string;
  /** The part of the shell this module switches on (lib/shellFeatures): core
   *  screens that cannot be one module screen (the whiteboard's boards, day
   *  notes) ask for the feature, not for this module by id. */
  shellFeature?: ShellFeature;
  /** A control in the note header, before ⋯ (skills: 交給 AI). */
  noteHeaderAction?: ComponentType<NoteHeaderActionProps>;
  /** A switch in the note's info panel (skills: 「當成技能」); see NoteSwitchSpec.
   *  Needs `library.moduleTag`. */
  noteSwitch?: NoteSwitchSpec;
  /** A section on the pages of the person's own tags (skills: 用到的技能),
   *  shown while the module is imported; loaded when shown. */
  tagPageSection?: LazyExoticComponent<ComponentType<TagPageSectionProps>>;
  /** Loads the module's rows for the info panel's 「功能」 tab (tasks, boards,
   *  diary…) when the panel opens, so their code is not in the first load. The
   *  file's default export is a pure function of NoteFunctionEnv (testable on
   *  its own); a module with nothing to say returns []. The rows of its
   *  `noteCommands` that have a `row` are added by the panel, not here. */
  noteFunctionRows?: () => Promise<{ default: NoteFunctionRowsOf }>;
  /** This module publishes notes as a site (the website): the first-run
   *  "build your first site" offer imports and uses it. */
  sitePublisher?: SitePublisher;
  /** This module files related-note suggestions (`suggested` edges): a
   *  board draws them only while it is imported (semantic search). */
  suggestsLinks?: boolean;
  /** `source_type`s of notes this module creates by itself (RSS articles and
   *  sources): the sidebar tree tidies them away (lib/sidebarTidy.ts). */
  generatedSourceTypes?: string[];
  tagFunction?: TagFunctionSpec | readonly TagFunctionSpec[];
  /** A layout of a tag's saved views (a view module). */
  view?: ViewModuleSpec;
  /** A tab of a note's view row, drawn from the note (see NoteViewSpec). Its
   *  layout name is this module's id; needs `library` (the title and icon). */
  noteView?: NoteViewSpec;
  screen?: ModuleScreen;
  /** Sections the module adds to the reading hub (閱讀). */
  readingSections?: ReadingSection[];
  /** A small mark after the module's navigation entries (RSS: a dot when
   *  articles arrived since the reader was last open). The nav model carries
   *  it (hooks/useImportedFeatures → hooks/shellNavigation) to the
   *  desktop entry, the 更多 ▾ menu and the phone's 更多 sheet; with
   *  `dotOnly` it renders a plain dot for a container that folds the entry
   *  (更多 ▾, the phone's 更多 button). Renders nothing when nothing is new. */
  NavIndicator?: ComponentType<NavIndicatorProps>;
  openCommand?: OpenCommand;
  /** Items for the `/` menu in the note editor (no shipped module uses it now). */
  slashInserts?: SlashInsert[];
  dialogEntry?: DialogEntry;
  HomeSection?: ComponentType<HomeSectionProps>;
  /** What this module puts on a day of the 日子 page's timeline (tasks, quick
   *  captures, the wrap-up). Synchronous and from the local copy, so the page
   *  works offline; notes the person cannot read are not in that copy. */
  dayItems?: (context: DayItemsContext) => DayItem[];
  noteCommands?: NoteCommand[];
  /** Shown under 「設定」 on the module's card in the module library. */
  settings?: SettingDef[];
  /** A small picture of the feature at the top of its settings page (Settings
   *  › 功能 › it). Omitted when it cannot be drawn without words. */
  SettingsPreview?: ComponentType;
  /** The module's card in the module library (Tags page): what it is called
   *  and does. `title` / `description` are i18n keys. A workspace imports a
   *  module to use it; every surface above is shown only for imported ones. */
  library: {
    title: string;
    description: string;
    Icon: LucideIcon;
    /** The word `{word}` on a checkbox line that this module recognises (tasks: `{task}`). It is the module's own
     *  reserved word, never resolved to a tag. Not translated on purpose: it is typed into notes. */
    lineWord?: string;
    /** A row of the paragraph menu's 「試試功能」 that is not a tag function (tasks: 「把這段做成任務」): it writes the
     *  module's `lineWord` after the paragraph. `id` keys the preview example (components/functionCatalog/examples). */
    paragraphAction?: { id: string; label: string; Icon: LucideIcon };
    /** A module that gives tags an ability has a module tag (#複習): importing
     *  the module creates it under this name (an i18n key, sent translated),
     *  and other tags extend it to get the ability. */
    moduleTag?: { name: string };
    /** Modules this one needs (skills need ai; the backend twin is `library.requires`): its
     *  switch is disabled while one of them is off, and the server lists it as off. */
    requires?: readonly string[];
    /** Like `requires`, but one is enough (external calendars: the journal or tasks).
     *  The settings list only; the server does not read it. */
    requiresAny?: readonly string[];
    /** The group it is listed in on Settings › Features, and its place there.
     *  Left out only by the always-on ways of seeing, which that list does not show
     *  (test/moduleLibraryLayout.test.ts fails for any listed module without one). */
    group?: LibraryGroupPlacement;
    /** One short plain sentence under its name on that list (an i18n key); same rule as `group`. */
    blurb?: string;
    /** What the blurb says while the owner has it turned off (an i18n key). Left out, the blurb stays. */
    blurbOff?: string;
    /** A second line only the owner sees under the blurb, saying where its settings are (an i18n key). */
    ownerNote?: string;
    /** Its settings are a page of Settings itself, not a feature page: the row opens it. */
    settingsTab?: TabId;
    /** Always on, with no switch, and not listed in Settings › Features: a
     *  way of looking at notes, chosen with 「＋」 on a page, that holds no data
     *  to hide (the whiteboard). A tag layout (`view`) is one without saying
     *  so. The one rule is `isAlwaysOn` (modules/index). */
    alwaysOn?: boolean;
    /** The group its nav destination sits in under 「更多」 (日記: 時間). */
    navGroup?: NavGroupPlacement;
    /** What using it brings and what it can reach, shown in the one-time
     *  confirm (components/ModuleImportConfirm). Required: a module that
     *  adds fields, a schedule or network access must say so up front. */
    manifest: ModuleManifest;
    /** Whether the function is in use in this workspace: it shows in the
     *  default navigation bars only then (「更多」 lists it either way). Left out, it is in use once its
     *  module tag is used (lib/moduleUse tagUsed). */
    inUse?: (data: ModuleUseData) => boolean;
    /** Only for a module that waits for the owner's one-time yes (semantic
     *  search, RSS, website; backend `library.confirmOnce`): what it does,
     *  in plain words (an i18n key), shown first in the confirm. */
    confirm?: string;
  };
};

/** One thing turning a module on adds. `text` is an i18n key, one short line. */
export type ModuleAddition = {
  kind: "page" | "fields" | "tag" | "schedule" | "import" | "command" | "view";
  text: string;
};

/** What a module declares about itself for the one-time confirmation, honest
 *  and short. Its module tag (`library.moduleTag`) is listed by the dialog
 *  itself, so `adds` leaves it out. */
export type ModuleManifest = {
  /** What appears once it is on: pages, fields, schedules, imports. */
  adds: ModuleAddition[];
  /** Which notes it reads or writes (i18n key). */
  notes: string;
  /** What it connects to beyond this Onden (i18n key), or null when it
   *  never connects anywhere. */
  network: string | null;
};

/** A built-in module (docs/agents/decisions-modules.md): a module in code —
 *  one directory, lazy loading, a registry entry — that is always available.
 *  It has no `library` card, no import step and no "off" state, so it is not
 *  listed in Settings › Modules, and nothing asks whether it is on. What it
 *  contributes is only its settings, which sit in the tab they name. */
export type BuiltInModule = {
  /** Same id as the backend module that has no `library` (packages/backend/src/modules). */
  id: string;
  /** Only the module puts its tag on a note: no tag picker offers it (lib/nodeTags isAppliedByAppTag). */
  appliesOwnTag?: boolean;
  /** No backend twin: the module is drawn from data the app already holds
   *  (the graph). Every other built-in module has a backend module without `library`. */
  frontendOnly?: true;
  /** A tab this module adds to a NOTE's view row (the backend twin declares `noteViewLayout`). */
  noteView?: BuiltInNoteViewSpec;
  settings?: SettingDef[];
  /** A full-page destination (`?view=<module id>`), a nav destination like a
   *  feature's page unless `screen.inNav` is false; it is always on, so it is never "not imported". */
  screen?: ModuleScreen;
  /** A small mark after the screen's navigation entries (the inbox's waiting count). */
  NavIndicator?: ComponentType<NavIndicatorProps>;
};
