# Tasks as a lens/filter vs a separate app

> 狀態：歷史紀錄（最後確認 2026-11-01）

> **Thesis anchor.** A node is the home; canvas / graph / table / inbox / timeline
> are *lenses* on a node's maturity. A tag is a node is a class. There is no
> co-equal mode-switching. "Tasks" is the cleanest possible test of whether Onden
> believes its own thesis, because the entire industry has already converged on
> *tasks-as-a-lens* and Onden currently ships *tasks-as-a-separate-app*.

## Onden today

Onden does not have one task concept with a weak lens. It has **two fully
separate task concepts that never converge**, and the one the UI actually uses is
the non-thesis-aligned one.

**(1) `node_tasks` — the table the Tasks UI is built on.** A dedicated SQL table
`node_tasks(id, workspace_id, node_id, title, status)` with a hard
`CHECK (status IN ('todo','done'))` constraint — exactly two states
(`db/schema.sql:602`, `db/migrations/001_baseline.sql:48`). It is a child
checklist hung off a `content_node` by FK with `ON DELETE CASCADE`. Creation goes
through `POST /api/nodes/:id/tasks` (`routes/nodes.ts:499`), which inserts
`status='todo'` and emits a `TASK_CREATED` event through the spine `mutate()`
gate (authority = `write_node` on the host node). Toggling goes through
`PATCH /api/tasks/:id` (`index.ts:597`), flipping status and emitting
`TASK_UPDATED` (deliberately renamed from `TASK_COMPLETED` so the sync delta
layer picks it up). The full list ships in the workspace bootstrap
(`index.ts:306`) and through the sync delta path (`sync.ts:132`, `taskUpsert`).
The frontend type is `NodeTask = { id, node_id, title, status: 'todo'|'done' }`
(`lib/api.ts:43`).

It is surfaced two ways, neither of which is a lens:

- **Per-node**, as the InspectorPanel "Tasks" widget with an "Add checklist
  item" affordance (`InspectorPanel.tsx:162`), wired through
  `useNodeLifecycle.addTask` (`useNodeLifecycle.ts:73`).
- **Workspace-wide**, as `TasksMode.tsx` — a **fifth co-equal top-level mode**.
  `AppMode = "notes" | "tags" | "tasks" | "website" | "timeline"`
  (`useUiMode.ts:13`), rendered as five peer buttons in the topbar
  (`AppTopbar.tsx:49-61`). `TasksMode` simply filters the bootstrap-derived
  `tasks[]` array client-side into To do / Done / All tabs and PATCHes to toggle.

Its own header comment is the most honest description of the IA weakness:
"_Out of scope for v1 (substrate is missing the columns): deadlines / due dates,
per-task assignee._" The substrate is missing those columns because `node_tasks`
is a bespoke side table, not a typed node.

**(2) The `#task` supertag — the thesis-aligned model the UI never touches.**
Migration `013_seed_task_tag.sql` seeds a `collection_schema` (slug `task`) with
real fields: `status` as a **four-option** select (`todo / in_progress / done /
cancelled`), `due_date` (date), `priority` (select), plus grid/detail views and
behaviour rules (`on_apply` → set `status='todo'`; `on_attribute_change` → when
`status='done'`, `set_hidden=true`, i.e. auto-archive). A `tags` row of
`kind='supertag'` points at that schema. **This is exactly the "a tag is a node
is a class" path**: applying `#task` to any node would type it, give it task
attributes via `node_attributes`, and enforce semantics at the dispatcher /
behaviour layer.

But `TasksMode` reads **only** `node_tasks`. It has zero references to
`class_tag_ids`, the task schema, `node_attributes`, `due_date`, or `priority`.
The two systems share the word "task" and nothing else:

| | `node_tasks` (what the UI uses) | `#task` supertag (what the thesis wants) |
|---|---|---|
| Storage | bespoke side table | typed node + `node_attributes` |
| Status enum | 2 values (`todo/done`) | 4 values (`todo/in_progress/done/cancelled`) |
| Due date / priority | none | seeded fields |
| Done semantics | none | behaviour rule → auto-hide |
| Surfaced by | TasksMode + Inspector widget | nothing |

**Net:** tasks today are a *separate app* (a peer mode + a checklist widget)
backed by a special-cased table — **not** a saved filter/lens over typed nodes.
The lens infrastructure that would make tasks a lens (supertag + schema +
attributes + behaviour) already exists and is already seeded — it is just wired
to nothing on the task side.

## How the field does it

Every serious PKM/notes tool that models tasks at all has converged on the same
shape: **a task is a node (or an inline block) carrying a status; the "Tasks
view" is a saved live query/lens over those nodes — never a separate store.** The
only disagreements are (a) typed-node vs inline-checkbox as the unit, and (b) one
deliberate split between a *lightweight checklist item* and a *real task*. This
convergence is now confirmed directly against vendored source for AFFiNE, Anytype,
Logseq, SiYuan, Trilium, AppFlowy, Joplin and Blinko (not just docs): in every one
the task lives in the shared content/node/block store and the task list is a
filter/view over it. The split between (a) and (b) is real but bounded — Logseq
(DB graph) and Anytype sit at the *typed-node* pole, SiYuan and the markdown tools
at the *inline-block* pole, and Trilium spans both.

| App | Approach | What's good |
|---|---|---|
| **Tana** | Task = node tagged `#task` (supertag = node-as-class with `done` checkbox + date field). No Tasks app — you drop a **Search Node** (live query, e.g. "tagged `#task`, done unchecked, date < today") anywhere, with filter/group/sort and swappable views. | **Identical to Onden's intended tag=node=class.** Proves the model works at product scale. The lens lives *in the space*, not in a mode. |
| **Anytype** | Task = node typed by built-in `Task` object type (`Layout=ObjectType_todo`, icon `checkbox`) carrying relations `done` (system checkbox relation), `dueDate`, `status`, `priority`, `assignee` — stored as object details, not a side table. Aggregation = a **Set / Query** object (`Layout=ObjectType_set`, `RelationKeySetOf`) = a saved live query "set of type Task" rendered grid/kanban/calendar. | Typed node + Set-lens is *exactly* the node=home / lens-over-maturity split. `done` is a first-class relation, not a 2-value side column. |
| **Notion** | A "task database" is just a normal database; `status` is a Status/Checkbox property. "My Tasks" / "In Progress" are **filtered views** over one shared DB; guidance explicitly warns against per-project task DBs in favour of filtered views. | Mainstream proof that "views over one store" beats "many stores". Status-as-property can even render *as* a checkbox. |
| **AFFiNE (BlockSuite)** | Two-tier and the upper tier *is* tasks-as-a-lens. A todo is a list block with `props.type === 'todo'` (verified `list-model.ts:12`, `list-block.ts:53`). The **data-view** block's `BlockQueryDataSource` (`data-source.ts:22`) takes `config.type` keyed into `blockMetaMap`, which includes `todoMeta` (`block-meta/todo.ts`, selector `flavour===list && props.type==='todo'`). The table/kanban view **materializes live over the editor blocks** — no task table. | Lens reads the *content blocks directly*; zero duplication. A model for "checklist in a note" + "queryable task board" being the same data. |
| **Capacities** | Task = dedicated built-in object **type** (a node), inline-creatable from any note, auto-linked to its origin via a Context property and shown in that object's task tab. Central dashboard (Inbox/Today/Scheduled/Context/Open/Completed) + `/query` blocks are the cross-note lenses. | Typed node + context-link + query lenses — close analog to Onden's intended model, with a clean "where did this come from" back-link. |
| **Obsidian (Tasks + Dataview)** | Task = inline markdown `- [ ]` anywhere, decorated with metadata (due/recurrence/done date). Source of truth stays in the note. A ` ```tasks ` query block in any note pulls a filtered/grouped/sorted live list; toggling done in the query writes back to the original line. | Markdown-native, query-anywhere, write-through. Matches Onden's "markdown as truth" editor stance (see editor-decision memory). |
| **Amplenote** | Deliberate two-tier: a **checklist item** (just a checkbox, stays inline, never enters Tasks Mode) vs a real **Task** (carries scheduled date, hide-until, repeat, score). Unified Task List / Tasks Mode is one auto-sorted lens over every Task across notes, with group/sort/filter + Agenda (calendar). | The cleanest articulation of the checklist-vs-task split — the same split Onden is currently *failing* by having `node_tasks` be the lightweight tier with no path to the heavy tier. |
| **Logseq** *(source-verified)* | **Two models, both lens-based, no task store.** (a) Classic markdown graph: task = inline block with a workflow marker, parsed in `deps/graph-parser/src/logseq/graph_parser/property.cljs:214` (`SCHEDULED:`/`DEADLINE:` lines stripped into block properties). (b) **DB graph (the modern direction): task = a *typed node*, not just a marker.** `deps/db/src/logseq/db/frontend/class.cljs:40` defines a built-in class `:logseq.class/Task` whose schema carries properties `:logseq.property/status`, `:priority`, `:deadline`, `:scheduled`. `status` is a **6-value closed set** — Backlog / Todo / Doing / In Review / Done / Canceled — with `done`/`todo` flagged as checkbox states and a default of `todo` (`deps/db/src/logseq/db/frontend/property.cljs:300-321`). | **Strong evidence for Onden's exact `#task`-supertag plan.** The DB-graph model *is* tag=node=class: applying the built-in `Task` class types a node and gives it status/priority/deadline/scheduled attributes; views are queries over typed nodes. Note Logseq's status enum is *richer* than Onden's seeded 4-value one (it adds Backlog + In Review). |
| **SiYuan** *(source-verified)* | Task = a GFM task-list-item **block** in the one universal block store, not a separate entity. The AST node `ast.NodeTaskListItem` / `NodeTaskListItemMarker` carries a `data-task` checked marker; toggling done goes through a dedicated marker-update endpoint, and the code explicitly forbids setting `data-task` any other way (`kernel/api/block_op.go:35-102`, `kernel/model/blockial.go:224`). All blocks (incl. tasks) live in one `blocks` table with `type`/`subtype`/`ial` columns (`kernel/sql/database.go:123`, `kernel/sql/upsert.go:46`); "task views" are embedded SQL queries over that table. | Pure inline-checkbox-as-block-in-one-store. No task app, no task table — a single block substrate with SQL lenses. Closest to a "markdown task = queryable block" model. |
| **Trilium** *(source-verified)* | **Two coexisting models, both node/attribute-based.** (a) Built-in editor **task-list states**: CKEditor checkbox items with a `data-trilium-task-state` marker; two non-customizable anchors `none`/`done` plus user-editable states, default set Doing `[/]` / Maybe `[?]` / Cancelled `[-]` (`packages/commons/src/lib/task_states.ts:47-62`). (b) **Task-as-note** (the official Task Manager showcase, a *script*, not a built-in type): a text note with a `#task` label + `todoDate`/`doneDate` labels; an `attribute changed` handler reconciles it between Todo/Done parent notes on date change (`apps/.../Task manager/Implementation/attribute changed.js`, `createNewTask.js`). | Inline-checkbox tier *and* a note-with-attributes tier — but the heavy tier is user-scripted over the generic label/relation system, not a first-class task object. Confirms attribute-on-node + saved-search-as-lens is sufficient to build tasks without a task store. |
| **AppFlowy** *(source-verified)* | Task = a **database row** (a node); "task-ness" is a field on it — `FieldType::Checkbox` (5), `Checklist` (7) or a `SingleSelect` status (`frontend/rust-lib/flowy-database2/src/entities/field_entities.rs:431-479`). One database has many **views** (`DatabaseLayoutPB`: Grid 0 / Board 1 / Calendar 2 — `setting_entities.rs:44-48`), each carrying its own filters/sorts over the *shared* rows (`services/database_view/view_filter.rs`). | Notion-model done in open source: a task board is just a Board view (grouped by the status select) over the same rows a Grid shows. Views-over-one-store, filters live on the view — never a separate task table. |
| **Joplin** *(source-verified)* | Task = a **note** with `is_todo=1`; due/done are columns `todo_due` / `todo_completed` (epoch ms) on the *same* `notes` row (`packages/lib/services/database/types.ts:577-590`, `packages/lib/models/Note.ts:300,471`). Any note can be flipped to/from a to-do; "completed" is a timestamp, and there's a built-in `uncompletedTodosOnTop` sort (`Note.ts:307`). The to-do list is a sort/filter over notes, not a store. | Minimal, clean "task = note + status flag" — exactly the substrate Onden's `node_tasks` side table fails to be. Flag + due/done columns on the node beats a bespoke table. |
| **Blinko** *(source-verified)* | Task = a **note** with a `type` discriminator (`NoteType` enum BLINKO/NOTE/**TODO**, an int on the shared `notes` table — `shared/lib/types.ts:14-27`, `prisma/schema.prisma:72`). "Done" is overloaded onto `isArchived=true` on the same row (`app/src/components/BlinkoCard/cardHeader.tsx:88`). The TODO surface is a type-filter over the one notes table. | Note-type-flag flavour of task-as-node. Cautionary on done-semantics: reusing `isArchived` as "done" is the kind of binary-overload Onden should avoid in favour of a real status attribute. |
| **reor** | **No task model at all.** Checklist is a plain editor list item — no status field, no due date, no aggregation. Tasks are purely textual. *(source-verified earlier; reor has no task entity.)* | Not a model to copy; confirms that a checklist with no status axis is not a task system. |
| **khoj** | **Not comparable.** The only "task" is scheduled **automation** (`api_automation.py`, apscheduler `CronTrigger`) — recurring agent jobs, orthogonal to note to-dos. | Useful only as a boundary case: agent automation ≠ user tasks. (Relevant to Onden's single-human-plus-agent framing — see Recommendation.) |
| **Blinko (the *other* "task")** *(source-verified)* | Separately from `NoteType.TODO`, Blinko also has `server/routerTrpc/task.ts` + `aiScheduledTaskJob.ts` — **scheduled AI/cron jobs**, not user to-dos. | Reinforces the khoj boundary with a *second* vendored example: "task" in these tools often means *agent automation*. Onden must keep its task model (user intents) strictly distinct from agent scheduling. |

## The gap

1. **Onden ships the one shape everyone else abandoned.** Of the comparable
   tools, *zero* model the user-facing task surface as a separate store fronted by
   a peer "mode". Onden does both: a bespoke `node_tasks` table **and** a
   co-equal `tasks` topbar mode. This is the exact "co-equal mode-switching" the
   thesis says to kill.

2. **The richer, correct model is already built and orphaned.** `#task`
   (supertag + 4-state schema + due_date + priority + auto-hide behaviour) is the
   thesis verbatim — and the Tasks UI does not read it. Onden has paid for the
   lens infrastructure and is not using it. This is the cheapest gap in the whole
   IA to close because nothing needs inventing.

3. **The two systems will silently diverge forever.** Two status enums (2 vs 4),
   two storage models, two done-semantics (no-op vs auto-archive). A node can be
   "done" in `node_tasks` and untyped by `#task`, or `status=done` via `#task`
   and invisible to TasksMode. There is no reconciliation path.

4. **No maturity-loop integration.** The thesis frames flow as
   capture → diverge-on-board → converge-in-notes. A task is a unit of maturity on
   a node (capture an intent → it ripens → it completes). `node_tasks` cannot
   express maturity (2 states, no dates), so tasks sit *outside* the loop instead
   of being a lens *on* it.

5. **Agent-attribution is half-built on the wrong substrate.** Tasks already flow
   through the spine `mutate()` gate (good — actor-attributed, auditable). But
   because `node_tasks` is a side table, an agent completing a task and an agent
   typing a node `#task` are two unrelated event streams. The audit story only
   unifies once tasks are node attributes.

## Recommendation for Onden

**Kill `node_tasks` and the `tasks` topbar mode. Make "task" a lens over nodes
typed by the `#task` supertag — the model already seeded in `013_seed_task_tag`.**

Concretely, grounded in the thesis:

1. **Task = node, via tag=node=class.** A task is any `content_node` carrying the
   `#task` supertag. Its status/due/priority live in `node_attributes` under the
   seeded schema; "done" is `status='done'`, and the existing `on_attribute_change`
   behaviour rule (auto-hide) already gives done-semantics. This is the thesis's
   "applying a class tag types the node" path, enforced at the dispatcher/behaviour
   layer — exactly where the spine already governs mutations. Follow Tana/Anytype —
   and now Logseq's DB graph, whose built-in `:logseq.class/Task`
   (`deps/db/src/logseq/db/frontend/class.cljs:40`) is the same tag=node=class shape
   with status/priority/deadline/scheduled — not Notion's separate-DB framing. Note
   Onden's seeded `#task` schema uses a 4-value status; Logseq's 6-value set
   (adds *Backlog* and *In Review*) is worth considering when finalising the enum.

2. **Tasks is a *lens*, not a mode.** Delete `tasks` from the `AppMode` union
   (`useUiMode.ts:13`) and its topbar button (`AppTopbar.tsx:55`). Re-express
   "Tasks" as a saved live query over `#task`-typed nodes, rendered through the
   *existing* lens set: the **inbox/table lens** for triage, the **timeline lens**
   for due dates, the **board (canvas/kanban) lens** for status columns. This is
   "tasks are a maturity lens on a node," not a peer app. Anytype's Set and Tana's
   Search Node are the proof that a saved query *is* the Tasks surface — and the
   open-source vendored tools confirm it independently: AppFlowy's Grid/Board/Calendar
   are filtered views over one database, and Logseq's DB graph queries its built-in
   `:logseq.class/Task`-typed nodes directly. No vendored tool ships a separate task
   store fronted by a peer mode.

3. **Keep one inline capture affordance — promote, don't fork.** The InspectorPanel
   "Add checklist item" gesture is good and should stay, but it must **create a
   child node tagged `#task`** (or apply `#task` to an existing node), not insert a
   `node_tasks` row. This honours the Amplenote checklist-vs-task split correctly:
   a lightweight inline checkbox can be a node with only `status`, and "promoting"
   it (adding a due date) is just filling more attributes on the *same* node — no
   second system. Markdown-as-truth (per editor-decision memory) means the inline
   `- [ ]` can stay the capture surface, Obsidian-style, with the node/attribute as
   the queryable projection.

4. **One migration, then delete the side table.** Backfill: for each `node_tasks`
   row, apply `#task` to its host node (or create a child node) and map
   `status: todo→todo, done→done`. Emit a real spine event so the conversion is
   actor-attributed and restorable. Then drop `node_tasks`, the `/nodes/:id/tasks`
   and `/tasks/:id` routes, the bootstrap/sync `taskUpsert` special-casing, and the
   `NodeTask` type. The 4-state enum becomes the only enum; the substrate gains
   due_date/priority *for free* (closing the "v1 substrate is missing the columns"
   admission in `TasksMode.tsx`).

5. **Lean into the single-human-plus-agent framing.** Because tasks become node
   attributes mutated through the spine, an agent creating, re-prioritising, or
   completing a task is fully actor-attributed and auditable on the same event log
   as every other node mutation — the audit story unifies the moment the side
   table dies. (Keep this strictly separate from khoj-style scheduled *automation*;
   that is agent scheduling, not user tasks, and should not contaminate the task
   model.)

**Headline:** Onden doesn't need to *build* tasks-as-a-lens — it needs to *delete*
the bolted-on version (`node_tasks` + the 5th topbar mode) and point the UI at the
`#task` supertag it already seeded. The correct architecture is sitting in
migration 013, unused.
