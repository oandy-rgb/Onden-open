# Interaction-design decisions (settled)

> 狀態：現行（最後確認 2026-11-01）

This is the **decision layer** that sits above the exploratory cross-app studies
(`01`–`10`). Those docs survey how other tools work; this one records what Onden
**decided**, why, and how confident the grounding is.

Settled in the 2026-06-08 grill, grounded in (a) the vendored competitor source
(Anytype, AFFiNE, Reor, Khoj, AppFlowy, Blinko, Joplin, Logseq, SiYuan, Trilium)
and (b) several clean real-user research passes (capture, home/landing, landing
prevalence, custom-class UX, publishing, tasks). Each decision tags evidence as
**confident** (≥2 independent real-user sources) or **thin** (single/vendor/anecdote).

Guiding thesis (see `memory/product-thesis`): node = connection; tag = a
tag-loaded capability enforced at the **dispatcher boundary**, never schema-level;
**governance is the precondition for unconstrained AI-collab**. One human + one
autonomous agent is the beachhead.

---

## D1 — The surface is "one home + lenses", not co-equal modes

**Decision.** Kill the five co-equal top-level modes (notes/tags/tasks/website/
timeline). A **node is the home**; everything else is a **lens** on a node. The
selection-eject anti-pattern (`onSelectNode → setMode("notes")`) is removed
(done: surface S1, commit `31c1d69`).

**Why.** Co-equal modes feel like separate apps and lose context on switch; the
convergent real-user success pattern across every researched tool is "one space,
switchable views" + "capture anywhere, review in a dedicated surface".

**Evidence.** Confident — mode-switching context-loss and the capture-anywhere +
dedicated-review pattern recur across Logseq/Obsidian/Notion/Tana users.

---

## D2 — Canvas / view = a structural filter view; drag-in performs the membership op

**Decision.** A canvas/board is **always a structural filter view**, anchored to
either a **folder subtree** (`parent_id` / `note_pointers`) or a **tag**
(`node_tags`). Freeform brainstorming exists by **dragging a node onto the board,
which performs the membership op**:
- folder board → create a `note_pointers` clone/symlink (non-destructive),
- tag board → apply the current tag (`node_tags`).

Layout is persisted **per-surface** (`node_positions`, migration 050).
**Everything is a node** — no loose scratch cards, no decorative-arrow
canvas-local layer. The separate `canvases` table + `canvas_member` edge can be
**retired**. Every board is anchored to a folder or tag — for a filterless
scratch board, make a `#tag`.

**Why.** Keeps one substrate (auditable, syncable, agent-reachable); brainstorming
survives without a parallel non-node world; reuses `createPointer`/`node_tags`/
`node_positions`.

**Evidence.** User-driven design refinement (their words): "canva tag（資料夾以下）
以及 tag 視圖（同 tag）是好的"; freeform via drag-in performing the membership op.
Graph view downgraded to a discovery/local lens, not navigation (confident:
"global graph is beautiful but useless for nav").

---

## D3 — Lens strip: flat, and the **tag decides** which rich views exist

**Decision.** The lens strip is **flat** — NOT segmented into capture→diverge→
converge stages. Lenses are **contextual to the node**:
- any node: `editor` (its body) + `timeline` (its history) + `local graph`,
- a node with a subtree / a tag node: + `canvas` + `table`,
- a class_tag node: + the schema/views/policy surface (see D6).

**Which rich views are available is decided by the tag (class)** — a class_tag
owns its **Views** (table columns, board grouping, calendar field…) in
`collection_views`, alongside Schema/Policy/Behaviour. Single-node baseline
(editor/timeline/local-graph) is universal; the folder-subtree is a separate
structural axis. Ad-hoc table → make a tag.

**Why.** Maturity must not be a staged UI (users abandon staged pipelines —
confident); express maturity via connectedness + the agent instead. Tag-owned
views is the proven Notion/Anytype/Tana pattern and is already Onden's
`collection_views`.

**Evidence.** Confident on "staged pipelines get abandoned"; tag-owns-views is the
dominant pattern across vendored type systems.

---

## D4 — Capture mints a real child node under the current node (default: today)

**Decision.** Quick-capture **mints a real node** that is a **child of the current
node**; with no focused node (global capture / at home) it defaults to **today's
day node**. Relation = `parent_id`; a captured node is a full node (taggable,
linkable, promotable). This **replaces** the current `QuickCapture` behaviour of
appending `## HH:MM` text to the daily note's body.

**Why.** Everything-is-a-node holds; the capture has an on-ramp into the loop
(promote/tag/link); the day node becomes the de-facto inbox without a separate
rotting store.

**Evidence.** Confident — capture-lands-on-today is the dominant journal-first
pattern (Logseq/Roam/Tana); the append-to-daily-body shape is the flagged bug
(`08-capture-inbox`). Context-aware "child of current node" is the chosen
generalization of "child of day node".

---

## D5 — Home = today's day node by default, settable, never clobbering the session

**Decision.**
- **Default landing = today's day node** (matches D4; the journal-first norm).
- Make it a **per-user setting**: today / home / resume-last.
- **Additive, non-clobbering**: on launch restore the prior open lenses/panes and
  surface today *alongside* them — never take over the workspace.
- **Today = only today** (not the full journal with yesterday's clutter).
- **home is a real, authorable node** (`home_node_id`), not a breadcrumb — but its
  content is **mostly auto** (recent / today / pinned tags / agent-surfaced
  loose-ends) with optional hand-authored MOC; **don't ship an empty dashboard,
  don't force manual upkeep**. Defer a rich fixed dashboard until the graph is big
  enough to need orientation.

**Why.** The landing choice is a **taste** question (split three ways across users)
— for a single-user app, ship the journal-first default and let the setting cover
the rest. The **non-clobbering** rule is mechanism, not taste.

**Evidence.** Confident: the #1 real-user complaint is a forced default that
overrides the session; today/home/resume are three durable camps with no clean
winner; land-on-today leads on shipped-default (Logseq/Roam/Tana, Tana hard-codes
it) but only marginally on independent preference. Thin: hand-built dashboards
"rot" (real failure modes are graph-too-small / maintenance-bloat / clean
retirement) — so auto-content + defer.

---

## D6 — The "class" concept is never surfaced; no JSON; structure emerges from direct manipulation + agent

**Decision.** The tag/attribute/query/lens machinery is the right **substrate**
but must stay **invisible**:
- Never surface **class / schema / type / JSON** as user-facing concepts. There is
  **no "class definition" screen**. The current raw-JSON path (TagPack import +
  the form-style field/policy/behaviour editors in `TagsPanel`) is removed from
  the everyday path (keep a hidden import/export escape hatch only).
- **`#tag` stays** as a plain user-facing label (hashtags are mainstream).
- Structure **emerges from direct manipulation of real instances** ("+ add a date/
  status/property" with a friendly picker; arrange a table/board by dragging — the
  saved view is a side-effect) **+ agent proposals in plain language** ("your tasks
  often have a due date — add it?"). The user never hand-authors a schema, view,
  or query.
- Everyday primitives (task, note) ship **pre-shaped and ordinary** (Things/Todoist
  feel); custom types are an advanced, agent-assisted lane, not the default.

**Why.** Exposing class/schema/JSON turns the user into a data-modeler (the
"程序員導向" critique). The substrate is why Onden's typed data is parse-immune
(see D8) — keep the engine, hide the dashboard.

**Evidence.** Confident (custom-class UX research): destructive/JSON-only schema
editing is the densest pain category; "structure should be an OFFER not a gate";
in-place beats a separate schema screen; text-first "just start, harden later"
wins on ease-of-use. Soft schema = never reshapes/rejects existing instances;
enforcement is safety-only at the dispatcher boundary. See `memory/
surface-no-programmer-ui`, `04-tag-as-node`.

---

## D7 — Inbox = the governance/review surface (NOT a capture pile)

**Decision.** The inbox is a **lens over `domain_events` where `actor_type ≠ me`
AND not-yet-reviewed** — i.e. changes I didn't author, awaiting my review. Agent
changes now; collaborator changes later (multi-user). It is the human's control
room over the autonomous agent.
- Reuses the spine: `actor_type` is already unforgeable; add a small "reviewed"
  flag. **reject = the existing event-log inverse-undo**; approve = mark reviewed.
- **Gate model — target is risk-tiered; shipped is apply-then-review.** The
  intended end state: low-risk/reversible (tag, link, draft, roll recurring) →
  autonomous + post-hoc reviewable; high-risk/irreversible/outward (publish,
  delete, external send) → **approve-before-apply** (held un-applied until
  approved). So the inbox would hold two card kinds: "FYI I did this (undoable)"
  and "awaiting your approval (not applied)".
  - **What's actually built (as of Phase D): only the first kind.** There is no
    sandbox/staging since migration 047 — every agent change goes through the
    spine and is *applied immediately*, then surfaced in the queue for
    after-the-fact review where **reject = inverse-undo**. So today the inbox is
    an apply-then-review audit/undo gate, NOT a pre-commit one. "No action" means
    the change *stands* (reversibly), not that it's held.
  - The approve-before-apply tier is future work: it needs a proposed-vs-
    committed event distinction so a high-risk change can sit un-applied until a
    human approves. Until then, the safety boundary on high-risk agent actions is
    the write-time authority + per-token tag scope (the spine), not the inbox.
- Distinct from neighbours: **day node = my own capture** (nothing to approve);
  **orphan lens = loose-ends hygiene** (optional). Inbox = non-self-authored,
  already-applied, awaiting-review.

**Why.** Directly on-thesis: governance is the precondition for letting the agent
act freely. The substrate already records who did what, reversibly.

**Evidence.** User decision (product-core). The risk-tiered/approve-before-apply
target was chosen explicitly ("先默認拒絕 我用看看後決定"); the apply-then-review
posture is what the current implementation provides while that gate is unbuilt.
See `memory/inbox-governance`. Update `08-capture-inbox` to reflect
inbox-as-governance (it currently frames inbox as capture triage).

---

## D8 — Tasks = a lens over `#task` nodes; own the agenda, defer mobile push

**Decision.** A task is a **node with a `#task` tag** carrying due/status/priority
in `node_attributes` (013 already seeds this). **Tasks is a LENS** (a read
projection), never a co-equal mode.
- Ship **separate buckets** out of the box — **Today / Overdue / Upcoming /
  Blocked** — **server-computed** (mobile matches desktop) and **natively
  interactive** (keyboard reorder/complete). The user never hand-writes a query.
- **Richer states** (WAITING/LATER/blocked) so the agenda can exclude noise.
- **Recurring is native** (break-or-make): each occurrence is a real node+event
  minted on completion; the **agent rolls it forward**. Unattended advance needs a
  **time-trigger** primitive — the one genuinely new piece of infra (dispatcher has
  none today); scope it minimally, only when needed.
- **Do NOT build mobile/OS push notifications** — the irreducible external mess.
  Lean on the agent (surface due-today into the day node, ping via its own channel)
  or interop with a dedicated app.
- The everyday task surface is **ordinary** (per D6): checkbox / NL date / check-off
  — no status-enum config, no `#task` ceremony in the user's face. Agent triages
  fresh captures into typed tasks.

**Why.** Markdown PKMs' task agendas fail by **silently dropping** tasks (emoji
Unicode, tag-position rules) because they regex over body text. Onden queries
structured tag fields → **structurally immune** to that whole class. The agent
turns "discipline-dependent" into "agent-maintained".

**Evidence.** Confident: capture-anywhere + dedicated-review is universal; a single
lumped agenda is untrusted (buckets must be separate); silent-drop kills trust in
markdown task rollups; recurring is break-or-make (Tana's 223-vote gap); push is
the decisive reason users keep a dedicated app. See `05-tasks-lens`.

---

## D9 — Publishing = a per-node opt-in gesture; privacy is the #1 hardening target

**Decision.** (`07-publishing`; publishing is a deliberate motivation-driven
priority — harden, don't cut.)
- **Unit = node (+ subtree)**; gesture = per-node toggle (Cmd-K "Publish this
  node / subtree"), reusing the existing WebsiteStudio Publish + Open/Copy.
- **Membership is explicit opt-in (allowlist), not opt-out.** Today `/publish`
  snapshots *every non-hidden node* (an exclusion query) — the inverted default
  that leaks. **Flip it: publish only nodes carrying the publish marker.** (Verify
  + fix in `routes/publish.ts` before building.)
- **Privacy hardening (top priority):** filter snapshot `edges` to published-only
  (else the graph view leaks private titles); links to unpublished render inert;
  emit only blobs referenced by published nodes (content-hash addressed — closes
  the brute-force-path hole); `buildSiteJson` = strict allowlist projection; a
  pre-publish "what will be public" preview.
- **Auto-republish:** publish marker is sticky; saving a published node enqueues
  `pages_push` in the same dispatcher tx (reuse `enqueuePagesPush` + outbox dedup).
  Unpublish = a forward event dropping the node's files (PUBLISH_SNAPSHOT_CREATED is
  `external=true`, not restore-invertible).
- **High-risk → pre-approval gated** in the inbox (D7).
- Output: published-**subgraph** graph/wiki view (signature differentiator) + the
  existing static article templates. Keep static/SSR, not heavy client-render.

**Why.** Per-note selective publish is the praised gesture; the churn drivers are
the update loop + SaaS pricing (Onden's self-host + GitHub Pages + BYO-domain
sidesteps both), not the click. Selective-publish privacy leaks are a serious,
repeated real-user concern.

**Evidence.** Confident: per-node publish praised; update-loop/hosting drives churn;
selective-publish leaks private data (Obsidian graph-title leak, Logseq
window-globals). Thin: "interactive published graph is a unique differentiator"
(single vendor-ish source) — treat as a bet.

---

## Cross-cutting substrate implications

- **Retire** the separate `canvases` table + `canvas_member` edge (D2); layout
  lives in `node_positions` per-surface.
- **`node_positions`** is the per-(node, surface) placement substrate for every
  board/graph lens.
- **A "reviewed" flag / review-ledger** on events is the only new state D7 needs;
  reject reuses event inverse-undo.
- **A minimal time-trigger** primitive is the one genuinely new piece of infra
  (D8 recurring / agent due-surfacing) — build only when recurring needs unattended
  advance.
- **`routes/publish.ts` exclusion → allowlist** is the load-bearing publish fix (D9).

## Docs to reconcile (follow-up)

- `08-capture-inbox`: reframe inbox as **governance/review** (D7), not capture
  triage; capture → real child node on the day node (D4).
- `04-tag-as-node`: add the **no-class-concept / no-JSON / structure-emerges**
  surface stance (D6) and Views as the 4th class axis (D3).
- `01-nav-model`: home = settable, non-clobbering, today-default (D5).
- `arch-comparison/06`: outbox is wired (not "UNWIRED"); publish opt-in (D9).
