# Publishing / output as a gesture vs a mode

> 狀態：歷史紀錄（最後確認 2026-11-01）

> **Historical (2026-06).** Describes Onden as it was then and the design
> argument of that time. Since then publishing has a per-note `_published`
> switch (the note header's Share menu), the site is the last published
> snapshot minus takedowns, and Publish shows a preview first. Current model:
> `docs/architecture/site-render-model.md`.

## Onden today

Publishing in Onden is simultaneously a **peer mode** and a **gesture** — and the
gesture is trapped inside the mode. The result is an architecturally strong
publish pipeline wearing the wrong IA.

**The mode.** `AppTopbar.tsx` exposes five co-equal tabs — Notes / Tags / Tasks /
Website / Timeline — and `useUiMode.ts` encodes them as a flat union
(`type AppMode = "notes" | "tags" | "tasks" | "website" | "timeline"`). Selecting
**Website** swaps the entire workspace for `WebsiteStudio.tsx` (lazy-loaded in
`BuilderApp.tsx`, rendered only when `mode === "website"`). The Studio is its own
sub-application: it has its own segmented sub-views (`pubView`: Design /
Collections / Edit), its own mobile tab set, and its own "page" CRUD that is
really just a thin proxy over node CRUD (`createPage` = `POST /api/nodes`;
`deletePage` = `PATCH hidden:true`; `renamePage` = `PATCH title+slug`). Pages are
not a distinct entity — **they are content nodes** — but you can only see, arrange,
or publish them as a website by *leaving the rest of the workspace behind* and
entering this mode.

**What counts as a page (implicit, not gestural).** There is no per-node "publish
this" control. The publish set is *computed*: every visible content node
(`hidden = false`, `deleted_at IS NULL`) that has **no** `class_tag` carrying a
`tag_schema_id` is automatically a page. This same `NOT EXISTS (... AND
t.tag_schema_id IS NOT NULL)` query runs in both `useWebsiteMode.visibleNodes` and
the backend `/publish` and `/site` routes (`publish.ts`, verified). Class-tagged
nodes (tasks, collection items, the workspace-config node) are excluded. The one
per-node *publishing* knob is the `#page` class_tag (migration 014), which carries
`layout` / `sidebar_ratio` / `slug_override` / `hide_in_nav` as `node_attributes`,
overlaid at read time. Collection items, by contrast, have an *explicit* lifecycle
(`draft` / `published` / `archived`) and only `status === 'published'` rows are
included. So **two contradictory inclusion models coexist**: implicit-by-absence
for pages, explicit-status for collection rows.

**The gesture (trapped).** The Studio's "Publish →" button calls
`useWebsiteMode.publishSite()`, which `POST`s `/api/publish` with
`{title, home_node_id, presentation}`. The presentation manifest bundles template
+ design tokens + site chrome + global Puck blocks. `publish.ts` (admin-only —
`actor.role !== "admin"` is rejected, verified) snapshots all nodes/edges/
published-collections/presentation into `publish_snapshots`, writes a
`PUBLISH_SNAPSHOT_CREATED` domain event marked **`external: true`** (so the
event-sourced restore never tries to undo a deploy), and — in the same
transaction — enqueues a durable `pages_push` outbox intent (`enqueuePagesPush`,
deduped per workspace so a burst folds into one deploy). The URL is derived
synchronously (`expectedPagesUrl`) and returned `{url, queued: true}` with no
network call.

**The deploy (async, durable).** `startOutboxReconciler` drains the outbox;
`performPagesPush` reads the stored static copy (the SSR HTML of every page,
made once per publish — see docs/agents/deploy.md), applies the host's address,
and pushes to GitHub Pages. No external host → no-op, not a failure; transient
failures retry with capped exponential backoff and bury as `dead`.

**One rendering path (since P4/P5).** The Astro SSR pages render the frozen
snapshot; the zip and the Pages push save that same HTML. (The earlier SPA
bundle and the string-template builder are gone.)

**IA weaknesses.**
- Publishing is a *destination you live in*, not a *thing you do to a node*. To
  answer "is this note public?" you must abandon your context and enter the Studio.
- Inclusion is invisible and implicit. A node silently becomes public the moment
  it loses its last schema-bearing tag — the opposite of a deliberate gesture.
- Two inclusion models (implicit pages vs explicit collection status) teach the
  user two different mental models for the same question.
- "Website" as a top-level peer tab violates the node=home thesis: it is a *lens*
  (and a deploy action), not a parallel universe.

## How the field does it

Every studied tool treats publishing as a **gesture attached to the node**, with
inclusion as **declarative opt-in data** on the node and deploy as a **separate
explicit action**. None has a co-equal "Website" workspace mode.

| App | Approach | What's good |
| --- | --- | --- |
| **Tana Publish** | Per-node gesture: right-click → Publish, or Cmd/Ctrl-K → Publish → preview → ship a read-only public link (no viewer account). Two render *lenses* chosen at publish time: **Tana View** (the workspace lens itself — outline, supertags, fields, views) vs **Article View** (static reading page). Reference/transclusion visibility is explicit per reference. *(web-cited; not vendored)* | The closest analogue to node=home + lenses: publishing is just *another lens* on a node, and the workspace view itself can be the published view. |
| **Anytype** | Per-object gesture via a contextual Publish menu (`menu/publish.tsx`, verified): editable per-page slug (`U.String.slug(object.name)`), a publish/unpublish `Switch`, an export item, and a "share space" toggle for shared spaces. Calls `C.PublishingCreate`. Backend (`core/publish/service.go`, verified) exports the object **plus nested objects** (`IncludeNested: true`) → protobuf → JSON → gzipped uber-snapshot (`index.json.gz`), enforces per-tier size limits, filters relations via a whitelist (`relationswhitelist.go`, verified), pushes to a remote publish server keyed by URI (`ErrUrlAlreadyTaken`). `Publish`/`Unpublish`/`PublishList`/`ResolveUri`/`GetStatus` are first-class RPCs. | Publish state is **first-class and queryable on the object** (`GetStatus`, `PublishList`); slug is editable inline; nested-object inclusion mirrors a node's subtree. |
| **AFFiNE** | Per-doc Share menu (`share-menu/share-page.tsx`, verified). A general-access control (`public-page-button.tsx`, verified) flips **No access** (`LockIcon`) ↔ **Anyone, read-only** (`ViewIcon`) via `shareInfoService.enableShare(mode)` / `disableShare()`; `mode` is `PublicDocMode.Page` or `.Edgeless`, **derived from the current editor lens**. Share state is per-doc `LiveData` (`isShared$`), revalidated over a realtime `doc.share-state.changed` subscription (`share-info.ts`, verified) — live, not a snapshot. A separate Export tab offers PDF / HTML / PNG / Markdown (verified). Local workspaces must enable cloud first. *(cloud-gating web-cited)* | Publish status is **live and visible on the node** (reactive `isShared$`); the public render mode follows the lens you're already in (page vs edgeless/canvas). |
| **Notion** | Share → Publish tab → "Anyone on the web with link"; a per-page toggle living in the Share menu, including subpages. **Notion Sites (2024)** upgrades the *same gesture* with site-level settings (custom domain, SEO, link expiration). A page *is* the site. *(web-cited; not vendored)* | One gesture scales from "share a page" to "run a site" — no mode switch; site config is progressive disclosure on the page. |
| **Obsidian Publish** | Inclusion is declarative: frontmatter `publish: true/false` plus folder-level include/exclude rules. The gesture is "Publish changes" → a **diff dialog** of changed/new notes you select, then Publish. *(web-cited; not vendored)* | Clean split: inclusion = data on the note; deploy = a *reviewed* explicit action. |
| **Logseq** | Built-in publishing exports the graph to a self-contained SPA. *Source-verified* (`logseq-master/deps/publishing/src/logseq/publishing/db.cljs` + `html.cljs`): in this DB-graph version inclusion is the **`:logseq.property/publishing-public?`** property on a page (not the legacy text `public:: true`), and there are **two inclusion modes chosen by config `:publishing/all-pages-public?`** (`html.cljs:142-147`): if true, `clean-export!` ships *everything except pages flagged `publishing-public? false`* (implicit-public — "all pages are public unless …false"); if false, `filter-only-public-pages-and-blocks` ships *only pages flagged `publishing-public? true`* (implicit-private). Public pages drag in their blocks, tags, properties and property-values (`get-db-public-ents`). The entry comment (`src/main/frontend/publishing.cljs`) names "two publishing modes" incl. "Built-in sync with GitHub Pages." *(legacy `public::`/`private::` file-graph syntax web-cited; the DB-graph property + dual-mode filter are source-verified)* | Inclusion is data on the node; deploy is a build/zip + optional GitHub Pages push. Notably, Logseq is the **only studied tool that *also* offers Onden's inverted "everything public unless opted out" rule — but as an explicit, user-chosen config, not the silent default.** |
| **AppFlowy** | *Source-verified* (`AppFlowy-main/frontend/rust-lib/flowy-folder/src/entities/publish.rs` + `event_map.rs:45-54`, `event_handler.rs:402-443`). Publishing is a **per-view gesture**, not a mode: `PublishView` / `UnpublishViews` / `GetPublishInfo` / `SetDefaultPublishView` are first-class folder events. `PublishViewParamsPB { view_id, publish_name, selected_view_ids }` — `selected_view_ids` lets you publish a **subtree** in one gesture; `publish_name` is an editable, URL-sanitized slug (`publish_util.rs::generate_publish_name`). `GetPublishInfo` returns a queryable `PublishInfoResponsePB { publish_name, namespace, publisher_email, publish_timestamp_sec, unpublished_at_timestamp_sec }` **read straight off the view**. | The cleanest match to "publish status on the node": publish/unpublish is per-view, the slug is editable inline, a subtree publishes via one `selected_view_ids` payload, and `GetPublishInfo` is an Anytype-`GetStatus`-style read directly on the node. |
| **Trilium** | *Source-verified* (`Trilium-main/apps/server/src/share/shaca/shaca_loader.ts`, `share_root.ts`, `packages/commons/src/lib/builtin_attributes.ts:59-121`, `share/routes.ts`). Inclusion is **structural**: a note is published by living in the recursive subtree under a fixed `_share` root note (`SHARE_ROOT_NOTE_ID = "_share"`, loaded by a `WITH RECURSIVE tree` SQL walk). Per-note publish *policy* is a family of declarative **`share*` attributes on the note**: labels `shareAlias` (slug), `shareRoot`, `shareIndex`, `shareDescription`, `shareDisallowRobotIndexing`, `shareHiddenFromTree`, `shareRaw` (flagged `isDangerous`), `shareCredentials`; relations `shareCss` / `shareJs` / `shareTemplate` / `shareFavicon`. The site is served **live by the running Trilium server** (`share/routes.ts`, `content_renderer.ts`) — no static deploy. | Closest analogue to Onden's `#page` class_tag carrying `layout`/`slug`/`hide_in_nav`: publish config is declarative attributes on the node, and slug/template/css are per-note data. Inclusion-by-placement (subtree under `_share`) is more visible than Onden's inclusion-by-tag-absence. |
| **SiYuan** | *Source-verified* (`siyuan-master/app/src/config/publish.ts`, `app/src/protyle/util/publishAccess.ts`). Publishing is a **workspace-level "Publish service"** — a single `publishEnable` switch + port + addresses in Settings; the kernel server then serves the whole workspace live. Granularity is **per-document access level** set from the doc itself: `public` 🌐 / `protected` 🔒 (password) / `private` 🤫 (hidden+password) / `hidden` 👻 / `forbidden` 🚫, derived from `(visible, password, disable)` in `getPublishAccessLevel`. | The one studied peer that, **like Onden, makes "publish" a workspace-level server toggle rather than a per-node gesture** — but unlike Onden it pairs that with an *explicit, visible per-document access control* on the node, instead of inclusion-by-tag-absence. A useful counterexample to "everyone attaches it to the node." |
| **Joplin** | *Source-verified* (`joplin-dev/packages/app-desktop/gui/ShareNoteDialog.tsx:72,107`; mechanism doc `readme/apps/publish_note.md`). Per-note **right-click → "Publish note…"** gesture (multi-select publishes each separately); the dialog has an `Unpublish note` button and a **`recursiveShare` checkbox — "Also publish linked notes"** (subtree/link inclusion as an explicit opt-in). It is a Joplin-Cloud server-backed share link, not a static deploy. | Confirms the per-node publish-gesture + opt-in subtree pattern from a vendored source; inclusion (which notes) and link generation are one deliberate action, with a visible publish/unpublish toggle on the note. |
| **Quartz** | Static-site generator over a markdown vault. `ExplicitPublish` forwards only `publish: true` pages; `RemoveDrafts` strips WIP. Common pattern: tag `#publish` in a note, run `make deploy` (copy → build → push to GitHub Pages). *(web-cited; not vendored)* | Inclusion = a tag/property; deploy = a CLI gesture. **Direct precedent for Onden's GitHub Pages push** — and notably uses a *tag* (`#publish`) as the inclusion signal. |

## The gap

1. **Mode vs gesture.** Onden is the only system that makes publishing a co-equal
   workspace *mode*. Everyone else attaches it to the node (Share/Publish menu,
   Cmd-K command, or frontmatter property). Onden already proxies "pages" to nodes
   — so the mode is a UI shell with no entity behind it.

2. **Implicit vs explicit inclusion.** Onden's "every untyped visible node is
   automatically public" rule is *inverted relative to the field's norm and
   silent*. Almost every studied tool makes inclusion **opt-in and visible on the
   node** (AFFiNE toggle, Anytype switch, AppFlowy `PublishView`, Trilium placement
   under `_share` + `share*` attributes, SiYuan per-doc access level, Quartz
   `#publish` tag, Obsidian frontmatter, Logseq `:logseq.property/publishing-public?`).
   The one precedent for an *inverted* rule is **Logseq's `all-pages-public?` mode**
   (source-verified, `html.cljs:142-147`) — but there it is an **explicit, opt-in
   config** the user knowingly selects, not a silent default coupled to typing. The
   real defect in Onden is therefore not "inverted" per se but **silent + coupled**:
   *adding governance/typing removes a node from the site* as an invisible side
   effect, and the user can't see either decision on the node.

3. **Publish status is not on the node.** Anytype (`GetStatus`), AFFiNE
   (live `isShared$`), and AppFlowy (`GetPublishInfo` → `publish_name` / `namespace`
   / `publisher_email` / `publish_timestamp_sec`, source-verified) all let you read
   "is this published, by whom, when, at what slug?" *from the node*. In Onden you
   must enter the Studio and infer it from a computed list.

4. **Two inclusion models, two renderers.** Pages (implicit) and collection items
   (explicit status) disagree; the SPA `SiteTemplate` and the server `renderBlock`
   string builder duplicate render logic. The field tends toward *one* inclusion
   rule and *one* render path (AFFiNE reuses the editor component verbatim, as
   Onden does for the SPA path).

5. **Where Onden is already ahead.** The actor-attributed, `external: true`,
   outbox-driven, idempotent, frozen-snapshot deploy is *more* robust than most
   field tools (it survives the event-sourced restore and folds bursts into one
   deploy). The architecture is right; the **surface** is wrong.

## Recommendation for Onden

**Kill "Website" as a peer mode. Make publishing a gesture on a node, plus a
publish-lens and a deploy action — all framed by the node=home / lens / maturity
thesis.**

1. **Publish is a gesture, attached to the node.** Replace the topbar tab with a
   per-node **Publish** action (node context menu + Cmd-K → "Publish this node /
   its subtree"). This matches Tana, Anytype, AFFiNE, Notion — and is exactly
   AppFlowy's `PublishView`+`selected_view_ids` and Joplin's right-click "Publish
   note… / Also publish linked notes" (both source-verified). The home node's
   publish gesture *is* "publish the site"; a leaf node's publish gesture is
   "publish this page." No new entity needed — pages are already nodes.

2. **Make inclusion explicit and tag-driven — because a tag is a node.** This is
   the thesis-native move. Inclusion should be **opt-in via a `#published`
   capability tag** (Quartz's `#publish` and Onden's tag=node=class model converge
   exactly here). Adopting a publish tag means: inclusion is *visible on the node*,
   it is *actor-attributed and auditable* (it flows through the spine like every
   mutation), and the class_tag can carry the publish policy/schema (slug, layout,
   nav visibility — exactly what `#page` already does, and exactly what Trilium's
   per-note `shareAlias` / `shareDescription` / `shareTemplate` attributes do,
   source-verified) as `node_attributes`. This
   **decouples typing/governance from publication**: today, tagging a node *removes*
   it from the site as a side effect; with explicit `#published`, governance and
   publication become independent, deliberate decisions. Collection items' existing
   `status` lifecycle becomes a *special case* of the same explicit model rather
   than a second one.

3. **Publishing is the maturity end of the loop, not a fork off it.** In the
   capture → diverge-on-board → converge-in-notes loop, *publish* is the act of a
   node reaching outward-facing maturity. Surface it as a **lens** on the node:
   selecting the "published" / "site" lens shows the node *as the public reader
   will see it* (this is precisely Tana's Tana-View-vs-Article-View and AFFiNE's
   lens-derived `PublicDocMode`). The in-app Preview already uses `SiteTemplate`
   verbatim — promote that from a Studio sub-view to a first-class **lens** in the
   same lens switcher as canvas / graph / table / inbox / timeline. The Design /
   Collections / Edit sub-views of the Studio dissolve into: the published *lens*
   (what readers see), the node's own edit lens, and node-level publish *settings*.

4. **Publish state lives on the node and is queryable.** Add a `GetStatus`-style
   read (is this node published? what URL? what was the last deploy event?) that
   renders *on the node* — backed by the existing `publish_snapshots` and the
   `PUBLISH_SNAPSHOT_CREATED` events. The audit trail already exists; expose it at
   the node, not in a separate studio.

5. **Keep the deploy machinery; reframe its trigger.** The outbox /
   frozen-snapshot / GitHub Pages pipeline is a strength — keep it. The deploy
   becomes an explicit **"Publish changes" action** (Obsidian-style), ideally with
   a diff of which nodes' published lens changed since the last snapshot, so
   "inclusion (data on the node) vs deploy (an explicit action)" are cleanly
   separated as in every field tool. Long-term, collapse the two renderers onto
   the single `SiteTemplate` SPA path to kill the duplicate `renderBlock` logic.

**Net:** Website stops being a place you go and becomes something a node *is* (a
`#published` capability), something you *see* (the published lens), and something
you *do* (the publish-changes deploy gesture) — one unified mental model, fully
inside node-space, fully on the spine.
