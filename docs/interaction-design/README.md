# Interaction design — one home, many lenses

> 狀態：歷史紀錄（2026-06 的設計分析與 2026-06-12 的進度對照；最後確認 2026-11-01）

This set of ten sections is about **interaction, IA, and UX** — not architecture
(that is covered in [`../architecture/`](../architecture/)).
Each section maps what Onden does today, verifies how the field does it (vendored
competitor source where present: `AFFiNE/`, `anytype-heart/`, `anytype-ts/`,
`reor/`, `khoj/`, `AppFlowy/`, `Blinko/`, `Joplin/`, `Logseq/`, `SiYuan/`,
`Trilium/`), names the gap, and recommends. This README ties them into a
single direction.

---

## The core tension

Onden's frontend ships **five co-equal top-level modes** — Notes / Tags / Tasks /
Website / Timeline — rendered as a peer `role="tablist"` in the topbar. They are
sibling *destinations* you switch between, none of them addressable (mode lives in
a `useState` that resets on reload; there is no router). Notes is the de-facto home
only by accident: the inspector and overview are gated on `mode === "notes"`, and
every other mode's `onSelectNode` calls `setMode("notes")` to do anything with a
selection — a **selection-eject anti-pattern** where touching a node throws you out
of the lens you were in.

The thesis says the opposite. **A node is the home. Canvas / graph / table / inbox /
timeline are *lenses* on that node as it matures.** Capture → diverge → converge is a
loop you stay inside, not five rooms you walk between.

The field has already converged on the thesis. Every real node-space we read —
Anytype (type *is* a smartblock object carrying its own schema; views are an
enumerated `DataviewViewType`), AFFiNE (`primaryMode`/`toggleMode`, a 3-state
`NoteDisplayMode` that literally deprecates a boolean `hidden`) — is "one persistent
home + lenses around it." The **only** peer-mode product in the set is khoj — which
is an AI assistant, not a PKM. **Onden today is khoj-shaped while aspiring to be Tana.**

The good news, repeated across nearly every section: **the gap is IA, not capability.**
The substrate already believes the thesis (`home_node_id` exists server-side;
`class_tag` is a real `content_node`; the event-sourced spine attributes every
mutation to an actor; migration 013 already seeds a `#task` supertag with proper
status/due/priority). The surface just hasn't caught up. Most of this work is
**frontend deletion and re-routing**, not new backend.

---

## Cross-cutting recommendation

**1. The top level becomes one addressable home + a lens switcher.**
Collapse the five modes into a single node surface backed by the existing
`home_node_id`. Replace the topbar tablist with a **lens strip** (editor / canvas /
graph / table / inbox / timeline). The open node and its active lens become a
**persisted, deep-linkable, agent- and audit-referenceable** location — introduce a
real router so "where am I" is durable state, not ephemeral React state. Never eject
on selection; **always reveal the node in place** within the current lens. → §01, §03

**2. Tags collapse *into* the node space.**
The substrate already realizes tag = node = class — `class_tag` is a `content_node`
with a (currently dead) markdown body. Make it **openable as a node**, surface its
body, and demote Schema / Policy / Behaviour to a **lens** on that node. Add a
member-set lens (reuse `collection_views`, mirroring Anytype's embedded Dataview).
Retire "Tags" as a peer mode. → §04

**3. Website becomes a gesture, not a mode.**
Kill the WebsiteStudio peer mode. Publishing is (a) a **per-node gesture**, (b)
**explicit and tag-driven** via a `#published` capability tag — which decouples
governance from publication and kills today's inverted "any untyped visible node is
auto-published" rule — and (c) a maturity-*end* lens reusing `SiteTemplate`. Keep the
robust outbox / GitHub-Pages deploy, but reframe its trigger as an explicit
"Publish changes" action. → §07

**4. Tasks and Timeline are lenses, not apps.**
"Tasks" is a saved live-query lens (inbox / table / timeline / board) over nodes typed
by the **already-seeded `#task` supertag** — delete the bespoke `node_tasks` side table
and the tasks mode. "Timeline" is a **history lens** you can point at any node (and at
the workspace root), not a peer mode. → §05, §06

**5. The capture → diverge → converge loop becomes the spine of the UX.**
- **Capture** mints a *first-class, optionally tag-typed* node, enqueued offline-safe;
  collapse today's four disjoint inboxes into a single **low-maturity lens**
  (untyped + unconnected) that gives the loop its missing on-ramp. → §08
- **Diverge** unifies the two unrelated ReactFlow canvas systems into **one
  node-backed substrate** — a card and its expanded note are *one object, two lenses*. → §02, §03
- **Converge** replaces the single `hidden` boolean with an explicit **maturity /
  display axis** (mirroring AFFiNE's `NoteDisplayMode`), so typed/matured nodes stay
  *in* the loop rendered through class-recommended lenses instead of being evicted
  from inbox and overview. → §02
- **Cmd+K** is the keyboard expression of the same loop: current-node lens commands
  and capture/diverge/converge verbs replace "Go to {mode}" navigation, routed
  through the actor-attributed spine so **human and agent share one audited command
  channel**. → §10
- The **inspector** follows the focused node across *every* lens (not `mode === "notes"`),
  pins the class-tag schema as an editable node header, and keeps the
  actor-attributed event/restore feed as the governance face of human + agent
  co-inhabitation. → §09

The through-line: **node = home; everything else is a lens or a gesture; every
mutation is attributed and auditable.** That last clause is Onden's genuine
differentiator — the backend provenance (actor attribution, `tx_meta` agent calls,
`triggered_by` cascades, `external` flag) already *leads* the field. Surface it.

---

## Prioritized roadmap (highest leverage first)

1. **Kill the selection-eject + introduce a router.** Remove every `setMode("notes")`
   detour; ungate the inspector from `mode === "notes"`; make node+lens an addressable
   route. This single change converts five apps into one surface and unblocks
   everything below. → [§01](../archive/interaction-design/01-nav-model.md), [§03](../archive/interaction-design/03-lens-switching.md), [§09](../archive/interaction-design/09-inspector-panel.md)

2. **Replace the topbar tablist with a lens strip on the home node.** Promote
   `home_node_id` to the default location; demote canvas/graph/table/timeline/inbox to
   persisted, addressable lenses on the open node. → [§01](../archive/interaction-design/01-nav-model.md), [§03](../archive/interaction-design/03-lens-switching.md)

3. **Make `class_tag` openable; retire the Tags mode.** Surface the node-native body,
   add schema/policy and member-set lenses. Mostly frontend deletion. → [§04](../archive/interaction-design/04-tag-as-node.md)

4. **Re-express Tasks as a `#task` live-query lens; delete `node_tasks`.** The correct
   architecture already exists unused in migration 013. → [§05](../archive/interaction-design/05-tasks-lens.md)

5. **Make History a lens on any node + workspace root; kill the Timeline mode.** Collapse
   the two per-node history sections into one event-spined stream with inline markdown
   diffs; unify the two restore paths under event-restore. → [§06](../archive/interaction-design/06-timeline-history.md)

6. **Turn Publishing into an explicit `#published` gesture + lens; kill the Website mode.**
   Decouple governance from publication; keep the outbox deploy behind an explicit
   action. → [§07](../archive/interaction-design/07-publishing.md)

7. **Replace `hidden` with a maturity/display axis and unify the two canvases.** Gives
   the loop a real converge stage and keeps typed nodes in the loop. → [§02](../archive/interaction-design/02-maturity-loop.md)

8. **Rebuild capture as first-class-node minting + a single low-maturity inbox lens.**
   Offline-safe; sync-conflict dismissal moves out of the inbox; "today" resolved by
   attribute/Daily-class-node, not a title string. → [§08](../archive/interaction-design/08-capture-inbox.md)

9. **Refit Cmd+K to node/lens/loop verbs routed through the spine.** Expose the existing
   search DSL; add fuzzy/frecency/aliases/search-to-create; lift shortcuts into a
   rebindable registry. → [§10](../archive/interaction-design/10-command-keyboard.md)

Items 1–2 are the keystone: they are cheap, they are pure IA, and the rest compose
cleanly on top of them.

---

## Open questions / unverified

Recommendations grounded in **vendored source** (Anytype, AFFiNE, reor, khoj,
AppFlowy, Blinko, Joplin, Logseq, SiYuan, Trilium) are verified. The following
competitor claims are **web/docs-sourced only** (those products are not vendored in
the repo) and should be treated as directional signal, not fact:

- **Tana** (not vendored): supertag config panel / Tabs view / Extend inheritance;
  search-node query syntax and swappable render-as views; `#day` capture inbox;
  Cmd+K node-transforming verbs; "time machine" search keywords. (§01–§02, §03, §04, §05, §08, §10)
- **Notion** (not vendored): database-view type set and per-view filters/propagation;
  database-as-page + inline property-header editing; per-database (non-shared) schema;
  rollup/formula/relation property types; Share→Publish per-page toggle; snapshot
  cadence (~10/2 min) and retention tiers (30/90d/unlimited). (§01, §03, §04, §05, §07, §09)
- **Obsidian** (not vendored): Canvas "Convert to file" promotion and loose-card vs
  file-card distinction; Bases (`.base` files, layouts, `[this.file]` rebinding);
  Tasks write-back-to-markdown; QuickAdd append + Advanced-URI mobile chaining;
  three-layer history (File Recovery / Sync / Git); `publish: true` frontmatter;
  Linked/Unlinked mentions plugin with context snippet (now corroborated by
  source-verified Logseq/SiYuan); the no-batch / missing-assembler limitations
  (time-sensitive, may be outdated). (§01–§03, §05, §06, §07, §08, §09)
- **Heptabase, Scrintal, Muse, Reflect, Capacities, Fibery, Roam, Amplenote, Linear,
  Raycast, Superhuman, Quartz** — various per-section claims, all web-sourced. Notable
  specifics flagged: AFFiNE retention being *server-enforced* at 7d/30d (the strings are
  in `history-modal.tsx` but the enforcement layer was not verified); AFFiNE's "local
  workspaces can't publish without Cloud" cloud-gating precondition (the share path was
  verified, the precondition was not); Logseq's legacy file-graph `public::`/`private::`
  block syntax (web-cited — the vendored DB-graph `:logseq.property/publishing-public?`
  property is source-verified, the legacy text syntax is not).

Two **corrections** already folded into the sections: there is **no `Calendar`
`WidgetLayout`** in Anytype (`widget.ts` is Link/Tree/List/Compact/View + Space/Object;
Calendar is a dataview *view* type, not a widget layout); and Reor's editor is
**BlockNote** (TipTap-family), correct only in that sense.

---

## Status delta — what has shipped since these sections were written

*(2026-06-12. The analyses above describe the code as it stood when each
section was researched; they are decision documents and are deliberately NOT
rewritten. This list is the running reconciliation against the live app.)*

Roadmap items, in the numbering above:

1. **Shipped.** `useUrlLocation` (`?view=&node=&lens=`) made node+lens an
   addressable, reload-surviving route; the selection-eject detours are gone
   from the primary surfaces and the inspector follows the focused node in
   every lens.
2. **Shipped, tighter than proposed.** The top-bar collapse kept only the
   lenses that earn chrome (Editor / History) — canvas opens as the node's
   board *inside* the editor (Tana's view-as-node), and graph/tags/tasks/
   timeline demoted to a Places menu rather than strip tabs.
3. **Shipped.** A focused `class_tag` opens to its schema lens in the center;
   TagsMode is deleted; Places → Tags is the capability overview
   (tag × schema × policy × usage). The stale `?view=tags → notes` URL alias
   outlived the overview's return and was removed later (audit fix).
4. **Shipped.** Migration 062 made tasks nodes (`node_tasks` retired as a
   synthesized wire shape); Tasks renders as the live lens over them.
5. **Shipped.** History is one merged lens (This note ⇄ Everything) with the
   version list session-coalesced to match human memory; both restore paths
   ride event-restore.
6. **Shipped with a deliberate design change.** Publishing is the per-node
   `_published` gesture, BUT the gate is **read policy, not a `#published`
   capability tag** (user decision 方案 b: any node carrying a read-restricted
   tag never reaches the snapshot — review×publish decoupled). WebsiteStudio
   still exists as a surface (P4-lite); its full demotion remains open.
7. **Half-shipped.** The two canvases are unified on canvas-as-node
   (migration 057) with sub-canvas splitting; the `hidden` boolean → maturity
   axis replacement has NOT happened and remains open.
8. **Half-shipped.** Capture mints first-class nodes offline-safe (quick
   capture + share-target); the Inbox is the governance queue + capture
   surface, but the "single low-maturity lens (untyped+unconnected)"
   definition is not implemented as specified.
9. **Half-shipped.** ⌘K carries node search, `>`-prefixed action verbs, and
   per-lens commands; frecency/aliases/search-to-create and a rebindable
   shortcut registry remain open.

Shipped beyond this document's scope (same period): canvas wave 2
(multi-select align/distribute, group sections that carry members, toolbar
auto-arrange with undo, JSON Canvas import/export, web-embed cards,
add-existing-note picker), handwriting (perfect-freehand ink on notes/boards/
PDFs, content-addressed like text), the RSS reader module, the RAG ask loop,
agent governance rails (permission templates, approve-before-apply for
publishSite/proposeTagPack, cost stats), split-note-by-headings, the motion
token pass, and the mobile shell (bottom nav, site tabs, Puck mobile chrome).
