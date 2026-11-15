# Multi-view lens switching on the same content

> 狀態：歷史紀錄（最後確認 2026-11-01）

> One node, many lenses. The question this section answers: when a user (or the
> agent) wants to *see the same content differently* — as prose, as a board, as
> a graph, as a table, as a timeline — does Onden flip a lens, or does it launch
> a different app? Today, mostly the latter.

## Onden today

Onden has **no unified lens system**. What looks like "switching views" is
actually two incompatible layers that do not share a selection or context model.

### Layer 1 — Top-level MODES (five co-equal topbar peers)

`useUiMode` holds a single flat enum:

```ts
export type AppMode = "notes" | "tags" | "tasks" | "website" | "timeline";
```

`BuilderApp` renders these as a hard ternary cascade
(`BuilderApp.tsx` ~L551–849): `mode === "notes" ? … : mode === "tags" ? … :
mode === "tasks" ? …`. Each branch mounts a **different lazy-loaded root
component** — `KnowledgeWorkspace`/`OverviewEditor`, `TagsMode`, `TasksMode`,
`WebsiteStudio`, `TimelineView` — into the same grid slot. These are not lenses
on shared content; they are **separate apps wearing a shared topbar**. Three
symptoms make the split concrete:

- **The inspector only exists in Notes.** `InspectorPanel` is gated
  `mode === "notes"` (`BuilderApp.tsx` ~L851–853); Tags/Tasks/Timeline render no
  inspector at all.
- **Selecting an item ejects you.** Every non-notes branch wires
  `onSelectNode={(id) => { setSelectedId(id); setMode("notes"); }}`
  (`BuilderApp.tsx` ~L783, 799, 845). Clicking a node in Tasks/Tags/Timeline does
  not reveal it in place — it throws you back into Notes mode to see the content.
- **No shared context survives the switch.** Because each mode is a distinct
  component tree, there is nothing to preserve across the jump.

### Layer 2 — Notes' internal sub-views (the one *real* lens surface)

Inside `notes` mode there is a genuine multi-lens-on-one-model surface:

- a `notesView: "editor" | "canvas"` toggle (a two-button bar, `BuilderApp.tsx`
  ~L606–610);
- within canvas, a tab strip that flips between **"All Cards"** (a force-directed
  global graph via `AllCardsGraph` + `react-force-graph`) and per-canvas freeform
  **boards** (`react-flow` via `KnowledgeWorkspace`);
- the editor's own edit/preview toggle inside `OverviewEditor`.

So the true lens set today is **editor · canvas-board · graph**, and here Onden
already does the right things: selection (`selectedId` via `useNodeSelection`) is
**shared** across all three, with explicit camera-sync — `KnowledgeWorkspace`
calls `rfInstance.setCenter(...)` on selection change (~L197–208) and
`AllCardsGraph` centers the force graph on the selected node (~L151–169).
`useGraphLayout` derives react-flow nodes/edges from the same
`data.nodes`/`data.edges` and returns `[]` in editor view, so the three views are
**projections of one model**, not copies.

### Table / Timeline barely exist as lenses

- There is **no table lens** on arbitrary node content. `CollectionViews.tsx`
  (grid/detail) is a *publishing* renderer for `collection_schemas` inside
  Website Studio — not an in-workspace lens you can flip a note into.
- **"Timeline"** is a top-level mode showing version-history + events + trash
  (`TimelineView.tsx`), not a temporal lens on the selected node.

### Persistence / backend

- **Mode and `notesView` are ephemeral React state** — lost on reload. There is
  no URL routing for lens or selection; the only routing channels are
  `window.location.hash` (pinned-tag handoff, ~L548) and a custom
  `onden-open-tags-mode` window event (~L131–135). A lens is therefore **not
  addressable or shareable**.
- What *is* persisted is **per-lens geometry**: canvas card positions in
  `canvases.data` jsonb (mirrored into `node_positions` via
  `syncCanvasPositions`); global-graph manual positions as `node_positions`
  `surface='graph'`, flattened into `/api/bootstrap` as `graph_positions`.
  Canvas membership is reverse-derived from `canvases.data->nodes`.
- All position/membership mutations route through the **event-sourced spine**
  (`mutate()`), so they are actor-attributed and auditable.
- Pinned class-tag "views" (`usePinnedTagViews`) persist only in `localStorage`
  and surface as topbar chips that **deep-link into Tags mode** — i.e. they are
  navigation shortcuts, not durable lenses.

**IA weakness in one sentence:** the surface that proves Onden *can* do
lenses-on-one-model (editor/canvas/graph) is buried two levels down inside one of
five peer modes, while the topbar promotes the *anti-pattern* — five separate
apps that eject you to Notes the moment you actually want to look at something.

## How the field does it

| App | Approach (verified) | What's good |
| --- | --- | --- |
| **AFFiNE** (page ⇄ edgeless) | The *same doc* is two lenses, not two docs. The doc record persists a default lens (`primaryMode$` on `record.ts`); each open editor session holds its own `mode$` (`editor.ts` L35) flipped by `toggleMode()`/`setMode()`. The doc id never changes. Per-lens context is kept: `scrollPosition.page` and `scrollPosition.edgeless` are stored separately and restored on switch (L286+); selection is re-applied via a `HighlightSelection` (L262), but only if the target block exists in that mode. Lens is param-addressable (`params.mode`, L162). | Lens = a property of the doc, not a destination. Switching keeps you on the same block/scroll position. Deep links carry the lens. |
| **Anytype** (sets/collections dataview) | A dataview *block* owns N views (`BlockContentDataviewView`) over **one** object set. Each view stores its own `Type` (enum `Table=0, List=1, Gallery=2, Kanban=3, Calendar=4, Graph=5`), Sorts, Filters, Relations (visible columns), `GroupRelationKey`, `CoverRelationKey`. Switching = `SetActiveView(blockId, viewId)`: validates, sets active in-state **and persists** via `objectStore.SetActiveView`, emits `ChangeTypeActiveViewSet`, re-runs subscriptions. `CreateView`/`UpdateView`/`SetViewPosition` are first-class RPCs. UI is a horizontal `@dnd-kit` sortable tab strip (`controls.tsx` `onViewSwitch` L128). | Views are **durable data**, not ephemeral UI toggles. Per-view config is preserved server-side. One source, many perspectives, with graph as a *peer* view rather than a separate mode. |
| **Notion** (database views) | One database, N named view tabs (table/board/calendar/timeline/gallery/list). Each view stores its own filters/sorts/grouping/visible props; switching is a tab click, same rows. Opening a row opens a **page peek / full editor in place** rather than ejecting to a different surface. *(Web docs; not independently verified from source.)* | Edits propagate to all views instantly. The row-peek pattern is the direct antidote to Onden's "eject to Notes." |
| **Tana** (supertags + live search nodes) | A node tagged with a supertag gets a live search page ("all nodes with #tag"); that result renders as outline/table/cards/list/calendar, switched per search node, in place. The same node can appear in many searches without copying — the lens is attached to a **query**, the node is the home. *(Web docs; not independently verified from source.)* | Strongest match to "tag = node = home"; lenses are perspectives on a result set, not apps. |
| **AppFlowy** (database views — source-verified) | One `database_id` owns N named views; each `view_id` stores its own `DatabaseLayoutPB` (`Grid = 0`, `Board = 1`, `Calendar = 2` — `flowy-database2/src/entities/setting_entities.rs` L44–49) plus its own filters/sorts/groups. Switching a view's layout is `v_update_layout_type` (`services/database_view/view_editor.rs` L1197) which persists the new layout, re-resolves layout deps (`DatabaseLayoutDepsResolver`), and rebuilds the group controller — the row data (the database) is untouched. Each view is a separate `view_editor` over the shared database (`database_editor.rs` `get_or_init_view_editor`). | Lens layout is **durable per-view state in the kernel**, not a UI toggle. The same rows render as grid/board/calendar; switching layout mutates only the view, never the data. Strong "one source, many lenses" precedent in a Rust core. |
| **SiYuan** (attribute-view layouts — source-verified) | One `AttributeView` holds `Views []*View` with a current `ViewID` (`kernel/av/av.go` L44–45); each `View` carries its own `LayoutType` (`"table"`/`"gallery"`/`"kanban"` — av.go L314–320) **and its own Filters, Sorts, Group, PageSize** (av.go L209–227), with a dedicated `*LayoutTable`/`*LayoutGallery`/`*LayoutKanban` config struct per layout. Switching layout is `ChangeAttrViewLayout(blockID, avID, newLayout)` (`kernel/model/attribute_view.go` L979) — a transaction op (`doChangeAttrViewLayout`) that flips `view.LayoutType` and lazily initializes the target layout struct, preserving the others. | Same database block, multiple persisted views, each a distinct layout+filter+sort lens. Layout switch is an undoable kernel transaction, not ephemeral state — closest structural match to a spine-attributed lens. |
| **Trilium** (collection viewType label — source-verified) | A "collection" note renders its child/search noteIds through a `viewType` chosen from `allViewTypes = ["list","grid","calendar","table","geoMap","board","presentation"]` (`apps/client/src/widgets/collections/interface.ts` L4). The active lens is read from a **note label** — `useNoteLabel(note, "viewType")` (`collections/NoteList.tsx` L143) — so the lens is a *durable attribute of the note itself*, validated against `allViewTypes` (L147). The same `noteIds` set is fed to whichever `ViewComponents[viewType]` is selected (L123–126); per-view config persists via `view_mode_storage.ts` as a `${viewType}.json` attachment. | The lens is literally a **note attribute** (`#viewType=board`), making it data-driven, inheritable, and queryable — directly analogous to Onden's "tag = node carrying view config." The note stays the home; the lens is one of its attributes. |
| **Logseq** (DB-version view blocks — source-verified) | A view is a first-class block entity linked to its parent via `:logseq.property/view-for`; `get-views` fetches all views for a parent filtered by `view/feature-type` (`src/main/frontend/components/views.cljs` ~L2348). The active lens is the `:logseq.property.view/type` property — `.list` / `.gallery` / `.table` — dispatched in a `case` (views.cljs L2337–2344, default `table-view`), and changed by writing that property through `db-property-handler/set-block-property!` (durable DataScript transaction, views.cljs L222–225). | Even the outliner-first PKM, in its DB rebuild, models a lens as a **transacted property on a view-block over a query**, not a mode swap — reinforcing that durable, data-backed lenses are the convergent design. |
| **Capacities** (object/data views) | Separates *object views* (how one object looks inline) from *data views* (how a group renders — gallery/wall/table — for a type/query/collection/tag). Same object keeps identity across surfaces; backlinks are contextual. *(Web docs; not independently verified from source.)* | Clean two-level model: identity-preserving inline view vs. group lens. |
| **Obsidian Bases** | A `.base` file defines a filtered dataset with multiple view layouts (table/list/cards/map), layered filters (all-views + per-view). A base can be **embedded inside any note** via `![[File.base]]`; with `[this.file]` the embedded view re-binds to its host note. *(Web docs; not independently verified from source.)* | The lens travels with context and renders inline — the note stays the home while a database lens lives inside it. |
| **Reor / Khoj** (counter-examples — source-verified) | Reor is a single BlockNote (TipTap-family) editor with sidebars (`EditorManager.tsx`, `Sidebars/`); its graph/similar-notes is a **sidebar panel**, not a lens you flip the note into. Khoj is chat-first (`app/chat/page.tsx`, `chatSidebar/`) with no canvas/table/graph lens over a note. | Confirms multi-lens-on-one-content is a feature of **database-/edgeless-centric** tools, not file-editor or chat-first PKM. Validates the thesis rather than the topbar. |
| **Joplin / Blinko** (editor-only "views" — source-verified counter-examples) | Joplin's only "view" axis is editor/preview panes: `visiblePanes: ['editor','viewer']` (`app-desktop/gui/NoteEditor/NoteEditor.tsx` L454) — markdown source vs. rendered HTML, no board/table/graph lens on a note. Blinko's `ViewModeButton` toggles `viewMode: "wysiwyg" | "sv" | "ir" | "raw"` (`app/src/components/Common/Editor/Toolbar/ViewModeButton/index.tsx` L8) — purely Vditor editor render modes, not perspectives on a content set. | The "view toggle" in file/markdown-centric PKM is **render mode of one editor**, never a structural lens over a node's relationships. Marks the boundary: lens-on-content needs a database/graph substrate, which Onden's node model has. |

## The gap

1. **Lenses are modeled as peer apps, not as projections of a node.** AFFiNE and
   Anytype attach the lens to the *content* (a doc property; a stored view over
   one set). Onden attaches it to a global `mode` enum that swaps the entire
   component tree.
2. **The switch destroys context.** The field preserves scroll/selection/block
   across a lens flip (AFFiNE's per-mode `scrollPosition` + `HighlightSelection`).
   Onden does the opposite: selecting *forces* a mode change and discards
   wherever you were.
3. **Lenses are ephemeral and unaddressable.** Everyone else treats a view as
   durable data and URL-addressable: Anytype RPCs; AFFiNE's persisted
   `primaryMode`; **AppFlowy's per-view `DatabaseLayoutPB` persisted via
   `v_update_layout_type`**; **SiYuan's `View.LayoutType` flipped by the
   transaction op `ChangeAttrViewLayout`**; **Trilium's lens stored as a
   `#viewType` note label**; **Logseq's `:logseq.property.view/type` written
   through `set-block-property!`**. Four independently-verified PKM kernels all
   model the lens as transacted, per-view state. Onden's `mode`/`notesView` are
   React state with no routing — the lone outlier.
4. **Table and timeline are missing as lenses.** They exist only as a publishing
   renderer and a global history mode respectively — never as a lens you flip the
   selected node into.
5. **Onden already proved it can do this** (editor/canvas/graph share selection +
   camera-sync) — but only inside one mode, two levels deep. The capability
   exists; the IA hides it.

## Recommendation for Onden

**Collapse the five top-level modes into one node surface with a lens strip, and
make the lens a property of the open node rather than a global app selector.**
This is a direct expression of the thesis: *a node is the home; canvas / graph /
table / inbox / timeline are lenses on a node's maturity.*

### 1. One node surface, lenses as a tab strip (kill co-equal mode-switching)

Replace the `mode` ternary cascade with a single workspace that always renders
the selected node and exposes a **lens strip** — `editor · board · graph ·
table · timeline · inbox`. This is Anytype's `SetActiveView` pattern and AFFiNE's
`toggleMode`: switching a lens **never changes which node is open** and **never
unmounts the inspector**. Notes/Tags/Tasks/Website/Timeline stop being peers.

- Notes' existing editor/canvas/graph triad becomes the seed of the strip — it
  already shares `selectedId` and camera-sync, so promote it, don't rebuild it.
- **Tasks** is not a mode; it is the **table/inbox lens filtered to task-typed
  nodes**. **Timeline-the-mode** becomes the **timeline lens** on the current
  node's event history (the data already flows through the spine, actor-attributed).

### 2. Never eject — reveal in place

Delete every `onSelectNode={(id) => { setSelectedId(id); setMode("notes"); }}`.
Selecting a node anywhere updates the **shared selection** and the surface shows
it under the current (or node-default) lens — Notion's row-peek behavior. The
inspector should be lens-agnostic, not gated to `mode === "notes"`.

### 3. Persist the lens as node data, make it addressable

- Give each node a **default lens** (AFFiNE's persisted `primaryMode`) plus a
  per-session active lens. Persist both through the **spine** so the choice is an
  actor-attributed event, consistent with how positions already mutate.
- Add **URL routing** for `node + lens (+ selection)` so a lens is shareable and
  survives reload — replacing today's hash/window-event hacks. This also gives the
  **agent** a stable address to open "this node in the table lens," which the
  audit log can attribute.
- Preserve per-lens context (scroll/camera/selection) across switches, mirroring
  AFFiNE's separate `scrollPosition.page`/`.edgeless`. Onden already persists
  per-lens *geometry* (canvas `node_positions`, graph `graph_positions`); extend
  that to per-lens *viewport/selection*.

### 4. Tag = node = lens definition (collapse Tags mode)

A `class_tag` is a `content_node` carrying schema/policy, so a saved lens is just
**a node that defines a query + a view config** — Anytype's stored view object and
Tana's live-search-node, expressed in Onden's own model. "Editing a class" becomes
*opening that tag node and switching to its schema/policy lens*, not entering a
separate Tags app. The pinned-tag chips (`usePinnedTagViews`) graduate from
`localStorage` deep-links into **first-class saved-lens nodes** persisted on the
spine. This is the working hypothesis made concrete: tags collapse into the node
space.

### 5. Website is a publish gesture, not a peer mode

`CollectionViews` already renders collection schemas as grid/detail — that is a
**publish-time table lens**, not a workspace mode. Demote Website from a top-level
peer to a **destination/gesture** ("publish this node / this lens"), reusing the
same lens components. One mental model: you author in lenses, and *publish* points
a lens at the public surface.

### Net effect on the maturity-loop

Capture lands a node in the **inbox lens**; diverging happens in the **board/graph
lenses**; converging happens in the **editor/table lenses**; **timeline** shows how
it matured — all on one node, all addressable, all spine-attributed. The loop
becomes visible *because* the lenses share a home, instead of being scattered across
five apps that throw you back to Notes whenever you try to look at something.
