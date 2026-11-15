# Frontend modules

Tag functions live in the existing `SchemaLens` tag page: its 「功能」 section
comes first (a card per function — panel, 「設定」 and 「移除」 — and
「＋ 加入功能」, which makes the tag extend the module's tag; built-in functions are on by default, so there is no import step — only semantic search, RSS and website ask once), then fields, members, and an Advanced section (other
tags it inherits from, access rules). See
[`module-library.md`](../../../../docs/architecture/module-library.md). `lib/tagModules.ts`
reads explicit tag metadata shared by Home and the inspector; names and inline
hashtag text never confer a function. The reading view needs no separate router.
The inspector manages each direct tag membership once, with its provided functions
shown underneath. Applying/removing uses the existing tag writer; an explicit
removal explains all affected functions. It
never disables a tag's functions for every member merely to unenrol one note.
The translated tag catalog opens the same SchemaLens configuration owner, and
counts direct content memberships, not inline hashtag text. See
[`tag-operations-2026-09-30.md`](../../../../docs/archive/research/tag-operations-2026-09-30.md).

Module configuration uses the online-only `tagModuleWriter`: partial switch
changes, same-key retry, and a confirmed-but-unavailable result distinct from an
unsubmitted change. TagPack and schema editing keep their existing entry points;
the schema endpoint preserves the dedicated module settings. Tag-scoped review
sessions have a distinct identity so late responses cannot replace another scope.
For the complete contract and verified limits, see
[`tag-module-center-2026-09-29.md`](../../../../docs/archive/research/tag-module-center-2026-09-29.md).

The frontend twin of `packages/backend/src/modules/` — a module's UI lives in
one directory (`src/modules/<id>/`) whose `index.ts(x)` exports one
`FrontendModule` (`types.ts`). Same philosophy: cohesion + one-commit
deletability, NOT a dynamic plugin system.

## What a module can contribute

`modules/index.ts` lists the modules; the shell reads every surface from it
and never names a module (`test/moduleBoundary.test.ts` fails if a core file
imports a module's own files).

| Field | Where it shows |
| --- | --- |
| `screen` | A full page, `?view=<id>`; desktop nav lists it, the phone bar or More sheet offers it (`mobile`). Gets `ModuleScreenProps` (target, open note, refresh, immersive). |
| `openCommand` | A palette action that opens the screen. |
| `dialogEntry` | The module's own add dialog (SKILL.md): a button on the module's tag page (`tag.schema_module`) and an action in the command palette. It is not in the create list (`lib/createKinds`), which holds only built-in kinds. `open({ onOpenNode })` creates at the top level. |
| `HomeSection` | A line in the Home strip; renders nothing when it has nothing to say. |
| `noteCommands` | Actions on the open note: the info panel's 「功能」 tab (a row each, only while `available`) and the ⌘K palette, with the same label. `row` (NoteCommandRow) gives the row its icon, a sentence about this note (`describe`), the button's verb (`action`), optional `details` (≤ 3 lines when opened) and `name`; `related` false means the note has no tie to the function yet, so the row is listed under 「還能用在這則」 with `hint` as its sentence (publishing an unmarked note, 「當成技能」 off, playing a note that is not a deck). A command without a `row` is only in ⌘K (a new skill). Nothing is in the note's ⋯ menu: it only says how to see and take out the note. |
| `noteFunctionRows` | Rows of the 「功能」 tab that are not one command: a loader (`() => import("./noteFunctionRows")`) whose default export is a pure function of `NoteFunctionEnv` (the note, its text, `tasks`, `edges`, `canvasMemberships`, the pending AI `suggestions`, `nav`) and returns `NoteFunctionRow[]` — `status`, `badge`, `details` (≤ 3), one `action`, one `jump`, `related`; or `Custom` when the module draws the whole row (the website's publish status). The panel loads the files when it opens (not in the first load) and knows no module by name: tasks, whiteboard, diary, AI (skills) and website each give theirs. |
| `slashInserts` | Items in the note editor's `/` menu for text the module writes at the caret (no shipped module uses it now). `run({ node })` runs after the `/` is removed; the palette lists them too. |
| `settings` | `SettingDef`s shown under 「設定」 on the module's card in the module library (RSS: OPML import). |
| `library.manifest` | Required. What turning the module on adds (pages, fields, schedules, imports, commands, views) and what it can reach (which notes; the network, or `null` when it never connects). The one-time confirmation (`components/ModuleImportConfirm`, only for `library.confirm` modules) shows it before the module is first turned on. Keep each line short and true; the module tag is listed by the dialog itself. |
| `library.inUse` | Optional. Whether the function is in use in this workspace (a board exists, a feed is subscribed…): the default navigation bars a function only then; 「更多」 lists every function that is on, and a pinned one stays pinned. Left out, it is in use once its module tag is used (`lib/moduleUse` `tagUsed`). |
| `library.confirm` | Only for a module that waits for the owner's one-time yes (backend `library.confirmOnce`: semantic search, RSS, website). What it does, in plain words; shown first in the confirmation. |
| `tagFunction` | One function, or a list of them (the backend lists the same ids in `tagFunction`/`tagFunctions`, checked by `moduleDefinitionsAlign.test.ts`). A function tags can have: its card on a tag page, an optional `panel` (Review's session) and `settings` form (Review's daily cards; stored on the tag the function comes from). |

The whiteboard (`canvas`) is the exception: its module is only the library
switch. The whiteboard itself is core code woven into the notes screen, so
the module declares `shellFeature: "whiteboard"` and the shell asks
`useCanvasImported()` (the feature, `lib/shellFeatures`) and hides every
entry when it is not imported. The shell never names the module by id.
Daily notes (`daily`, 日記) work the same way (`shellFeature: "day-notes"`):
the module is the library switch, and the day-note entries (Today, ⌘⇧D,
quick capture's and the agenda's fallback note, the home mood picker, the day
template, 這一天's timeline) are core code that ask `dailyNotesEnabled()` /
`useDailyNotesEnabled()`. `lib/data/dayNotes.ts` `openToday` refuses
to start a day note while it is not imported. `modules/index` registers the
features when it loads; asking before that throws instead of answering "off".

AI (`ai`) is the same kind of module as daily notes (`shellFeature: "ai"`, `useAiEnabled()`): the info
panel's AI tab, @-mentions, 「交給 AI」, selection and paragraph AI actions, the AI waits in 「等你決定」,
AI roles and keys in Settings and the note's 「AI 改過」 ask the feature, never the module id. It is off in a
new workspace until the owner agrees once. `library.requires` (skills need ai) disables a switch while the
module it needs is off; the server also reports it as off.

A view module (`table`, `kanban`, `calendar`, `gallery`) carries its layout:
`view.Layout` draws the rows and `view.param` says what adding the view asks.
`components/collections/CollectionView` looks the layout up in `VIEW_MODULES`,
so a new layout is a module directory (with its `Layout`) plus one line in
`modules/index.ts` here and one in the backend's (`viewLayout: {}`); the
text i18n keys aside, no core file lists layouts. Layouts draw with
`components/viewLayoutKit` (grouping, row windowing, the calendar grid).

A note view (`noteView`, the slides' 「簡報」) is a tab of ONE note's view row
that a module draws from the note itself: a stored view whose `layout` is the
module's id (backend `noteViewLayout: true`), so the module being off hides the
tab and the server refuses to add one. Unlike a view module it makes no tag and
a tag's page never lists it. `OwnerViewPane` draws its lazy `Pane`; `useAddView`
lists it in ⋯ › 檢視. Its screen strings go in `modules/<id>/i18n.zh-TW.ts`
(`registerDictionary`, loaded with the screen, not at boot).

`ModuleTarget` deep-links a screen (an article, a source, the cards under a
note); a module reads the fields it understands.

Removing a module: delete its directory and its line in `modules/index.ts`
(and the backend module of the same id). The build still type-checks; tests
that assert the shipped composition (nav buttons, tag functions) then fail by
design.

## Rules

- A module's `index` is registration data only (id, name, icon, commands, the
  small "in use?" function). Its screens, view layouts, dialogs, settings widgets,
  note rows and large libraries load on use with `lazyWithReload(() => import(...))`,
  the way `tasks` and `rss` do; the place that renders one provides the `Suspense`
  (`SettingRow`, `renderLayout`, `openModuleDialog`, the info panel's function rows).
  What must work offline is listed in `loadOfflineModuleScreens` (modules/index.ts)
  so `lib/offlineWarmup` has the service worker keep it. After a build,
  `scripts/check-boot-bundle.mjs` holds the JS loaded after sign-in to a gzip
  budget and each module directory to its own cap, and names the module that
  went over; the numbers are in that script.

- Talk to the backend only through the module's own `/api/<id>` endpoints (or
  existing public ones) via `lib/api` — no new fetch conventions.
- Follow the app's voice: quiet, ordinary, no jargon surfaces
  ([[surface-no-programmer-ui]]).
- A module's own tests live in its directory, so they go with it.
