# Top-level navigation & mode model

> 狀態：歷史紀錄（最後確認 2026-11-01）

How a user moves around the space, and what the "you are here" unit is. The
question this doc answers: **is the top level a set of sibling destinations you
switch between, or a single home you compose views around?** Onden today picks
the first; every reference app that is actually a node space picks the second.

---

## Onden today

Top-level navigation in Onden is a **frontend-only mode model**. There is no
server-side concept of a "mode" at all — the backend is organized by *resource*
(nodes, edges, tags, tasks, canvases, collections, publish, versions, sync,
events), and a single `GET /api/workspace` aggregate returns the entire space at
once. Every mutation flows through the event-sourced spine regardless of which
mode triggered it, so "mode" is purely a client-side render decision.

On the client, a single union type
`Mode = "notes" | "tags" | "tasks" | "website" | "timeline"` is the spine of
navigation. It is declared **four times** — `AppMode` in `useUiMode.ts:13`, and
again inline in `AppTopbar.tsx`, `MobileNav.tsx`, and `useCommandPalette.ts`.
The active mode is a plain `useState` (`useUiMode.ts:20`, `BuilderApp.tsx:89`),
which means it is:

- **Not persisted** — no localStorage, no cookie.
- **Not URL-routed** — there is no router; a reload always drops you back to
  `"notes"`.
- **Not actor-attributed** — invisible to the audit spine, unlike every real
  mutation.

The desktop topbar (`AppTopbar.tsx:47`) renders `role="tablist"` with **five
truly co-equal buttons** — Notes / Tags / Tasks / Website / Timeline — each a
bare `setMode("...")`. The command palette mirrors this with six accelerators
(⌘1 Notes, ⌘2 Canvas, ⌘3 Website, ⌘4 Timeline, ⌘5 Tags, ⌘6 Tasks). Mobile
(`MobileNav.tsx`) exposes only **four of the five** — Tasks is silently dropped
— so the navigation model isn't even internally consistent across viewports.

### Notes is the de-facto, undeclared home

The five modes look co-equal but aren't. `mode === "notes"` renders the full
three-pane Obsidian workspace (sidebar + editor/canvas + activity pane); the
other four each render a *single* lazy component (`TagsMode`, `TasksMode`,
`WebsiteStudio`, `TimelineView`). Two privileges make Notes special:

- `showOverview = mode === "notes"` (`BuilderApp.tsx:367`) — the overview
  sidebar only exists in Notes.
- The right-hand inspector is gated: `selectedNode={mode === "notes" ? ... :
  null}` (`BuilderApp.tsx:852`) — the inspector exists **only** in Notes.

### Modes are one-way detours, not lenses

`selectedId` is shared state that physically survives a mode switch — but the
secondary modes refuse to use it. Every non-Notes selection handler force-routes
home: `TagsMode`/`TasksMode` do `onSelectNode = (id) => { setSelectedId(id);
setMode("notes"); }` (`BuilderApp.tsx:783,799`), and `TimelineView.onOpen` adds
`setNotesView("canvas")` (`BuilderApp.tsx:845`). So the act of selecting a node
in any secondary mode **ejects you back to Notes**. You can enter Tags/Tasks/
Timeline, but you cannot *act on a node* there without being thrown out. They
are detours, not workspaces.

### Cross-mode coordination is ad-hoc global side-channels

With no router, the modes talk to each other through two global hacks: a
`window.location.hash` channel (`#tag-view=<id>`, written by a pinned-tag button
in the topbar, read and then stripped by `TagsMode`), and a `window`
CustomEvent `onden-open-tags-mode` (dispatched from `CollectionsManager`, caught
in `BuilderApp`). These are the *only* cross-mode primitives — a router's job,
done by `window` globals.

### IA weaknesses (summary)

1. **Peer modes contradict the thesis.** Each mode is just a different query
   over the *same* unified dataset (Tasks → `data.tasks`, Tags → `data.tags`,
   Timeline → `snapshots`). These are textbook *lenses on a node's maturity*,
   yet they are presented as sibling *destinations*.
2. **Context resets on every detour.** Selecting a node anywhere but Notes
   destroys your place and dumps you home.
3. **No durable "where am I."** No URL, no persistence — nothing to bookmark,
   deep-link, share with the agent, or restore on reload.
4. **The agent can't reference a view.** Because location lives in volatile
   React state and isn't actor-attributed, a co-inhabiting agent has no
   addressable handle on "the canvas of node X" to navigate to or cite.
5. **Inconsistent surface.** 5 modes on desktop, 4 on mobile, 6 palette
   accelerators — the model isn't even uniform.
6. **`home_node_id` is wasted.** The server already has a `home_node_id`, but it
   is used only as a Website publish setting and the bootstrap default
   selection (`BuilderApp.tsx:354`) — never as a navigational hub.

---

## How the field does it

Verified against vendored source where available (Anytype, AFFiNE, reor, khoj,
Logseq, SiYuan, Trilium, AppFlowy, Blinko); Obsidian / Notion / Heptabase / Tana
from public docs.

| App | Approach | What's good |
| --- | --- | --- |
| **Anytype** (vendored) | No top-level modes. A single space whose top-level entity is a **HOME object** opened like any other object. The left sidebar swaps *page types* (widget / vault / settings / library), and its payload is a stack of **widgets** — each a lens over a target object whose layout (`I.WidgetLayout`: `Link / Tree / List / Compact / View` + `Space / Object`) the user picks **per-widget**. Graph is just another full-page view. "Type" and "Relation" are themselves objects edited in settings/library. | Layout is a property of the **widget**, not global app state — the *same* object renders through any lens. Directly validates **tag = node you open** and **lens, not mode**. |
| **AFFiNE** (vendored) | Router-based **Workbench**, not modes. A workbench holds an array of **views** (split-view tabs), each a browser-like history stack with a `location$` URL. The sidebar is a list of route *links* (`/all`, `/chat`, `/trash`, `/journals` + Collections / Favorites / Tags). A doc opens at its own route. Page-vs-edgeless (whiteboard) is a **per-doc `primaryMode` property** (`record.ts:72` `primaryMode$` / `setPrimaryMode`), persisted on the doc. | "Mode" (page vs whiteboard) is a **lens on one node, persisted on that node** — never a global app mode. URLs mean reload restores the view and anything is deep-linkable. |
| **reor** (vendored) | No top-level modes. The **open file** is the persistent center (`EditorManager` fixed, `EmptyPage` when none). A thin icon rail toggles which *panel* the left sidebar shows (`SidebarAbleToShow = 'files' \| 'search' \| 'chats'`); chat / similar-files are right-hand resizable panels. | Navigation is **panel composition around a constant editor** — never a context-resetting mode swap. |
| **khoj** (vendored) | App-shaped (chat-first): router pages Home / Agents / Automations / Search / Settings as `href` links in an icon rail. These *are* peer destinations. | Honest peer-mode model — but only because khoj is an **AI assistant**, not a node space. This is the **anti-pattern** for a PKM: peer modes fit distinct product surfaces, not lenses on one dataset. |
| **Logseq** (vendored) | Router-based, not modes. Routes are `:home` / `:page` / `:page-block` / `:all-pages` / `:graph` (`handler/route.cljs:134-150`). The **left sidebar is nav links** — Journals, Flashcards, All-pages, Graph-view, plus tag-pages Tasks/Assets (`components/left_sidebar.cljs:165-218`), each an `rfe/href` route or a `go-to-*!` redirect. The **right sidebar is a stack of pinned items** keyed by `block-type` — `:page` / `:page-graph` / `:block-ref` / `:contents` / `:search` (`components/right_sidebar.cljs:108-143`): a page, its graph, and a block reference can sit open *side by side*. | Graph/flashcards/all-pages are **routes, not a global mode swap** (URL-addressable, reload-safe). The page-graph as a right-sidebar lens **next to** the page is exactly "lens coexists with content," not a destination you switch into. |
| **SiYuan** (vendored) | No top-level modes. The center is a **tab-and-split workbench** (`layout/` — `Layout`/`Wnd`/`Tab`, `layout/index.ts`); peripheral lenses are **dockable panels**, not modes: `TYPES = ["file","outline","inbox","bookmark","tag","graph","globalGraph","backlink"]` (`layout/dock/index.ts:25`), each a Dock model (`layout/dock/{Files,Outline,Backlink,Graph,Tag,Bookmark,Inbox}.ts`). A document opens as a tab; graph/backlink/outline dock around it. | File-tree, graph, backlinks, tags **compose around the open document**, never a context-resetting mode. Validates "navigation = panel composition around a constant editor" (the reor shape at higher fidelity). |
| **Trilium** (vendored) | No top-level modes — a **hierarchical note tree is the spine** (`apps/client/src/widgets/note_tree.ts`), with multi-parent **cloning** via `BBranch`. Each note carries a **`type`** (18 of them: `text, code, canvas, render, relationMap, mermaid, mindMap, noteMap, book, webView, file, image, search, doc, …` — `packages/commons/src/lib/rows.ts:114-133`) which picks a **type-widget renderer** (`apps/client/src/widgets/type_widgets/{canvas,relation_map,MindMap,NoteMap,Render,...}`). **Hoisting** focuses the tree to any subtree as a temporary root (`services/hoisted_note.ts`, `note_tree.ts:222`). | "How a note renders" (text vs canvas vs relation-map vs mind-map) is a **property of the node (`type`)**, not a global app mode — the AFFiNE/AppFlowy "layout lives on the node" pattern, taken to 18 renderers. Hoisting is a **scoped home** without leaving the tree. |
| **AppFlowy** (vendored) | No top-level modes. The sidebar is a **tree of `View`s** inside spaces; a view's **`layout` is a property of the view** — `ViewLayoutPB { Document=0, Grid=1, Board=2, Calendar=3, Chat=4 }` (`rust-lib/flowy-folder/src/entities/view.rs:61,188-195`). Opening a view renders by its stored layout: `layout` → `PluginType` (`appflowy_flutter/lib/workspace/application/view/view_ext.dart:92-97`). A database's Grid/Board/Calendar are alternate layouts of the **same** view data. | Layout is **persisted on the node**, exactly AFFiNE's `primaryMode` and Anytype's per-widget layout — the *same* data renders Grid or Board or Calendar with no global "board mode." Direct cross-language (Rust+Dart) confirmation of **lens, not mode**. |
| **Blinko** (vendored) | Quick-capture app. Sidebar entries (`store/baseStore.ts:14-67`) are mostly **filters over one note stream via `?path=` query params** — `/?path=notes`, `/?path=todo`, `/?path=archived`, `/?path=trash` all hit the same list; only `/analytics`, `/resources`, `/settings`, `/plugin` are genuine separate pages. Active view derived from the URL (`baseStore.ts:151-176`). | Peer-*looking* sidebar items that are actually **URL-addressable lenses over a single dataset** — the opposite of Onden's volatile in-memory modes. Even a capture-first app makes location routable and most "destinations" into filters. |
| **Obsidian** (docs) | No modes. Workspace is a tree of leaves; each leaf has a view *type* (markdown, graph, backlinks…). Graph/outline are just leaf types in tabs alongside note leaves. Layouts persist. | No global "graph mode" — the same note can sit in a tab **next to** a graph leaf. Lens and content coexist. |
| **Notion** (docs) | No modes — everything is a **page**. A database is a page; its views (table / board / timeline / calendar / gallery) are tabs **within** that database page. | Lens-switching is **scoped to the node**, not a top-level app mode. |
| **Heptabase** (docs) | Browser-like tabs + bookmarks. Named surfaces (Journal / Whiteboard / Card Library / Tag Database / Map) are *entry points* into one network; any card opens as a tab regardless of where you came from. | Entry points without context reset — surfaces are doorways, not silos. |
| **Tana** (docs) | No modes — **everything is a node** (fields, views, commands, the daily page, the workspace). The **HOME node** is the root hub; supertags (= `class_tag`) are nodes you open to configure; views are nodes too. | Full validation of **node = home, tag = node, lens not mode** in a single coherent model. |

### Common pattern

The field splits cleanly, and the newly-verified vendored PKMs land squarely on
the same side. Every app that is a **node space** (Anytype, AFFiNE, reor,
Logseq, SiYuan, Trilium, AppFlowy, Blinko, Obsidian, Notion, Heptabase, Tana)
converges on the same shape: a **persistent home / open node is the center of
gravity**, and navigation **composes panels and lenses around it** rather than
swapping into sibling destinations. A "mode" (page vs whiteboard, table vs
board, text vs canvas) is a **lens scoped to a node**, and three vendored apps
make this literal by **persisting the lens on the node itself** — AFFiNE's
`primaryMode`, AppFlowy's `view.layout`, and Trilium's note `type`. Where lenses
*aren't* on the node they are at least **routes/panels** (Logseq routes +
right-sidebar stack, SiYuan dockable panels, Blinko `?path=` filters), so they
are URL-addressable and reload-safe — never volatile global state. The only
vendored app with co-equal top-level modes is **khoj — and only because it is an
AI assistant, not a knowledge graph.** Onden today is built like khoj while
aspiring to be Tana.

---

## The gap

Onden's five co-equal modes put it on the wrong side of that split. The gap is
not cosmetic — it is a category error baked into the IA:

1. **Mode where the field has lens.** Notes / Tags / Tasks / Website / Timeline
   are lenses on the same dataset, but Onden ships them as destinations. The
   thesis *names* this exact mistake ("kill co-equal mode-switching").
2. **No home object.** The field's center of gravity is an addressable node
   (Tana home node, Anytype home object, AFFiNE active view, reor open file).
   Onden has `home_node_id` on the server but no navigational home — Notes is an
   *implicit, privileged* home that only earns the inspector and overview by
   `mode === "notes"` checks scattered through `BuilderApp`.
3. **No durable location.** AFFiNE/Anytype/Obsidian/Notion all give a view a URL
   or a persisted layout. Onden's location is volatile React state — not
   routable, not restorable, not bookmarkable, and **not visible to the agent
   or the audit spine** despite the thesis's actor-attribution mandate.
4. **Detours instead of lenses.** Anytype renders the same object through any
   lens with no context loss; AppFlowy renders the *same* view as Grid/Board/
   Calendar by a stored `view.layout`; SiYuan docks graph/backlinks around a
   constant open document; Heptabase opens any card from any surface without
   reset. Onden actively *ejects* you to Notes the moment you select a node
   outside it — the opposite of lens behavior.
5. **Tags/Website are mode-shaped but shouldn't be.** Per the thesis, a tag is a
   node (a `class_tag` carrying schema/policy) — so "Tags mode" should be
   *opening that node through a schema/policy lens*, exactly as Anytype and Tana
   edit Types/supertags as objects. Website should be a publish *gesture/
   destination*, not a peer mode — like AFFiNE's per-doc share, not a global
   workspace tab.

---

## Recommendation for Onden

Collapse the five peer modes into **one home + a lens switcher**, and make the
home an addressable node — bringing the IA in line with the thesis
(`node = home`, lenses on maturity, `tag = node`) and with every node-space
competitor.

### 1. Make the node the home; make modes into lenses on it

Replace `Mode = notes|tags|tasks|website|timeline` with **(a)** a *current
node* (defaulting to `home_node_id`, which already exists server-side) and
**(b)** a *lens* the user picks for the current view: `canvas | graph | table |
inbox | timeline | notes/editor`. The lens is a view of the node's maturity, not
a sibling destination — this is the Anytype "layout is a property of the widget,
not global state" model and the Notion "views are tabs within the database page"
model. Concretely:

- The right-hand inspector and the overview sidebar stop being gated on
  `mode === "notes"`; they belong to **whatever node is open**, in any lens.
- Selecting a node never ejects you. Switching lens keeps the current node;
  selecting a node keeps the current lens. Kill every
  `onSelectNode = (id) => { ...; setMode("notes") }` — the detour-eject is the
  single most thesis-violating line in the codebase.

### 2. Demote "Tags" — a class_tag is a node you open

There is no Tags *mode*. A `class_tag` is a `content_node`; opening it puts you
in the home with a **schema/policy lens** (its fields, its governance, its
members) — exactly how Anytype edits a Type and Tana configures a supertag. The
existing `#tag-view=<id>` hash and the `onden-open-tags-mode` CustomEvent become
ordinary "open node X with lens = schema" navigation, and the global side-
channels die with the router that replaces them.

### 3. Demote "Website" to a publish gesture

Publishing is a **destination/action on a node**, not a workspace you live in
(AFFiNE models share as a per-doc property, not a tab). Move it to a publish
gesture on the current node — its server home is already `publish.ts` +
`home_node_id`. `WebsiteStudio` becomes a focused surface you *invoke*, not one
of five things the topbar treats as equal.

### 4. Introduce real, addressable, attributable location

Adopt AFFiNE's lesson: give a view a **URL/route** (`/node/:id?lens=canvas`) so
reload restores it, it is bookmarkable, and — critically for Onden's single-
human-plus-agent thesis — **the agent can reference and navigate to a view**,
and location changes can be actor-attributed like every other action. This fixes
the "reload always returns to notes," "no deep-link," and "invisible to the
spine" weaknesses in one move. Persist per-node lens preference on the node (as
AFFiNE persists `primaryMode`) so a canvas-heavy node reopens as a canvas.

### 5. Replace the tablist with a lens switcher + a home control

The topbar's 5-button `role="tablist"` becomes: a **home/breadcrumb** control
(where am I — which node) plus a **lens switcher** (how am I looking at it). The
six palette accelerators rebind from *modes* to *lenses on the current node*
(⌘1 editor, ⌘2 canvas, ⌘3 graph, ⌘4 timeline, ⌘5 table/inbox…). This also
fixes the desktop-5/mobile-4 inconsistency: one model, one switcher, every
viewport.

**Net effect:** Onden stops being shaped like khoj (peer modes for an AI
assistant) and becomes shaped like Tana/Anytype (one home node, many lenses) —
which is what the thesis has been describing all along. The migration is
incremental: introduce the router + current-node/lens state first, port one
secondary mode at a time into a lens, and delete the `setMode("notes")` ejects
as each lens learns to keep its node.
