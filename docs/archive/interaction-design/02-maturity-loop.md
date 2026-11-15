# Idea-maturity loop (capture -> diverge -> converge)

> 狀態：歷史紀錄（最後確認 2026-11-01）

> An idea should have one home and many lenses. In Onden today it has three homes
> and one boolean. This section maps how the loop actually behaves in the
> full stack, surveys how the field models the same loop, names the gap, and
> recommends a single-substrate maturity loop that fits the node=home thesis.

## Onden today

All three loop stages exist as working mechanisms, but they are **not wired as one
pipeline**. They live in three disconnected places joined only by the single
boolean `content_nodes.hidden` and by ad-hoc imperative navigation jumps. There is
no maturity enum, no state machine, and no loop-back affordance from converged
notes back to the board.

**Capture.** Two surfaces, with divergent behaviour:

- `QuickCapture.tsx` (mobile-first FAB / `⌘⇧N` sheet, opened via the global
  `onden-open-quick-capture` event in `BuilderApp`) does **not** create a fresh
  idea node. It find-or-creates *today's daily note* by ISO-date title and appends
  a timestamped block (`\n\n## HH:MM\n{text}\n`) via raw fetches (POST `/api/nodes`,
  then GET + PATCH `/api/nodes/:id`). On save it runs `onAfterCapture`, which does
  `refresh(); setSelectedId(nodeId); setMode("notes")` — so capture always lands you
  in the daily note **in editor mode, never on a board**.
- RSS import (`backend routes/rss.ts`) inserts `content_nodes` with `hidden = true`
  and `source_type='rss'` plus an `ai_suggestion` summary. These hidden rows are
  the only genuine "inbox pile."
- Other quick-creates in `useNodeCreation.ts` (note / pdf / image / bookmark /
  sketch) create **visible** nodes directly (`hidden = false`), bypassing the inbox
  entirely.

So three creation paths route to three different maturity states with no shared
contract.

**Maturity state.** Modeled as exactly one bit: `hidden`. `useOverviewMode.ts`
derives the lists by filtering on it plus the absence of a class tag:

- `inboxNodes  = nodes.filter(n =>  n.hidden && (class_tag_ids.length ?? 0) === 0)`
- `overviewNodes = nodes.filter(n => !n.hidden && (class_tag_ids.length ?? 0) === 0)`

The sidebar (`OverviewSidebar.tsx`) shows an **Inbox** tab (badge = hidden count +
recent LWW conflicts); each row has one button, **"↑ Promote to graph."** Promote =
POST `/api/nodes/:id/promote` (`backend nodes.ts:390`), which flips `hidden = false`
and emits a `NODE_PROMOTED` event. **That single boolean flip is the entire
capture -> graph "converge" gesture** — no spatial step in between.

**Diverge (spatial).** Two unrelated canvas systems that do not share a model:

- *Integrated* graph-canvas inside Notes mode: `BuilderApp` toggles `notesView`
  between `"editor"` and `"canvas"`; `"canvas"` renders `KnowledgeWorkspace`
  (ReactFlow over the real node graph). Cards here **are** content nodes; positions
  persist to `canvases.data.nodes[]` jsonb (dual-written to `node_positions`), or to
  `node_positions` on the `graph` surface when no canvas is active.
  `useCanvasActions.ts` owns add / drag / resize / section / sub-canvas /
  auto-arrange / tidy / `addToActiveCanvas`.
- *Standalone* `CanvasMode.tsx` (also ReactFlow), whose cards are loose nodes of
  type note/text/group with **no link** back to content nodes except an opaque
  `data.nodeId`; its own canvas list/CRUD and save loop.

Nodes reach a board only if you are already viewing a canvas (`addToActiveCanvas`
no-ops when `activeCanvas` is null) or you manually drag/search them in. Capture
never deposits anything onto a board.

**Converge (structured notes).** `OverviewEditor` (markdown, the `editor`
notesView) plus `extractToEntity` (`useAppData.ts`), which spins a highlighted
phrase into a new class-tagged node, and `promoteNode`. Crucially, **class-tagged
nodes are filtered out of both overview and inbox lists** — so "structuring" an
idea by giving it a class tag effectively *removes it from the loop view*. The act
of maturing an idea makes it disappear from the surfaces that show maturity.

**Top-level IA.** `useUiMode.ts` hard-codes five co-equal peer modes
(`notes / tags / tasks / website / timeline`) rendered as a tablist in
`AppTopbar.tsx`; canvas is demoted to a sub-toggle under notes (`notesView`). The
spatial board is buried two clicks deep and is not presented as a phase of an
idea's life. Cross-stage motion is scattered imperative jumps
(`setMode("notes"); setNotesView("canvas"); selectCanvas(id)`).

**IA weaknesses, summarized**

1. Maturity is one bit (`hidden`) doing the work of an entire pipeline.
2. Capture lands in a daily-note editor, skipping the diverge board entirely.
3. Two canvas systems, no shared model — diverge is fragmented.
4. Converge (typing a node) *evicts* the idea from the loop views.
5. The board is a sub-toggle, not a recognized life-stage of a node.
6. No state machine, no stage signal, no loop-back from notes to board.

## How the field does it

Sourcing note: rows marked **[source-verified]** were confirmed by reading the
app's vendored source at the cited path. Rows marked **[web-sourced]** describe
apps not vendored in this repo and rest on docs/product behaviour, not code.

| App | Approach | What's good |
|---|---|---|
| **AFFiNE** **[source-verified: `AFFiNE/blocksuite/affine/model/src/consts/note.ts:38`, `.../note-model.ts:96-104`, `.../blocks/note/src/commands/change-note-display-mode.ts`]** | One doc is the home. `edgeless` (board) and `page` (doc) are two renderers of the *same* BlockSuite store. Per-note maturity is a **3-state** `NoteDisplayMode` enum — confirmed `DocAndEdgeless='both' / DocOnly='doc' / EdgelessOnly='edgeless'` (`note.ts:38-42`), not a bit. The "promote scratch into the doc" gesture `changeNoteDisplayMode` flips `EdgelessOnly -> Both` **and** `moveBlocks` the note to its correct reading position among page-visible siblings (`change-note-display-mode.ts:38-57`). | Diverge and converge are the *same object*, no copy/conversion. A real 3-state maturity axis. Promotion also *places* the content, not just reveals it. The model carries a `hidden` boolean explicitly annotated `@deprecated use displayMode instead` with the mapping `hidden:true -> EdgelessOnly`, `hidden:false -> DocAndEdgeless` (`note-model.ts:96-104`) — AFFiNE literally documented growing out of Onden's exact single-bit model. |
| **Anytype** **[source-verified: `anytype-heart/pkg/lib/pb/model/models.pb.go:1329-1334`]** | An idea matures by acquiring an **ObjectType** (its class, carrying recommended layout + relations + template) — structuring *is* typing. A single set/collection query renders through view types defined in the `BlockContentDataviewViewType` enum — confirmed `Table=0, List=1, Gallery=2, Kanban=3, Calendar=4, Graph=5` (models.pb.go:1329-1334) — as a per-view setting. | Onden's "lenses on a node, not co-equal app modes" thesis already shipped. Switching Kanban->Calendar->Graph changes the lens, not the data or a top-level mode. Tag-as-class is native. |
| **AppFlowy** **[source-verified: `AppFlowy-main/frontend/rust-lib/flowy-database2/src/entities/setting_entities.rs:44-49`; `.../flowy-folder/src/entities/view.rs:188-194`]** | Two layers. (a) Every node in the sidebar tree carries a `ViewLayout` (`Document=0, Grid=1, Board=2, Calendar=3, Chat=4`, `view.rs:188-194`) — the kind is chosen at create-time, and `view.rs:201` groups Grid/Board/Calendar as "the database layouts." (b) Within a database, the *display* is a separate `DatabaseLayoutPB` (`Grid=0, Board=1, Calendar=2`, `setting_entities.rs:44-49`) — one underlying database (rows = the data) can be re-rendered Grid/Board/Calendar by changing the view setting, not the data. | A two-tier lens model: a per-node type for documents, plus a true same-data-many-lenses layer for structured (database) content — the second tier is exactly Anytype's view-type-as-setting and exactly what Onden's thesis wants. Distinguishes "what kind of node is this" from "which lens am I rendering its rows through." |
| **SiYuan** **[source-verified: `siyuan-master/kernel/model/flashcard.go:857,1200`; `.../api/riff.go:337`]** | Converge-by-distillation. A flashcard ("Riff" card, FSRS spaced-repetition, `flashcard.go:32`) is **not a new object** — `doAddFlashcards` takes existing `blockIDs` and tags those blocks with the `custom-riff-decks` attribute (`flashcard.go:1200`). The block stays in place in its document; the card is a review lens over the same content. Capture itself is the daily note (notebook + `dailyNote` API). | Maturity-as-distillation: the *same* block can be raw note, page-embedded block, AND a due flashcard, with no copy. A converge step (review/recall) implemented as an attribute on the original object, not a separate record — directly the "one object, many lenses" principle, applied to the recall lens. |
| **Logseq** **[source-verified: `logseq-master/src/main/frontend/quick_capture.cljs`]** | Near-identical to Onden's capture: `quick-capture` resolves the target to *today's journal page* by default (`db/get-today-journal-title`, lines 24, 41-59) and inserts a templated block (`"**{time}** [[quick capture]]: {text} {url}"`, line 79) via `api-insert-new-block!`. Everything is an outliner block on a page; "maturity" is emergent from references/queries, with no explicit stage flag. | A direct, vendored confirmation that the "capture lands in the daily note" default (Onden's QuickCapture) is a real convention, not an Onden quirk — *and* a cautionary mirror: Logseq has the same no-explicit-maturity-axis limitation Onden does, so copying it would not fix Onden's gap. |
| **Trilium** **[source-verified: `Trilium-main/packages/trilium-core/src/becca/entities/bbranch.ts:30-37`; `.../bnote.ts:166,1408-1417`]** | Placement is decoupled from the note. A `Branch` entity is a `(noteId, parentNoteId, prefix)` edge (`bbranch.ts:30-37`); `BNote.cloneTo(parentNoteId)` (`bnote.ts:1408`) adds the *same* note under another parent. One note can therefore have many parent branches (`getParentBranches`, `bnote.ts:166`) — one object, many homes, no copy. | Inverts the "one home, many lenses" framing into "one object, many homes": the note is the single record and its tree positions are just edges. Useful for Onden's unify-the-canvases goal — a card on a board and the same node in an outline are the same record reached by two branches/edges, not two records bridged by an id. |
| **Heptabase** **[web-sourced — not vendored]** | Card is the atom; whiteboard is the diverge surface; converge is explicit and link-based — select related cards, copy their card-links, paste into a new "article card," reorder into prose. Cards are *referenced*, so one card lives on the board AND in the article. Recommended flow starts as one note card, then breaks down into smaller cards once structure emerges (converge precedes a second diverge). | Diverge and converge share one object via links. Explicitly frames the flow as a **loop, not a funnel** — matches Onden's thesis precisely. |
| **Tana** **[web-sourced — not vendored]** | Capture-time structuring: a captured node is processed by two questions — (1) what KIND is this? (apply a **supertag** = class/schema), (2) what does it connect to? (inline refs/fields). Inbox is optional staging; many users run a saved-query "search node" inbox instead of a literal pile. | Structuring = applying a tag, not switching mode. The item "routes itself" once typed. Reframes inbox as a query, not a pile of stuck state. |
| **Scrintal** **[web-sourced — not vendored]** | A card on the infinite canvas IS the note — expand a card to a full-screen doc, "turn blocks into docs with a click," no separate doc model or conversion. Bidirectional links draw visible lines on the board. | Maturity is a continuous zoom (card -> expanded doc), not a discrete promote. One substrate for board and note graph. |
| **Muse** **[web-sourced — not vendored]** | Designed for the "messy middle": diverge first, organize later. Every board can contain nested boards; an idea grows in place by spawning sub-boards. No forced converge step — structure emerges from spatial grouping/nesting. | Honors that not every idea must converge; maturity can be *arrangement/nesting depth*, not a flag. |
| **Obsidian Canvas** **[web-sourced — not vendored]** | Mirrors Onden's split: a loose text card (markdown, no backlinks/properties, lives only in `.canvas` JSON) vs an embedded file-card (a real note). Converge = right-click "Convert to file…" which promotes the ephemeral card into a first-class `.md` note that joins the graph/backlinks. | A clear, explicit promote gesture from ephemeral -> first-class. Useful as a *cautionary* model: one-card-at-a-time, no batch, and no built-in canvas->outline assembler. |

## The gap

The field has converged on one principle Onden has not yet adopted: **diverge and
converge are two lenses on one persistent object, and maturity is a richer-than-binary
property of that object.**

- AFFiNE and Scrintal make board and doc the *same store* — Onden has two canvas
  systems plus a separate editor, joined by an opaque `data.nodeId` and a boolean.
- AFFiNE replaced exactly Onden's `hidden` bit with a 3-state display axis, and made
  promotion *place* content, not just reveal it. Onden's promote is a bare
  `hidden=false` flip.
- Anytype and AppFlowy make the **lens a per-view setting over one dataset**
  (Anytype's `BlockContentDataviewViewType` enum, AppFlowy's `DatabaseLayoutPB`
  Grid/Board/Calendar over one database) — and Anytype/Tana make *typing* the
  structuring act and keep typed objects fully visible. Onden does the opposite:
  typing a node (`class_tag`) **removes it from the loop view**, so maturing an idea
  hides it from the very surfaces meant to show its maturity. AppFlowy additionally
  separates "what kind of node is this" (`ViewLayout`) from "which lens renders its
  rows" (`DatabaseLayoutPB`) — a distinction Onden collapses into one bit.
- SiYuan shows a converge mechanism Onden lacks entirely: distillation as an
  *attribute on the original block* (`custom-riff-decks`), so the same block is raw
  note, embedded block, and review card with no copy — maturity layered onto the
  object rather than moving it between records.
- Heptabase and Muse explicitly model the **loop** (converge can precede a second
  diverge; not everything must converge). Trilium decouples placement from the note
  (a note is one record reached by many parent `Branch` edges), which is the data
  shape that makes a board card and an outline entry the *same* node. Onden has no
  loop-back affordance and no notion of stage at all — only forward imperative jumps
  between modes, and two canvas systems bridged by an opaque id rather than shared
  edges.

The structural mismatch: Onden's thesis says *a node is the home and canvas / graph /
table / inbox / timeline are lenses on that node's maturity, and the flow is a loop*.
The implementation says *five co-equal top-level modes, a board buried two clicks
under one of them, and a one-bit maturity flag that evicts ideas the moment they are
typed.* The thesis is right and already validated by the field (Anytype's view-type
enum and AFFiNE's display-mode enum are it, shipped). The code has simply not caught up.

## Recommendation for Onden

Make the maturity loop **one object, many lenses, one explicit stage axis** — and
demote the five peer modes to lenses, with Website as a publish gesture rather than a
peer mode.

**1. Replace the `hidden` bit with a maturity axis on the node.** Mirror AFFiNE's
move: a `hidden` boolean is too coarse. Introduce an explicit maturity/display state
on `content_node` — at minimum `{captured, diverging, converged}`, expressible as a
display-axis like AFFiNE's `NoteDisplayMode`. `hidden=true` maps to `captured`
(inbox/edgeless-only), promote advances the stage, and — critically — typing a node
does **not** silently drop it from the loop. The bit becomes a derived view of the
axis, not the source of truth. Keep this at the dispatcher/policy layer, never as a
hard schema gate (per the typing-is-a-capability thesis), so freedom survives.

**2. Capture should deposit onto the board, not into a daily-note editor.** Today
QuickCapture appends to the daily note and forces `setMode("notes")` — it skips
diverge entirely. A captured idea should be able to land as a `captured`-stage node
that is *already addressable on the diverge lens* (the graph/canvas), so the loop's
first move (capture -> diverge) is one gesture, not a manual drag-in. The daily note
remains a valid capture *destination*, but capture should not hard-pin you to the
editor.

**3. Unify the two canvas systems into one node-backed substrate.** The standalone
`CanvasMode.tsx` (loose ReactFlow cards with an opaque `data.nodeId`) and the
integrated `KnowledgeWorkspace` must collapse to one model where **every card is a
content node** (the Scrintal/AFFiNE one-store principle). A card and its expanded
note are the same object viewed through two lenses — diverge (spatial) and converge
(document) — not two records bridged by an id. Trilium's data shape is the concrete
target: the note is the single record and each placement is a `(noteId, parentId)`
edge (`Branch`), so a board card and an outline entry are the *same* node reached by
two edges — replace the opaque `data.nodeId` bridge with shared edges. This is the
single highest-leverage fix: it is the precondition for everything else.

**4. Converge must keep the idea in the loop, and typing is just a lens.** Adopt the
Anytype/Tana model: giving a node a `class_tag` (tag = node = class) is the
*structuring* act, and a typed node stays fully visible — rendered through whichever
lens its class recommends (table / kanban / timeline as *views on the query*, exactly
Anytype's `DataviewViewType`). It must never be filtered out of the loop surfaces.
Provide a Heptabase-style assembler so several converged board cards can be pulled
into one outline by reference (not copy), since the same node lives on the board and
in the note.

**5. Demote the five peer modes to lenses on a node; make Website a gesture.**
The `notes / tags / tasks / website / timeline` tablist in `useUiMode.ts` /
`AppTopbar.tsx` should stop being five co-equal apps. `tasks` and `timeline` are
**lenses** (Anytype's Kanban/Calendar over a query); `tags` collapses into node space
(editing a class = opening that node + a schema/policy lens); the canvas is promoted
from a sub-toggle to a first-class **diverge lens** of the node you're on. `website`
becomes a **publish gesture/destination** invoked on a node, not a mode you switch
into. The top bar then answers "which lens am I viewing this node through?" instead of
"which of five apps am I in?".

**6. Make the loop a loop, with a visible stage and a loop-back.** Surface each
node's maturity stage (the axis from #1) and afford explicit transitions both ways:
diverge -> converge **and** converge -> diverge (Heptabase's second-diverge,
Muse's organize-later). Replace the scattered imperative jumps
(`setMode(...); setNotesView("canvas"); selectCanvas(...)`) with stage-aware
navigation: advancing or reverting a node's stage *is* the gesture that swaps its
lens. Because every mutation is actor-attributed on the event-sourced spine
(`NODE_PROMOTED` already exists), stage transitions become first-class, auditable
events — capture, diverge, and converge each emit their own event, and the human and
the agent share one legible loop.
