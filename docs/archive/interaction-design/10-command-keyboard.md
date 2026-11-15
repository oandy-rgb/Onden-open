# Command palette & keyboard-driven navigation

> 狀態：歷史紀錄（最後確認 2026-11-01）

## Onden today

Onden ships one command palette (Cmd+K / Ctrl+K) plus a thin layer of hardcoded
global shortcuts. The architecture is sound; the *information design* of what the
palette surfaces is where the thesis is being contradicted.

**The palette is a clean controlled component.** State and logic live in
`useCommandPalette.ts`; presentation is the pure `CommandPalette.tsx`. `BuilderApp`
owns `open` / `query` / `index` / `inputRef` and passes everything down as props,
which is why the view is heavily unit-tested. Items are a tagged union
`PaletteItem = node | action | canvas`, merged from three sources in one `useMemo`:

1. **13 static actions** (`paletteStaticActions`) — a "Navigate" group (Go to
   Notes/Canvas/Website/Timeline/Tags/Tasks, shown with kbd hints ⌘1–⌘6) and an
   "Actions" group (Create note ⌘N, Create sketch, Open today's note ⌘D, Export
   workspace as Markdown, Tidy up canvas, Auto-arrange as tree, Refresh data).
   Each carries a `run()` closure over `BuilderApp` setters.
2. **One entry per canvas** (`paletteCanvasActions`, group "Canvases").
3. **Backend node search results.**

**Two modes, keyed off the leading character.** A leading `>` enters *command
mode* (filter actions/canvases by case-insensitive substring; show all when empty).
Otherwise it is *search mode*: query ≥ 2 chars shows up to 8 backend node hits
("Notes") followed by substring-matched actions; an empty/short query shows up to 5
"Recent Notes" (top-level, non-hidden, **non-class-tag** nodes by `updated_at`) then
all actions and canvases. Keyboard handling inside the input clamps ArrowUp/Down over
the flat index, Enter selects, Escape closes; mouse hover sets the active index, and
selection fires on `onMouseDown` (chosen over `onClick` so it beats the input blur).

**The backend is far more capable than the UI admits.** `GET /api/nodes/search`
(debounced 200 ms, ≥ 2 chars, failures swallowed for offline) calls `searchNodes()`,
which parses a real query DSL (`@onden/markdown` 的 `searchQuery.ts`): `#tag` requires a
`class_tag` by lowercased title, `key:value` matches a `node_attribute`
(case-insensitive), `"quoted phrase"` is preserved, and the rest is fed to pgroonga
full-text (`n.title &@~ $x OR n.markdown &@~ $x`), ordered by `pgroonga_score` when
text matched. Snippets come back as pgroonga `<mark>…</mark>` HTML;
`CommandPalette.tsx` deliberately does **not** use `dangerouslySetInnerHTML` —
`renderHighlightedSnippet()` regex-extracts only the `<mark>` spans (XSS hardening
against agent / RSS / imported markdown). Semantic embeddings exist
(`services/embeddings.ts`) but feed link suggestions only — the palette is
keyword-only.

**Global shortcuts** live in one `useKeyboardShortcuts.ts` window keydown effect:
Cmd+K (toggle palette), Cmd+Shift+N (quick capture), Cmd+Shift+D (daily note),
Cmd+N (new note), Cmd+F (focus sidebar/canvas search), Cmd+S (save draft), Cmd+E
(toggle edit/preview), Delete/Backspace (delete selected card in canvas), Escape
(deselect / close).

### IA weaknesses

- **The palette encodes the five-peer-mode topbar.** Six of the thirteen static
  actions are "Go to Notes / Canvas / Website / Timeline / Tags / Tasks." The
  palette is teaching the user that these are co-equal destinations — the exact
  mental model the thesis wants to kill. The palette inherits the mode switcher
  instead of transcending it.
- **No node-relative commands.** Every action is a global app verb. There is no
  "promote this node to a class," "open this node on the canvas," "apply
  #tag here" — nothing that operates on *the node you are looking at*. The palette
  cannot express the maturity loop because it has no concept of "the current node."
- **The DSL is invisible.** `#tag`, `key:value`, and quoted phrases are fully
  supported by the backend and never advertised, taught, or autocompleted in the UI.
- **Recent Notes excludes class-tags.** Because tags are filtered out of the recent
  list, the palette structurally denies that "a tag is a node" — you cannot reach a
  class via the same affordance you reach any other node.
- **No fuzzy matching, no aliases, no frecency.** Matching is raw substring
  `includes()`. Common actions are not boosted; there are no synonyms to teach
  vocabulary; no command exposes a rebindable or directly-firing hotkey.
- **Shortcuts are hardcoded and unlisted.** No cheat-sheet, no rebinding, no
  discoverability surface; the kbd hints only appear inside the palette rows.

## How the field does it

Source-provenance note: rows below marked **(source-verified: path)** were read
directly from vendored competitor source in this repo. Rows for apps whose source
is **not** vendored (Linear, Raycast, Superhuman, Tana, Obsidian) remain
**web/docs-sourced** and are labelled as such.

| App | Approach | What's good |
|---|---|---|
| **AFFiNE** *(source-verified: `AFFiNE/packages/frontend/core/src/modules/cmdk/`, `.../commands/`)* | cmdk "quick search" (Cmd+K) over a pluggable **provider** registry (docs, recent, commands, tags, collections, journals, links, creation); each provider is a reactive `LiveData` session whose `items$` recompute per query and merge into score-ordered groups. Commands are a separate first-class registry (`createAffineCommand` with id/icon/`keyBinding` as a tinykeys string + a `PreconditionStrategy` enum — `Always` / `InPaper` / `InEdgeless` / `InPaperOrEdgeless` / `Never` / custom fn — that **gates visibility by editor context without disabling the keybinding**). Fuzzy via Fuse.js (`label.title` weight 2 + subtitle, `ignoreLocation`), `<b>` highlighter; `shouldFilter={false}` (providers filter); a `useReducer` **preserves the highlighted selection across result updates**. A `creation` provider synthesizes `Create new doc as "{query}"`. Every selection fires `track.$.cmdk` telemetry. | Context-gated commands without losing the keybinding; search-to-create; selection stability; merged multi-source results. |
| **Anytype** *(source-verified: `anytype-ts/src/ts/component/popup/search.tsx`, `anytype-ts/src/json/shortcut.ts`)* | **Multiple purpose-built surfaces**, not one palette: Cmd+K = object search popup, Cmd+O = navigation/links, Cmd+Alt+O = graph, Cmd+1–9 = switch spaces, Ctrl+Space = shortcuts cheat-sheet. Shortcuts are a **data-driven, user-rebindable registry** (`json/shortcut.ts` sectioned defaults; `mapper()` overlays `Storage.getShortcuts()` so user overrides win; `UseShortcut` analytics per dispatch). The object search runs server-side relation-key filters (`resolvedLayout NotIn excludeFromSet`) and sort (last-opened/modified desc) with infinite-scroll, and **always offers an inline `Create object with name "{filter}"`**. The cheat-sheet popup is itself an editable rebinding UI (Reassign / Reset / Remove). | Rebindable shortcuts as data; search-to-create; the "object search" *is* the home navigation; lens-specific surfaces. |
| **Trilium** *(source-verified: `Trilium-main/apps/client/src/widgets/dialogs/jump_to_note.tsx`, `.../services/command_registry.ts`, `.../services/note_autocomplete.ts`)* | **One dialog, mode-switched by a leading `>` — the exact pattern Onden already uses.** "Jump to Note" (Cmd+J) is the note-jumper; a leading `>` flips it into command mode (`isCommandMode = text.startsWith(">")`) and `commandPalette` (a separate command/shortcut) opens it pre-seeded with `>`. The command registry is **scope-aware**: each command carries a `scope` (`note-tree` / `text-detail` / global) and `executeCommand` dispatches into the focused tree node or the active text widget accordingly (`executeWithNoteTreeFocus`, `executeWithTextDetail`) — node-relative verbs, not just global ones. Keyboard actions are **auto-imported as commands** with their primary shortcut formatted and shown inline; commands support **aliases** (scored: exact 100 / prefix 80 / contains 60 / alias 50 / description 40). Search-to-create is built in (`allowCreatingNotes`, a `create-note` action row "Create note: {term}"), and Ctrl+Enter escalates a note query into full search. | A `>`-prefixed dual-mode palette (validates Onden's own design); scope-aware node-relative command execution; keyboard-action→command unification with inline shortcuts; aliases + scored ranking; search-to-create. |
| **Logseq** *(source-verified: `logseq-master/src/main/frontend/components/cmdk/core.cljs`, `.../handler/command_palette.cljs`)* | cmdk over **typed result groups** — current-page, nodes, commands, files, themes — each loadable independently and **scopable via `filters`** (pick a group to constrain the search to it). Matching is real **fuzzy** (`search/fuzzy-search` / `fuzzy-search-multi`), FTS hits get `highlight-content-query` `<mark>` hiccup, and an explicit **`source-create :page`** synthesizes `Create page "{q}"`. The command registry (`handler/command_palette.cljs`) is a `register`-spec'd map of `{id, desc, action fn, shortcut keybinding, tag}`; it tracks an **invoke history and sorts commands by `invokes-count` (frecency)**, and ingests global-shortcut commands automatically. | Group filters as query scoping; genuine fuzzy + FTS highlight; search-to-create-page; **frecency** boosting from an invoke-count history. |
| **SiYuan** *(source-verified: `siyuan-master/app/src/boot/globalEvent/command/panel.ts`, `.../command/global.ts`)* | A `commandPanel` dialog built **directly from the user's rebindable keymap** (`window.siyuan.config.keymap.general` + editor general): every row renders the action label plus its **current custom hotkey** (`updateHotkeyTip(...custom)`), so the palette doubles as a live shortcut cheat-sheet. **Plugins inject their own commands** (with custom hotkeys) into the same list. Dispatch (`execByCommand`) is **focus/scope-aware**: it resolves whether a protyle editor, the file tree, or neither is focused and routes the command to global / editor / file-tree handlers. Filtering is plain substring over label+command-id. | Palette generated from the rebindable keymap (shortcuts always shown + current); plugin-extensible command set; focus-scoped dispatch. |
| **Joplin** *(source-verified: `joplin-dev/packages/app-desktop/plugins/GotoAnything.tsx`)* | "Goto Anything" (Cmd+P) with **sigil-prefixed modes — the closest external analog to Onden's `#tag` / `key:value` DSL**: leading `:` = command search (`CommandService.searchCommands`), `#` = tags, `@` = folders/notebooks, anything else = note FTS (`gotoAnythingStyleQuery` → `SearchEngine`). Note results render parsed-keyword highlighted body **fragments** around matches, capped to a limit. The sigils are advertised in the placeholder/help, i.e. the grammar is taught, not hidden. | A sigil DSL that *exposes* its operators in-UI (vs Onden hiding its `#`/`key:`); command-vs-content modes in one input; keyword-fragment snippets. |
| **AppFlowy** *(source-verified: `AppFlowy-main/frontend/appflowy_flutter/lib/workspace/.../command_palette/`)* | Cmd/Ctrl+**P** (note: not Cmd+K) opens a modal that, **when the query is empty, shows a Recent Views list** (not actions). Search **merges local + server (cloud) results** into one ordered map (`combinedResponseItems`) and, on a server workspace, also streams **AI search summaries** (`resultSummaries`, `generatingAIOverview`) above the hits — RAG-in-palette. On no-match it offers an **"Ask AI" entrance** that spawns a Chat page seeded from the query (search-to-ask), plus a hint linking to Trash. No fuzzy/alias layer; gating is by workspace type, not editor context. | Recent-on-empty; merged local+cloud results; **AI summary + "ask AI" as the no-match fallback** (search-to-ask, a variant of search-to-create). |
| **Linear** *(web/docs-sourced — not vendored)* | Cmd+K as the primary action surface; commands are **context-aware** — issue-scoped actions (assign / label / status) surface only when an issue is focused; most are global. Results render the command's shortcut inline to teach it. | In-context command scoping; shortcut-teaching. |
| **Raycast** *(web/docs-sourced — not vendored)* | Root search with three power features: **aliases** (2–3 chars jump to a command) + per-command **global hotkeys** (fire without opening); **favorites** pinned to Cmd+1–9; **fallback commands** when a query has no match (web/file search, create-with-query), and single-argument Quicklinks invoked with the typed query as the argument (search-to-act). | Aliases + frecency; user-defined fallbacks; query-as-argument. |
| **Superhuman** *(web/docs-sourced — not vendored)* | Palette manifesto: **one shortcut everywhere** (no Cmd+K vs Cmd+P split); "omnipotence" (every action is a command); forgiving fuzzy via `command-score` with a threshold; **synonyms/aliases** shown as `Title (matched alias)` to teach vocabulary; default/frecency scores boost common commands *before typing* and dampen others to 0 (progressive disclosure); contextual boosting by app state; "learn the shortcut for next time" beside results; intentionally truncated last row. | Progressive disclosure via scoring; alias-teaching; single unified entry point. |
| **Tana** *(web/docs-sourced — not vendored)* | Cmd+K "command line" reaches **every action, including node-transforming ones** ("Convert to command node," "Convert to supertag"). | The palette as the surface for *structural* node operations, not just navigation. |
| **reor** *(source-verified: `reor/src/.../shortcuts`)* | **No palette.** 6 flat global shortcuts (mod+O/N/P/T/D/,) with per-platform `displayValue`, dispatched via Electron accelerators; search is a dedicated semantic-search modal. | Minimal; this is essentially Onden's hardcoded-shortcut tier without the palette. |
| **Blinko** *(source-verified: `blinko-main/app/src/hooks/useInitialHotkeySetup.ts`, `.../useQuicknoteHotkey.ts`)* | **No command palette.** Only OS-level **global quick-capture hotkeys** registered through Tauri (`invoke('register_hotkey', ...)`) for quick-note / quick-AI; in-app there is a hotkey settings panel but no Cmd+K launcher. | (Counter-example — a capture-first app that skips the palette pattern entirely; like reor, the shortcut tier without the palette.) |
| **khoj** *(source-verified: `khoj/src/interface/desktop/`, shadcn cmdk usage)* | **No Cmd+K launcher.** Ships the shadcn/cmdk primitive but uses it only as a combobox inside dropdowns (model selector); relies on Obsidian's own palette + a semantic SearchModal. | (Counter-example — cmdk present, palette pattern not adopted.) |

## The gap

The mature palettes converge on three things Onden lacks — and the now-verified
vendored PKMs (Trilium, SiYuan, Logseq, Joplin) corroborate each point in actual
code, not just marketing:

1. **Commands that operate on the current object, gated by context.** AFFiNE's
   `PreconditionStrategy` and — verified in vendored source — **Trilium's `scope`
   (`note-tree` / `text-detail`) routing in `command_registry.executeCommand`** and
   **SiYuan's focus-aware `execByCommand`** both dispatch a command into the focused
   node/editor rather than firing a global verb. (Linear's issue-scoped actions,
   Tana's node-transforming verbs, and Superhuman's state-aware boosting are the same
   idea, web-sourced.) Onden's palette only knows global app verbs.
2. **Search-to-create and search-to-act.** AFFiNE, Anytype, and — verified —
   **Trilium (`create-note` "Create note: {term}")** and **Logseq
   (`source-create :page`, "Create page {q}")** all turn a no-match query into a
   creation affordance; **AppFlowy** turns it into an "Ask AI" chat seeded from the
   query (search-to-ask). Raycast's query-as-argument is the web-sourced analog.
   Onden dead-ends a non-matching query.
3. **Progressive disclosure of power.** Verified in source: **Logseq ranks commands by
   an invoke-count frecency history** and offers **fuzzy** matching + group `filters`;
   **Trilium** has **aliases + scored ranking** and shows each command's shortcut
   inline; **SiYuan generates the palette from the rebindable keymap so the current
   hotkey is always displayed**. Together with Anytype's editable cheat-sheet, these
   show a palette can be simple at rest and omnipotent on demand. Onden hides its best
   feature — the `#tag` / `key:value` DSL — entirely, even though **Joplin proves the
   pattern works by *exposing* its `:` / `#` / `@` sigils in-UI**.

Critically, Onden's palette also actively **reinforces the wrong mental model**: it
re-lists the five peer modes as navigation targets, and it filters class-tags out of
the node results — so it teaches "modes are destinations" and "tags are not nodes,"
both contradicting the thesis.

## Recommendation for Onden

The palette should become the **primary expression of node = home, lenses, and the
maturity loop** — the one keyboard surface where the unified mental model is most
legible. Concretely:

**1. Replace mode-navigation actions with lens + node actions.** Kill the six
"Go to {mode}" entries. The thesis says canvas / graph / table / inbox / timeline are
**lenses on a node**, not peer destinations. So:

- When a node is focused, surface *lens* commands scoped to it: "View on canvas,"
  "Open as table," "Show in graph," "Open timeline" — each opening the **current
  node** in that lens (not a global mode). This is AFFiNE's `PreconditionStrategy`
  applied to lenses: a `currentNode`-gated visibility predicate, keybinding intact.
- Keep "Website" only as a **publish gesture** ("Publish this node to website"),
  never as a "Go to Website" mode. The destination is an action on a node, not a
  place you navigate to.

**2. Make the palette the surface for the maturity loop.** Add node-relative,
context-gated commands that move a node along capture → diverge → converge:

- *Capture:* "Create note as '{query}'" / "Capture to inbox" (search-to-create,
  borrowed from AFFiNE/Anytype — turn the typed query into the title).
- *Diverge:* "Add this to a canvas," "Link to current node," "Branch a sketch."
- *Converge:* "Promote to class (tag = node)," "Apply #tag," "Set {key}:{value}."
  These are Tana-style structural verbs — the palette is where a connection
  *becomes* a capability.

**3. Honour tag = node = class.** Stop filtering class-tags out of Recent Notes and
search results. A class-tag is reachable by the same Cmd+K affordance as any node,
and selecting it **opens that node with a schema/policy lens** (per the working
hypothesis: editing a class = opening its node + a schema lens). The palette is the
proof that the tag space has collapsed into the node space.

**4. Surface the DSL instead of hiding it.** The `#tag` / `key:value` / `"phrase"`
grammar already works server-side. Teach it: a hint row in the footer, token
autocomplete for `#` and `key:`, and chip-rendering of parsed tokens in the input.
This is a felt capability unlock for the single-human-plus-agent workspace —
attribute-precise retrieval over an event-sourced store. **Joplin's vendored "Goto
Anything" is the proof point**: its `:` (commands) / `#` (tags) / `@` (folders)
sigils do exactly this and are advertised in-UI rather than hidden — Onden already
has the richer grammar and just needs to expose it. Note too that Onden's existing
`>` command-mode is not idiosyncratic: **Trilium ships the same leading-`>` dual-mode
in `jump_to_note.tsx`**, so the pattern is validated — the gap is purely that Onden
stops at `>` and never surfaces `#` / `key:`.

**5. Add progressive-disclosure plumbing.** Swap substring `includes()` for fuzzy
scoring (Fuse.js / command-score) with frecency boosting so common actions rank
before typing; render each command's shortcut inline (Linear/Superhuman "learn it
for next time"); support aliases/synonyms shown as `Title (matched alias)` to teach
Onden's vocabulary (node, lens, class, capability). Preserve the highlighted
selection across result updates (AFFiNE's reducer) so streaming backend results don't
reset the cursor.

**6. Make shortcuts data + discoverable.** Lift the hardcoded `useKeyboardShortcuts`
handlers into a small registry (id, default keys, label, context predicate), render a
Ctrl+/ cheat-sheet from it (Anytype's editable popup is the model), and — because
**every mutation is actor-attributed on the spine** — log shortcut/command use
through the same audited path, so the human's keyboard actions and the agent's
actions share one attributable command surface. The palette is not just navigation;
it is the human's half of a two-actor command channel.

The north star: a single Cmd+K that, with a node in focus, can navigate to it, view
it through any lens, advance its maturity, type it as a class, and publish it —
without ever implying that "Notes," "Tags," "Tasks," "Website," and "Timeline" are
five different places.
