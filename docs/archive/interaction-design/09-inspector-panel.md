# Inspector / properties / backlinks panel

> 狀態：歷史紀錄（最後確認 2026-11-01）

## Onden today

Onden ships **two parallel right-hand context panels**, and in the default flow
only one of them is ever visible. The result is a dense, capable inspector
sitting beside a fully-built dead twin.

**The live panel — `OverviewActivityPane`**
(`packages/frontend/src/components/OverviewActivityPane.tsx`). Rendered as grid
column 3 of the overview workspace, gated on `showOverview = mode === "notes"`.
It is the real inspector and it is genuinely rich. Top to bottom:

1. **Properties** — a quick-glance list of inline markdown attributes parsed
   client-side via the regex `/(^|\s)#([\p{L}\p{N}_-]+)=([\p{L}\p{N}_.-]*)/`
   from `node.markdown`, then the full schema-driven `NodeAttributesPanel`, then
   a cycle-guarded **Parent** `<select>` and an **Updated** date.
2. **Backlinks** — derived client-side from `data.edges` where
   `target_node_id === node.id`, rendered as flat clickable titles.
   Since D74 only active plain links count (`knowledge_link`, from a `[[link]]`
   or an arrow drawn by hand; `lib/edgeRoles.ts countsAsBacklink`): typed
   relations and machine suggestions are not backlinks.
3. **Appears on canvases** — from many-to-many `canvas_memberships`; clicking
   opens the canvas (the inverse of "what's on this canvas?").
4. **Outgoing Links** — edges where `source_node_id === node.id`, also flat
   titles.
5. **Local Graph** — a hand-rolled SVG radial mini-graph of
   `miniGraphNeighbors`.
6. **Recent Events** — lazy `NodeEventHistory`, polling
   `/api/events?target_type=node&target_id=…` every 7s, with per-event actor
   badges, color-coded dots, expand-to-JSON, and inline Restore /
   cascade-restore (`RestorePreviewModal`).
7. **Version History** — from `nodeVersions`
   (`content_node_versions`), expand to view markdown + Restore-this-version.

`NodeAttributesPanel` (`NodeAttributesPanel.tsx`) on mount fires **three**
parallel fetches — `/api/nodes/:id/attributes`, `/inherited-attributes`,
`/rollup-attributes` — and renders one section per applied **class tag** (fields
ordered by the tag's `schema_fields`, typed inputs via `SchemaRow`), a **Custom**
section for leftover keys, a read-only **Computed** section (rollups), and a
read-only **Inherited** section with per-ancestor source attribution. Writes go
`PUT`/`DELETE /api/nodes/:id/attributes/:key` through the event-sourced spine
(`ATTRIBUTE_SET`/`DELETED` events + `node_attributes` row + tag-hook dispatch +
LWW conflict detection emitting `ATTRIBUTE_CONFLICT`), optionally via
offline-aware `onAttrUpsert`/`onAttrRemove`.

**The dead twin — `InspectorPanel`** (`InspectorPanel.tsx`). It is always passed
`selectedNode={mode === "notes" ? selectedNode : null}` and
`showOverview={mode === "notes"}`, and it applies the `collapsed` class whenever
`(!selectedNode || showOverview)` — and `global.css` sets
`.inspector-panel.collapsed { display: none }`. In notes mode `showOverview` is
always true; in every other mode `selectedNode` is null. **So this panel never
renders in the default flow.** It is a fully-built `InspectorWidget` accordion
stack (Note, Attributes, Tasks, "Mentioned in" via an `OndenBaseBlock` running
`file.hasLink(this)`, "Recent activity" via `OndenBaseBlock` with a **hardcoded
date `2026-05-23`**, Connections — which *duplicates* the live pane's backlink
logic — AI Suggestions, and History fetching `/api/nodes/:id/history`).

**IA weaknesses (verified in source):**

- **Two inspectors, one alive.** Maintenance and conceptual cost of a parallel
  dead panel; backlink logic is implemented twice. The hardcoded `2026-05-23`
  is a smoking gun that the dead twin is unmaintained.
- **Inspector is bolted to one mode.** The whole pane only exists when
  `mode === "notes"`. Switch to canvas / tags / tasks / timeline and the node's
  context evaporates — yet a node is the same node in every lens.
- **Backlinks are bare titles.** Flat clickable strings with no context snippet,
  no grouping by source, and no linked/unlinked split. You cannot tell *why* a
  note links here without navigating away.
- **Properties are split across two representations.** Inline `#key=value`
  markdown attributes and schema-driven `node_attributes` are shown as two
  stacked lists with no reconciliation, so the same logical field can appear
  twice or diverge.
- **Class-tag schema lives only in the inspector's property editor**, never as a
  pinned, always-visible header on the node itself.

## How the field does it

| App | Approach | What's good |
| --- | --- | --- |
| **AFFiNE** | Doc-info modal with **typed** workspace properties (text/number/date/checkbox/select/progress/link), inline-edited per type, add-property menu, "show N more" collapse, permission-guarded writes (`guardService.can$('Doc_Update')`). Bi-directional link panel groups backlinks **by source doc** (each group collapsible, open/closed persisted in `GlobalSessionState`) and renders a **live markdown preview** of the referencing block (`LitTextRenderer` over `markdownPreview`), deep-linking to the exact `blockId`. When the doc is a row in a database elsewhere, the panel surfaces that row's **other cells, inline-editable**. *(All verified in vendored source.)* | Backlinks-as-context, not bare links; deep-link to block; typed + permission-gated props; database membership shown as editable cells. |
| **Anytype** | Relations are **first-class node fields** rendered as inline-editable typed cells (`Relation.className(format)`); writes go through `ObjectListSetDetails`; adding opens a `relationSuggest` menu → `ObjectRelationAdd`. Read-only/restricted relations gated by `checkFlags(RestrictionObject.Details)` → `canEdit`. **Featured relations** pin the object type + key relations as an inline header strip at the top of the object, editable in place. *(Verified in vendored source.)* | Properties live *on* the object; pinned "featured" strip makes type + key fields always visible; restriction-aware editability. |
| **Reor** | **No** properties/backlinks inspector — the right pane is a **semantic sidebar** (`SimilarEntriesComponent`) running a vector-DB query (`DBQueryResult`) listing embedding-nearest notes as preview cards, with a manual Refresh that re-saves then re-queries. *(Verified in vendored source.)* | Related-by-meaning replaces related-by-link; zero manual linking required. |
| **Logseq** | Page bottom carries **two** reference sections, both built on the generic view system (`components/reference.cljs`): **Linked References** (`:view-feature-type :linked-references`, collapsible, with a per-source-page **include/exclude filter** popup — `reference_filters.cljs`, shift-click to exclude, frequency-sorted ref counts) and **Unlinked References** (`:unlinked-references`, gated on a worker `block-refs-check {:unlinked? true}`, with `:highlight-query` set to the page title so the occurrence is highlighted in the referencing block). Both render the **full referencing block**, not a bare title. *(Source-verified: `logseq-master/src/main/frontend/components/reference.cljs`, `reference_filters.cljs`.)* | The canonical linked/unlinked split with per-source filtering, rendered as live block content — exactly the pattern Onden lacks. |
| **SiYuan** | A dedicated **Backlink dock** (`app/src/layout/dock/Backlink.ts`) with **two stacked panels**: **Backlinks** (linked) and **Mentions** (unlinked), each with its own keyword **filter**, **sort**, **expand/collapse** controls and a live count. Each entry renders the **actual referencing block DOM** (kernel `model/backlink.go` `GetBackmentionDoc` returns `Backlink{DOM, BlockPaths}` with keyword `highlight` and a 12-char `beforeLen` context window). Ref counts are maintained server-side (`refreshRefCount`). *(Source-verified: `siyuan-master/kernel/model/backlink.go`, `app/src/layout/dock/Backlink.ts`.)* | Linked + unlinked ("Mentions") as first-class docked panels; backlinks are rendered block content with breadcrumb path and highlight, not titles. |
| **Trilium** | **Promoted attributes** (`widgets/PromotedAttributes.tsx`) render an attribute's value as a **typed inline cell pinned at the top of the note** (placed in `desktop_layout.tsx` above the content), driven by a definition string parsed in `promoted_attribute_definition_parser.ts`: type ∈ `text/textarea/number/boolean/date/datetime/time/url/color`, `single`/`multi` multiplicity, `precision`, `alias`, and `inverse=` for **bidirectional relations**. Backlinks (`FloatingButtonsDefinitions.tsx` `BacklinksList`, server `note-map/:id/backlinks`) **split by kind**: relation-backlinks show the `relationName`; content-backlinks render rendered-HTML **excerpts** of the referencing text. A separate **Inherited Attributes** tab shows attributes inherited from parents/templates, kept grouped by source. *(Source-verified: `Trilium-main/apps/client/src/widgets/PromotedAttributes.tsx`, `services/promoted_attribute_definition_parser.ts`, `widgets/FloatingButtonsDefinitions.tsx`, `widgets/ribbon/InheritedAttributesTab.tsx`.)* | Pinned typed-field header *on the note* (Onden's missing "featured fields"); backlinks carrying excerpt context and distinguishing relation vs mention; inherited-attribute attribution mirroring Onden's own `/inherited-attributes`. |
| **AppFlowy** | No wiki-backlink inspector — properties are a **database-row** concept. Opening a row shows a `RowDetailPage` with a `RowPropertyList` of **typed field cells** (`plugins/database/widgets/row/row_detail.dart`); a **relation** field's referenced row **peek-opens in the same detail view** without navigating (`relation_row_detail.dart` → `RelatedRowDetailPageBloc` → `RowDetailPage`). *(Source-verified: `AppFlowy-main/frontend/appflowy_flutter/lib/plugins/database/widgets/row/row_detail.dart`, `relation_row_detail.dart`.)* | Relation target peek-opens as the same editable property view — properties-on-the-object, but scoped to database rows, not free notes. |
| **Blinko** | No inspector panel and **no typed properties** (notes are content + tags only), but references are **bidirectional**: `references` and `referencedBy` (`app/src/components/BlinkoCard/referencesContent.tsx`) each render as a card showing the linked note's **content excerpt** (`line-clamp-3`), click peek-opens the note in a standalone dialog. *(Source-verified: `blinko-main/app/src/components/BlinkoCard/referencesContent.tsx`.)* | Even a minimalist quick-capture app shows backlinks as content excerpts with peek-open — the bare-title list is below the floor here. |
| **Tana** | Fields belong to supertags; a supertag config opens as a **right-side panel** (not a modal). **Pinned fields** display inline on the node; a node with multiple supertags shows the **union** of their pinned fields; fields support default values applied on tag attach. *(Web-sourced; see uncertain claims.)* | Schema = supertag; config-opens-as-panel mirrors "tag = node"; union-of-pinned-fields handles multi-class nodes. |
| **Capacities** | Static right sidebar; any object can be **peek-opened in the sidepanel** to read its full content without navigating. Backlinks browsable and **filterable by object type**. "Related Content" surfaces **unlinked mentions** (wrote-about-but-never-linked). Properties available are determined by the object's type. *(Web-sourced; see uncertain claims.)* | Peek-without-leaving; type-filtered backlinks; unlinked-mention discovery; type-driven property set. |
| **Obsidian** | Right-pane Backlinks plugin with two collapsible sections — **Linked mentions** and **Unlinked mentions** — each result showing a **context snippet** with "show more context", plus collapse-all, sort, and inline filter. Outgoing Links is a parallel pane. Typed front-matter properties edited in a structured view. *(Web-sourced; widely corroborated.)* | The canonical linked/unlinked + context-snippet pattern. |
| **Notion** | Typed page properties at the top of every page, including **relation**, **rollup** (pull across a relation), and **formula** (computed). Relations bidirectional; related page **peek-openable** from the chip. Customize-layout lets you **pin / hide / reorder / hide-when-empty**. *(Web-sourced; widely corroborated.)* | Rollup + formula + inherited-style computed props; layout control over which props show. |
| **Fibery** | Entity view with configurable layout where fields and **relation views** render inline as embedded mini-collections (add/filter in place); references **auto-collected** from rich-text mentions (bi-directional). *(Web-sourced; see uncertain claims.)* | Relations rendered as inline embedded collections, not just chips. |

## The gap

Three patterns are table stakes everywhere except Onden, and one is a missing
fit with Onden's own thesis.

1. **Backlinks carry context.** AFFiNE renders a live markdown preview of the
   referencing block; SiYuan returns the referencing block's DOM with a context
   window + highlight; Logseq renders the full referencing block; Trilium shows
   rendered-HTML excerpts; even Blinko shows a content excerpt card. **Onden
   shows a bare clickable title** and nothing else — you must navigate away to
   learn *why* a link exists. This is source-verified as below the floor of
   every vendored PKM that has backlinks at all.
2. **Linked vs unlinked mentions.** This is now confirmed in *source* on the
   strongest competitors: Logseq (`:linked-references` + `:unlinked-references`)
   and SiYuan (docked "Backlinks" + "Mentions" panels) both ship the split
   first-class; Obsidian and Capacities corroborate via docs. Onden has **only**
   explicit edges (`node_edges`, origin `wikilink`/embedding/manual) — there is
   no surface for "you wrote this node's name here but never linked it."
3. **Properties live on the node, pinned.** Source-verified now: Anytype's
   featured relations *and* Trilium's **promoted attributes** (typed cells pinned
   above the note content) put the type + key fields as an always-visible header
   strip *on the object*; Tana's pinned fields corroborate via docs. Onden's
   schema-driven properties are buried in a side-panel section that **only exists
   in notes mode**.
4. **The inspector is mode-bound, but a node is not.** The pane is gated on
   `mode === "notes"`. This directly fights Onden's thesis that a node is the
   home and canvas/graph/table/inbox/timeline are *lenses* on it. The same node's
   properties, backlinks, and history should be reachable from every lens.

## Recommendation for Onden

Treat the inspector as a **lens-stable companion to the node**, not a notes-mode
feature, and collapse the two panels into one.

**1. Kill the dead twin.** Delete `InspectorPanel` and its duplicated backlink
logic (and the hardcoded `2026-05-23`). One inspector — `OverviewActivityPane`,
renamed to its actual role (e.g. `NodeInspector`). This removes the
two-implementations-of-backlinks hazard immediately.

**2. Make the inspector follow the node across every lens, not the mode.** The
node is the home; canvas / graph / table / inbox / timeline are lenses on its
maturity. The inspector should render against the **currently focused node**
regardless of lens, gated on "a node is focused" rather than `mode === "notes"`.
On canvas, focusing a card opens the same inspector; on timeline, selecting an
event's node does too. This is the single highest-leverage change because it
turns the inspector from a notes feature into the node's persistent context — and
it is a precondition for retiring co-equal mode-switching, since context no
longer dies when you change lens.

**3. Backlinks must carry context and split linked/unlinked.** Replace the flat
title list with grouped-by-source-node sections (AFFiNE/Obsidian pattern), each
showing a **markdown snippet of the referencing block**. Onden already stores
markdown per node and resyncs `node_edges` from wikilinks on save, so the
snippet is cheap to derive. Add an **Unlinked mentions** section: scan node
markdown for occurrences of this node's title that have no corresponding edge —
this is the natural home for the existing embedding-suggested edges
(`services/embeddings.ts`), surfaced as "AI noticed you mentioned this" rather
than silently injected.

**4. Pin the class-tag schema as a node header, because a tag is a node.** A
`class_tag` is a `content_node` carrying schema/policy — so the "featured
fields" strip is not a special-case property header, it *is* the class node's
schema rendered inline on its instances. Adopt the Anytype/Tana pattern: pin the
applied class tag(s) + their key schema fields as an editable header strip at the
top of the node, showing the **union** across multiple applied class tags (Tana's
multi-supertag behaviour). Trilium's source confirms this is buildable as
*typed* pinned cells (its promoted-attribute definition grammar:
`text/number/boolean/date/url/color`, `single`/`multi`, `inverse=` for
bidirectional relations) — a concrete target for the typed header strip. Editing
a field there is editing `node_attributes`
through the spine, exactly as the panel does today. Crucially, this means
"editing the class" (opening the tag node + its schema/policy lens) and "editing
an instance's fields" become the same gesture on the same node-shaped object.

**5. Reconcile the two property representations.** Inline `#key=value` markdown
attributes and schema-driven `node_attributes` should render as **one** property
list. Parse the inline ones, and where a key matches a class-tag schema field,
show a single reconciled row (markdown as source-of-truth per the editor
decision) rather than two divergent lists.

**6. Keep the audit surface — it is a differentiator, not bloat.** A single
human + one autonomous agent co-inhabit the space; every mutation is
actor-attributed. The Recent Events feed with per-actor badges and inline
Restore is something no competitor offers — verified across the vendored set:
Reor/AFFiNE/Anytype have nothing comparable, and the PKM heavyweights confirm
the gap (Logseq/SiYuan/AppFlowy/Blinko ship no actor-attributed mutation feed in
their inspector at all; Trilium has note **revisions** but no per-actor,
inline-restore activity stream against a node). Keep it, and make it lens-stable along with the
rest of the panel so "what did the agent just change on this node?" is always one
focus away — this is the governance precondition that makes unconstrained
AI-collaboration safe.

**7. Maturity-aware density.** Because the inspector now lives across lenses,
let it reflect the node's maturity: a freshly-captured inbox node shows capture
affordances (quick props, suggested links), a converged note shows the full
schema header + backlink context + version history. Same panel, density tuned to
where the node sits in the capture → diverge → converge loop.
