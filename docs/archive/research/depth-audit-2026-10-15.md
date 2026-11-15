# Depth audit — 2026-10-15 (main a33aa302)

> 狀態：歷史紀錄（最後確認 2026-11-01）

Owner: note-0d. Loop task from the user: 「不中斷 你負責檢查是否有不夠深得模組發給其他session給你檢查」.
I measure, write the packages here, hand them to other sessions, and review and merge their PRs.

## How it was measured

- Per directory: implementation lines against the names used from outside it, plus imports of internal files that skip `index.ts`.
- Per file: lines of code per exported name used elsewhere.
- Knowledge spread: for each table, how many non-test files `INSERT`, `UPDATE` or `DELETE` it.

The directory entries are now clean. A1–A3, B1 #168 and #170 removed the leaks, and nothing imports past an `index.ts`. The shallow spots left are **concepts with no owner**: several files each repeat the same row shape and the same rules.

| table | non-test files writing it |
|---|---|
| content_nodes | 34 (12 of them `INSERT`) |
| node_attributes | 8 |
| node_tags, node_edges, spaces, workspaces | 5 each |

## D1 — creating a tag, and writing its schema, has no module

`createNote` owns note creation (`services/noteCreate.ts`, guarded by `test/noteCreate.test.ts`). Tags have nothing like it. Eight files write their own `INSERT INTO content_nodes … 'class_tag'`:

- `routes/tags.ts:397` (`POST /tags`)
- `services/tagHierarchy.ts`
- `services/tagPacks.ts:154` (pack import)
- `services/reservedTags.ts` `ensureReservedTag`
- `services/collections.ts` `createCollectionClassTag`
- `services/workspaceModules.ts`
- `services/siteConfig.ts`
- `modules/citations/papers.ts` `ensurePaperTag`

Each copy decides for itself how to pick the slug, how to handle name conflicts and reserved keys, which columns to fill (`tag_color`, `tag_schema`, `reserved_key`), and which event to emit. A rule added to one path, such as the tag-name conflict or `reserved_key` handling, has to be added to all eight.

`tag_schema` is the same. Six writers set it directly:

- `routes/tags.ts:263`
- `routes/collections.ts:185`
- `services/tagModules.ts:193` and `:260`
- `services/workspaceModules.ts:160`
- `services/eventRestore/tags.ts:144`

They mix replace (`= $3`) and merge (`||`), and the merge into the stored schema is not validated.

**Package D1:**
- Add `services/tagCreate.ts` with `createTag(input)` / `ensureTag(input)`. It is the only place that picks the slug, checks name and reserved-key conflicts, fills the columns and emits the event.
- Add one `writeTagSchema(tagId, next | patch)` that validates the schema and is the only `UPDATE … tag_schema`.
- Move all eight inserts and six schema writers onto them.
- Add a guard test in the style of `noteCreate.test.ts`: any other `class_tag` insert or `tag_schema` write fails the test.

The behaviour stays the same. When two paths differ today, keep the stricter rule and write the choice into the PR.

## D2 — routes still write SQL

These routes contain their own `INSERT`/`UPDATE`/`DELETE`:

| route | writes |
|---|---|
| `routes/canvases.ts` | 2 (title, updated_at) |
| `routes/boards.ts` | 2 |
| `routes/edges.ts` | 3 |
| `routes/tasks.ts` | 1 (title) |
| `routes/nodes.ts:247` | 1 (hidden=false) |
| `modules/rss/routes.ts` | 8 |

D1 takes the writes in `routes/tags.ts` and `routes/collections.ts`.

The route then holds both the HTTP layer and the row rules, so the agent tools and the importers cannot call the same operation.

**Package D2:**
- Move each write into the service that owns that row (`boardStore`, `tasksStore`, a canvas service, `nodes`/edges, `modules/rss` service files). The route keeps only parse → call → respond.
- Add a lint rule in the style of `require-read-gate` that forbids SQL write keywords inside `routes/**` and `modules/*/routes.ts`. It starts with an allowlist, and the allowlist must be empty when D2 is done.

## D3 — two note-insert exceptions miss the note's derived state

`test/noteCreate.test.ts` allows `noteDuplicate.ts` and `templateExpander.ts` to keep their own inserts. Both still create a **user note**, and both handle createNote's derived-state step (backup enqueue, wikilink edges, block ids, content hooks) badly:

- `noteDuplicate.ts:146-150` copies that list by hand, so it drifts whenever createNote gains a step.
- `templateExpander.ts:151-156` does none of it. A template child that has `slot.body` gets no backup, no block ids, no wikilink edges and no embedding until someone edits it.

**Package D3:** split the "after a note row exists" step out of `createNote` (for example `finishNewNote(tx, node)`) and call it from both exceptions. Their own reasons for skipping the dispatcher or using cascade authority stay as they are. The test list should then say what each exception still skips.

## Frontend — no package this round

All writes go through `lib/data` (only `useAppData` sends a method). `localDb` is used almost only from `lib/data`; the two leaks are `modules/skills/SkillRunDialog.tsx` and `lib/ink/store.ts`, which read attributes directly, and they are small enough to go into the next round. The big files are `MarkdownEditor.tsx` (1203 lines), `OverviewSidebar.tsx` (900), `KnowledgeWorkspace.tsx` (855) and `useAppData.ts` (850). They are next round's candidates, after a complexity measurement.

## Assignment

Filled in as the sessions accept.

| package | session | PR |
|---|---|---|
| D1 | note-0d (nobody free); reviewed by note-3f | #184 merged 84b56695 |
| D2 | note-87 (reassigned from note-17) | #194 merged f1c728fa |
| D3 | note-87 | #179 merged b18278da |
| D4 | note-87 | #186 merged dd4bd09d |
| D5 | note-0d (note-3f declined); reviewed by note-87 | #187 merged cc25ea53 |
| D6 | note-87 | #188 merged e389b5a3 |
| D8 | note-87 | #190 merged bc49e94c |
| D9 | note-87 | #191 merged 12c37fff |
| D11 | note-17 | #196 merged 7de123d1 |
| D12 | note-87 | #197 merged 904bc15d |
| D13 | note-87 | #201 92bbd218, #202 afb498fc, #203 c212d632 merged |
| D10 | note-87 | #192 merged 8451cd29 + #193 bootstrap read snapshot merged 91efe44e |

## Round 2: frontend prop chains (2026-10-15, main b18278da)

The two largest frontend components are not deep. Each takes a wide, flat list of props, and the layer above it only re-packs those props.

### D4: the sidebar takes 40 flat props through a pass-through layer

`components/workspace/WorkspaceSidebar.tsx` (88 lines) receives grouped objects: `inbox`, `drag`, `rename`, `lifecycle`, `creation` and `nav`. It then flattens them into 40 separate props for `components/OverviewSidebar.tsx`, which is 900 lines long and has no other caller. The only real work in `WorkspaceSidebar` is giving the handlers stable identities and shaping the context-menu argument.

**Package D4:**
- `OverviewSidebar` takes the groups directly. Its props stay grouped down to the sub-parts that use them.
- The stable-identity wrapping happens once, where the groups are built.
- `WorkspaceSidebar` is either deleted or kept as a thin mount.
- Split `OverviewSidebar` by section (tree, inbox, quick-create, group controls) only where the split makes each part's interface smaller.

Behaviour stays the same. The memo/H4 re-render hygiene must hold: check it with React Profiler or the existing render-count tests.

### D5: KnowledgeWorkspace takes about 45 props, mostly canvas callbacks

`components/KnowledgeWorkspace.tsx` (855 lines) has one caller, `BuilderApp.tsx:347`. About 35 of its props are canvas operations, for example `onApplyPositions`, `onTidyCanvas`, `onArrangeTree`, `onGroupSelection`, `onSetNodesColor`, `onConnect`, `onParentConnect`, `onEdgeDeleted`, and the canvas create, delete and rename callbacks. H4 already moved the data into the app store. The operations are still passed in one by one.

**Package D5 (corrected):** the operations already live in one module, `hooks/useCanvasActions.ts`, which `useBoardWorkspace` wraps (A2). The shallow part is that `BuilderApp` spreads `{...board.boardProps}` into `KnowledgeWorkspace` as about 35 flat props. Give it the same treatment as D4 (#186):
- `KnowledgeWorkspace` takes grouped objects, or reads the groups from `useBoardWorkspace` itself.
- Each group is stabilised once.

Coordinate with the open PRs that touch these files: #170 (ui entry imports), #167 (B2a, editor) and #165.

### D6: the sync engine lives outside the data module

`lib/useAppData.ts` (850 lines) is not really a hook. It is the module-level sync engine: bootstrap and refresh, `sync()`, membership reconcile, `hydrateNode`, the offline body download and the user-folder export. It imports 22 functions straight from `lib/localDb`.

`lib/data` is meant to be the one data module, and A2 narrowed its entry. But the sync half sits beside it, and 12 components and hooks import `refresh`, `sync`, `hydrateNode` and friends from `lib/useAppData`. `localDb` is also read directly by 8 files outside `lib/data`:

- `useAppData`
- `ink/store` (attributes)
- `SkillRunDialog` (attributes)
- `useOverviewSearch`, `noteSearch` (search)
- `localBackup`, `settings/registry` (export and import)
- `pendingNoteProjection` (types)

**Package D6:**
- Move the engine into `lib/data`, for example as `lib/data/syncEngine.ts`, exported through `lib/data/index.ts` as one small surface (`dataSync` already exists, so extend it rather than add names).
- `useAppData()` keeps only the React lifecycle wiring.
- Route the attribute reads, the local search and the export/import through `lib/data`.
- Add a lint rule (or extend `module-entry`) so that only `lib/data/**` imports `lib/localDb`.

Behaviour must not change, especially sync ordering, the membership epoch and slim mode. The sync tests and the `:5099` e2e sync specs are the guard.

### D7: the editor host is an adapter of closures (waits for #167)

`OverviewEditorHost` → `OverviewEditor` (23 props) → `MarkdownEditor` (17 props).

Most of `OverviewEditor`'s props are one of two kinds:
- store data that `useAppSelector` can read: `tags`, `nodes`, `online`, `attrClassTags`, `allTags`;
- inline closures that call a `lib/data` singleton with `node.id`: `drafts.type`, `drafts.save`, `propertyWriter.set`, `taskWriter.create`, `nodeMutations.extractToEntity`, `refresh`.

The A2/H4 design says components import the writers instead of threading them. Because the closures are inline, `OverviewEditor` gets new props on every host render.

**Package D7:**
- `OverviewEditor` reads the store and calls `lib/data` itself. Its props shrink to the note, the view and the shell callbacks (open wikilink, activate tag, create first).
- `OverviewEditorHost` either disappears or becomes the mount.

**Blocked:** #167 (B2a block chips) touches `OverviewEditor` and `MarkdownEditor` and is waiting for the user. Start D7 after it lands.

### Checked and left alone

- `node_attributes`: it has 8 writers, but `attributeChange.ts` is the gate. `test/attributeWriters.test.ts` lists the 7 raw writers with their reasons (restore, rss bookkeeping, site config, task rows, scheduler, import stamp, board sections). That is already a deep module with explicit exceptions.

## Round 3 (main 16a1c5f1)

### D8: the sync protocol lives in a route

`routes/sync.ts` (607 lines, 15 queries) holds the server half of sync inside its HTTP handlers:
- the delta builder, `handleSync`, about 340 lines: event replay, upserts limited to the reader's read set, and the revocation diff against the client's `known` ids;
- the edge and pointer rows touching a delta;
- the membership version;
- `/bodies` and `/nodes`.

`services/syncProjection.ts` holds only the column lists. Because of this, the security-critical rule ("readableNodeIdSet is the only input to both the upsert filter and the revocation diff") can only be reached and tested through HTTP, and nothing else (SSE, an agent tool, the integration tests) can build a delta.

**Package D8:**
- Move the protocol into `services/syncDelta.ts` (or a `services/sync/` directory with an `index.ts`): `buildSyncDelta(actor, workspaceId, { since, known })`, `membershipVersion`, `bodiesFor` and `nodesFor`.
- The route keeps only parse → call → respond. Behaviour stays byte-for-byte the same.
- Add direct unit or integration tests of `buildSyncDelta` for the revocation diff, without HTTP.

### Checked and left alone (round 3)

- Publishing selection: snapshot, the served site and collections all go through `publishedNodeIds` / `publishedCollectionItemIds`, which intersect `publiclyReadableNodeIds`. This is already one owner.
- The comment in `services/publishing/collections.ts:135` about keeping the predicate "identical to the snapshot builder's PUBLISHED_NODES" is stale, because that SQL is gone.
- The website module's `touchesSite` is a looser trigger heuristic. Over-triggering a rebuild there is safe.
- Candidates for later: `routes/actors.ts` (507 lines, 19 queries, members and tokens) and `modules/review/routes.ts` (21 queries) also keep their logic in the route.

### D9: members and tokens are orchestrated in the route

`routes/actors.ts` (507 lines, 19 queries, 10 handlers) holds actor create, patch and delete, token mint, re-scope, revoke and delete, and stats. Each handler has its own validation (`invalidSpaceIds`, template expansion, scope checks) and its own `mutate()` call. `services/agentTokens.ts` and `services/memberRemovals.ts` only do the row work.

These are permission-defining operations (`principal_admin`), but the rules about what a token may be scoped to, and what removing a member ends, live in HTTP handlers. Agent tools and tests cannot call them.

**Package D9:**
- Add `services/actors.ts` (or `services/members/`) with `createActor`, `updateActor`, `removeActor`, `mintToken`, `rescopeToken`, `revokeToken`, `deleteToken` and `actorStats`. Each one does its own `principal_admin` check and validation.
- The route keeps parse → call → respond. The early principal gate before any lookup (no 404-vs-403 probe) must stay in front.
- Status codes and response bodies stay the same.
- Update `spineGate.test.ts`'s `actors` principal_admin count to the new file.

`modules/review/routes.ts` (21 queries) is a module-internal route+domain mix. It is lower priority because the module is self-contained.

## Round 4 (main 12c37fff)

### D10: the bootstrap read model and workspace settings live in the app entry

`packages/backend/src/index.ts` is 825 lines. Besides wiring the app (auth, middleware, routers), it holds:
- `GET /api/bootstrap` inline, lines 359–595, about 236 lines: the event cursor read before any row, the actor's read set, the slim-body mode, nodes, edges, tags, tasks, recent events and settings. This is the first-load read model, the twin of the sync delta that D8 moved to `services/sync/`.
- `PATCH /api/workspace`, `PATCH /api/workspace/modules`, `GET` and `PATCH /api/workspace/config`, and the handler and edge manifests.

The read-gate lint names `index.ts` as a gated file, so the security rule for the biggest read in the app lives in the entry file, next to auth setup. Like the sync delta before D8, it can only be tested through HTTP.

**Package D10:**
- Move the bootstrap into `services/bootstrap.ts` (or `services/sync/bootstrap.ts`, next to the delta, since they share the cursor contract): `buildBootstrap(actor, workspaceId, { slimBodies })`.
- Move the workspace routes into `routes/workspace.ts`, with their logic in a service where there is any.
- `index.ts` keeps app wiring only.
- Responses stay byte-identical; use the same side-by-side check as D8 and D9.
- Move the read-gate and event-read lint entries to the new files.

## Round 5 (main f1c728fa)

### D11: reads skip the data layer

Writes go through `lib/data` (lint: `writes-through-data`), and since D6 so does the local copy. Reads do not. About 25 core frontend files call `api()` / `apiFetch()` with a literal `/api/...` URL and parse the response themselves. Examples:
- `TrashView`, `TimelineView`, `TodayLens`, `NodeAttributesPanel`, `SchemaLens`, `InboxReview`, `FailedDeliveries`, `AllCardsGraph`, `SideDrawers`, `TokenManager`, `RestorePreviewModal`;
- `AiKeySetting`, `AiModelSetting`, `settings/registry`;
- `useDueSoonNotifications`, `useLiveEventLog`, `useOverviewMode`, `noteSearch`, `serverMerge`, `canvasExport`, `noteExport`, `lib/spaces`, `ink`.

The most-hit endpoints are `/api/nodes` (14), `/api/bootstrap` (11), `/api/tags` (7), and `/api/events`, `/api/actors`, `/api/spaces` (3 each).

So each view knows URLs, response shapes, the offline fallback (or forgets it), and its error codes. A server-side rename touches N components, and the offline behaviour of reads differs from view to view.

**Package D11:**
- Add a `reads` group in `lib/data`: typed functions per server read (node history and versions, trash, timeline/day, events, the actor and token list, spaces, AI settings and so on), using the existing `queryCache` dedupe where it fits.
- Core components and hooks call those functions.
- Add a lint rule: `api` / `apiFetch` / `postRead*` may be imported only by `lib/data/**`, `lib/api.ts` itself and `modules/*/` (a module owns its own endpoints: rss, review, skills, citations, website), plus a documented allowlist for boot and auth plumbing.
- Behaviour stays the same. Where a view had an offline fallback, the read function keeps it.

### Checked and left alone (round 5)

- `settings/registry.tsx` (892 lines) is a registry of `SettingDef`s plus several widgets in one file. Splitting it is file organisation, not depth, because the registry interface itself is narrow.

## Round 6 (main 7de123d1)

### D12: split and merge live in a view hook, which patches the store itself

`hooks/useOverviewMode.ts` runs the whole note split (`splitNote…`) and merge (`mergeChildrenIntoNote`) operations:
- it reads missing child bodies;
- it calls `drafts.beginRewrite`, the `noteStructure.*` writes, and `rewrite.adopt`;
- it then patches the store with `setData(...)` (lines 134 and 191: the parent's markdown and the removed children).

`lib/data` owns the writes (`noteStructure`) but not the operation. As a result, the store patch that must match those writes, and the "parent first, then delete; a failed delete only leaves a duplicate" rule, live in a UI hook.

There are two more `setData` calls outside `lib/data`:
- `modules/website/WebsiteScreen.tsx:52` (`collections`);
- `modules/website/CollectionsManager.tsx:360`, which is a local state name and not the store.

**Package D12:**
- Move split and merge into `lib/data` as `noteStructure.splitNote(node, plan)` and `noteStructure.mergeChildren(node)`. They own the body reads, the rewrite session, the writes, the store patch and the outcome (counts and failed ids).
- The hook keeps only the UI: confirming, toasts and focus.
- Have the website's collections change go through a `lib/data` setter, or have the website module own its collections state.
- Add a lint rule (or extend `writes-through-data`) so that `setData` from `lib/appStore` is called only inside `lib/data/**`.
- Behaviour stays the same. The existing split/merge tests are the guard.

## Round 7 (main 2d935e7, everything above deployed)

### D13: the remaining fat handlers

D2 took the writes out of routes, and D8–D10 took out the sync and bootstrap read models. These handlers still hold a read model or a whole operation (lines per handler):

| handler | lines | what it holds |
|---|---|---|
| `routes/inbox.ts` GET `/` | 196 | the governance queue: grouping, facets, filters and `eventVisibleSql` before the 500 cap |
| `routes/import.ts` POST `/obsidian` | 125 | the vault import orchestration |
| `routes/tasks.ts` PATCH `/:id` | 122 | the task update rules |
| `modules/rss/routes.ts` POST `/items/:id/save` | 112 | feed item → note |
| `routes/day.ts` GET `/:date/lens` | 110 | the day lens read model |
| `routes/tags.ts` POST `/import` | 107 | pack import; the insert is in `tagPacks` since D1, the gates still in the route |
| `routes/export.ts` GET `/markdown.zip` | 100 | the export builder |
| `routes/ai.ts` POST `/ask` | 96 | |
| `routes/query.ts` POST `/` | 92 | |
| `routes/tasks.ts` GET `/agenda` | 78 | |

**Package D13** (core routes first; the rss save is a module and can follow):
- Move each into a service: `services/inbox/queue.ts`, `services/dayLens.ts`, `tasksStore`/`taskUpdate`, `services/importObsidian.ts` (or next to `importMarkdown`), `services/exportZip.ts`, `services/query.ts`, `services/taskAgenda.ts`, and the tag-pack import gates into `tagPacks.installTagPack`.
- Routes keep parse → call → respond.
- Responses stay byte-identical; use the side-by-side check.
- Lint entries (read gate, EVENT_READS, principal counts) follow the code.
- It's fine to split this into two or three PRs.

## Round 8 (main 8cb3f40e) — owner now note-79

note-0d's session ended; note-79 took over the loop (「不中斷 你負責檢查是否有不夠深得模組發給其他session然後你來修」). No other Onden session is running, so I fix the packages myself or hand them to subagents in their own worktrees.

Backend table spread is now small (content_nodes 24 writer files, all services; class_tag inserts 0). The shallow spots left are **grammar and lookup rules copied across packages** and a few frontend pass-through chains.

### D14: the website studio takes 28 flat props
`WebsiteScreen` unpacked `useWebsiteMode()` into 28 props for `WebsiteStudio` (705 lines). Two different "what is a page" filters (hook vs studio). **PR #205** (includes #181 rebased): grouped `WebsiteSite`, Design tab in `WebsiteDesignPanel`, one page filter, dead presentation writer removed.

### D15: "module tag" lookup rebuilt per module
`services/tagModules.ts` owns "a tag provides module X" (incl. `extends`), but the `inUse` checks of review, skills, read_later and citations inline their own SQL and ignore `extends`. `citations/papers.ts` `ensurePaperTag` re-implements `workspaceModules.ensureModuleTag` with a case-sensitive match. **Package:** `moduleInUse(ws, id)` / `findModuleTag` in tagModules; delete the 4 SQL copies.

### D16: note-text grammar kept in sync by comments
Wikilink scanner duplicated in `backend/src/utils.ts` and `frontend/src/lib/textScan.ts` ("must find exactly the same links"), plus 5 ad-hoc `[[…]]` regexes; hashtag grammar in 5 places; link-target resolution differs (backend: title/slug/aliases in space; frontend `nodeMatchesLink`: no aliases, different slug rule). **Package:** `@onden/markdown` owns the scanners and one `linkKey()` normaliser.

### D17: frontmatter has 7 fence regexes and 3 codecs
The renderer's lazy regex closes on a mid-line `---`, the indexer needs it on its own line, so the page hides different text than what is indexed; `utils.ts` excerpt only handles `\n`. **Package:** move `backend/services/frontmatter.ts` (no backend deps) into `@onden/markdown` and use it everywhere.

### D18: node lifecycle actions pass through 5 layers
`nodeMutations` → `useAppData` re-export → BuilderApp renames → `useNodeLifecycle` (20 params, 5 `*Raw`) → `WorkspaceContextMenu` re-pack → `ContextMenu` (19 props). `OverviewEditorHost` calls `nodeMutations` directly: two paths for the same actions. **Package:** one id-keyed `nodeActions` (lookup, selection clear, toast) that ContextMenu reads directly.

### D19: localStorage has no owner
59 direct calls in 26 files; `lib/safeStorage` used by 2. Four copy-pasted persisted-boolean hooks, three without try/catch. Stores holding node ids (frecency, pinned tag views, last location, due-soon) are not account-scoped. **Package:** `lib/prefs.ts` (typed keys, device/account scope, `usePersistedFlag`) + lint ban on raw `localStorage`.

### D20: the slug rule is copied (re-scoped)
Checked the tag name → id lookups first: only the RSS module repeats one ("title → the one tag, else ambiguous", `rss/save.ts` and `rss/routes.ts`); the others are different questions (a search filter, a rollup filter, a reserved-key adoption) and stay. The real spread is the **slug rule**: backend `utils.slugify`, `templateExpander`'s own ASCII-only copy (a CJK template child became `child`), two copies of a dash-keeping variant for collections, and four optimistic slugs in the app (`noteWriter` ×2, `pendingNoteProjection`, `tagWriter`, the last ASCII-only). **Package:** `slugify` moves to `@onden/markdown` and every one of them uses it.

| package | who | PR |
|---|---|---|
| D14 | note-79 | #205 (contains #181; reviewed, fix pushed) |
| D15 | note-79 | #206 (reviewed, fix pushed) |
| D17 | note-79 | #207 |
| D19 | subagent of note-79 | #208 |
| D20 | note-79 | #209 |
| D16 | note-79 | #210 (stacked on #209) |
| D18 | subagent of note-79 | #211 |

Merging: the user merges (my session cannot approve its own PRs).

Status 2026-10-16: #205–#209 and #211 merged (main 5e9cd8ab); #210 is open, already based on main.

## Round 9 (main 5e9cd8ab) — owner now note-59

note-79's session ended; note-59 continues the loop. Main 5e9cd8ab passes backend and frontend tsc, frontend lint, frontend unit tests (319 files, 2317 tests) and markdown unit tests (43).

### D21: each writer picks the attribute storage type
Six rules turn a field type into `value_type`: `collections.ts` and `attributes/utils.ts` map rating to number, `fieldDefaults.ts` maps only number and date, `MarkdownEditor.tsx` has a copy without rating, `TableLayout.tsx` and `siteConfig.ts` guess from the value. The backend stores whatever it receives (`routes/nodes.ts` defaults to text). The typed sort (`collectionViewQuery.ts`) and filters (`filter/sqlClauses.ts`) keep only rows typed `date` or `number`, so **a date edited in a table drops out of date filters, and a rating set in the editor drops out of numeric ones**. The date grammar has about 6 copies; `schemaValidation.ts` accepts 2026-13-45. **Package:** one `attributeValue` module (`storageType`, `normalize`, `inferFromValue`, `isCalendarDate`); the backend derives the type from the schema field.

### D22: review scheduling lives in the route
`modules/review/routes.ts` (419 lines, 13 queries) holds layering, budgets, enrolment, the subtree walk and queue assembly; the agent tool imports from `routes.js` and builds a different queue (every new card, new first, no cap). Settings ranges are written 4 times plus once in the app. **Package:** `review/service.ts` with `queue`, `stats`, `decks`, `grade`, `undo` and one settings schema; route and tool both call `queue`.

### Later this round
- **D23 media:** the `/api/media/<id>` regex is copied 4 times (plus 2 variants), the app has 3 `resolveMediaSrc` copies that disagree on `data:` and `media/`, and storing a file is done two different ways (`routes/media.ts`, `importedImages.ts`). Package: `mediaRefs`/`rewriteMediaRefs`/`mediaSrc` in `@onden/markdown`, `services/media.storeMedia`.
- **D24 block anchors:** the `^id` grammar has 6 copies and the backend index (`blockIds.ts`, line scan, only ``` fences) can disagree with the mdast parser. Waits on #164, #165, #167 and #210.
- **D25 tree walks:** the subtree CTE is written 4 times with different filters, the cycle check twice, the `triggered_by` chain walk 4 times with different limits. Package: `services/nodeTree.ts` and `eventChain`. After D22 (review shares a subtree walk).
- **D26 connectivity:** `useAppData.ts` runs the online/reconnect state machine inside a React hook. Package: `dataSync.attachConnectivity(window)`.

### Checked and left alone (round 9)
- The space rule has one owner (`spaceScope.ts`). Small leaks: `services/spaces.ts:86` re-queries writable spaces, and `spine/authority.ts:171` has its own role rank table.
- AI plumbing (`harness/gateway`; `lib/aiErrors`, `aiRun`), module registration, the 7 frontend stores, local dates, `OverviewSidebar` (8 grouped props).
- `SkillRunDialog` and `ink/store` already go through `lib/data`.

| package | who | PR |
|---|---|---|
| D21 | subagent of note-59 | #216 (three review rounds; migration 105) |
| D22 | subagent of note-59 | #212 (reviewed: ok) |
| D23 | subagent of note-59 | #214 (security review: ok after fixes) |
| D25 | subagent of note-59 | #215 (reviewed: ok) |
| D26 | subagent of note-59 | #213 (reviewed: ok) |

## Round 10 (main 7f14e4c4) — scan by note-1d, coordinated by note-59

Tag-area series T1–T15 is note-a3's (merged #217–#222, more open). Round 10 avoids files in open PRs.

- **D27 (S, bug), #231 (reviewed: ok):** Notion row bodies are written by a bare `UPDATE content_nodes SET markdown` (`importNotionDatabase.ts:286-312`), the only raw body writer left: no wikilink edges, block ids, embedding, backup or frontmatter attributes, and no inverse patch, so undo doesn't revert the body. Package: `makeInversePatch` + `applyBodyChange` like `importMarkdown.ts`, plus a guard test. **note-1d, now.**
- **D28 (M, bugs):** the local search index (`nodes_fts`) has 5 hand-written maintainers. `forgetBody` blanks a refused body but leaves its text searchable (looked like a read-policy leak, but note-1d checked the runtime: the bundled sql.js has FTS3 only, so `CREATE VIRTUAL TABLE … USING fts5` fails into its catch, `nodes_fts` never exists, the 5 writers are dead code and search always falls back to `LIKE` on `nodes`, which `forgetBody` already blanks — no leak today; D28a dropped), slim delta rows skip the reindex (a rename keeps the old title), and the sidebar search uses `localCopy.search` + Fuse while the palette uses the server (so `#book status:reading` only works in the palette). D28b waits on #167: either delete the dead FTS5 code or ship an FTS5 build and fix the stale-index paths together; move the sidebar onto `reads.notes.search`; keep note-1d's offlineBodyCopy test as the net.
- **D29 (M), D29a = #233 (reviewed: ok; also fixes the learner `access` token leaking into canonical/og:url):** the published `<head>` is built 4 ways (`SiteHead.astro`, `seoFiles.ts`, `staticBuilders.ts` ×2) and they disagree on lang and og:type; the zip export has no description, canonical, favicon, OG or **robots** — a site with indexing off becomes indexable once its zip is hosted. Package: pure `siteHead()` + `siteLang()` in `@onden/markdown`. seoFiles + SiteHead first; staticBuilders after #183/#175.
- **D30 (S, bug):** the editor's checkbox → task uses its own `CHECKBOX_LINE_RE` (only `-`/`*`), not `lib/taskLines.ts`: `+ [ ]`, `1. [ ]`, quoted boxes can't convert; a `- [ ]` inside a code fence is offered Mod-Shift-Enter; tick hits the first text-equal line. After #216.
- **D31 (S):** four event views each have their own event-type vocabulary (colours already disagree). `lib/eventKinds.ts`. After #226.
- **D32 (S):** the space-role rule is encoded 5 times. One `SPACE_ROLES`/`spaceRoleAtLeast`/`WRITE_ROLES_SQL` in `spaceScope`. After #215.
- **D33 (M):** `eventRestorable` is a front-end deny list, so about 47 emitted event types show Restore and then return 422. Package: the server sends `restorable` per event from the same inspect rule, replacing `lib/eventRestorable.ts` (#226). note-a3 takes it after #228 merges.

Checked and left alone (round 10): backend event-log readers (one rule, all 21 classified by lint), export/import key sets (guarded by a round-trip test), Obsidian import and backend search (one owner each), KnowledgeWorkspace (11 props), the rest of MarkdownEditor (size, not leaks). 

Round 10 status (main 981adc09): D27 #231, D29a #233, D30 #246, D31 #237, D32 #245, D33 #241 merged; review subtree → nodeTree #244. D24 and D28b still wait on #164/#165/#167.

## Round 11 (main 981adc09) — scan by a read-only agent, coordinated by note-59

Ordered by real-bug risk × small change.

- **D34 (S, bug, reproduced):** a `key:: value` line hides its whole paragraph. `remarkInlineAttrs` drops any top-level paragraph whose first text starts with `key:: `; CommonMark joins the next line into that paragraph, so `due:: 2026-10-20\nCall the lawyer…` renders without the sentence. The server indexes per line (`utils.ts` extractAttributes) and only knows ``` fences, not `~~~`. One `attributeLines()` in @onden/markdown; the renderer removes only those lines.
- **D35 (S–M, bug):** "which extension is which media" lives in 4 places and already disagrees: an uploaded audio/video on a board renders as a broken image card (`imageOnlyCard` ignores the extension); `.oga` uploads but renders as a broken image; the favicon picker accepts `.ico`, which the server refuses; `aac`/`flac`/`ogv` render but cannot be uploaded. One extension → mime/kind/cap table in @onden/markdown.
- **D36 (S, bug):** the static (GitHub Pages) site router compares the raw `location.pathname` with slugs, so a CJK slug opens the home page after a reload or from a shared link (SSR decodes first). One `resolveSiteRoute()` for SSR pages and the SPA.
- **D37 (M, bug):** summary / first paragraph / page description is written 6 times; RSS, blog listing excerpts and the article's title stripping skip frontmatter (RSS description `---`, listing excerpt `status: … description: …`, duplicated H1 on Obsidian imports). One `noteSummary()` / `bodyAfterTitle()`. After #243.
- **D38 (S, bug risk):** duplicating a note copies module-owned attributes (its own exclude list instead of `systemAttributes`): a duplicated #subscription becomes a second feed carrying the original's etag. `isCopyableAttributeKey()`. After #164/#165 (or rebase).
- **D39 (S):** edge-type labels in 3 graph views and colours in 2 already differ. Label in `edgeManifest`, one `lib/edgeKinds.ts`. After #243.
- **D40 (S, no bug yet):** `sanitizeCustomCss` (XSS guard) is kept equal front/back by comment. Move to @onden/markdown. After #183.
- **D41 (S, minor):** offline task agenda lists all done tasks unsorted; the server caps 20 by `updated_at`.

Checked and left alone (round 11): capabilities vs roles, task bucket rule, task statuses, filter ops, server error mapping, system nodes, child order, taskLines (one owner since D30), safeFetch byte caps, palettes, word stats.

## Round 12 (main 6e85415e) — scan by a read-only agent, coordinated by note-59

Status of round 11: D37 = #253, D39 = #252 (both reviewed, await merge). D24, D28b, D38, D40 still wait on their PRs.

- **D42 (M, bug):** a note's site URL is built 6 ways from 3 slug sources. `htmlUtils.ts:184` `wikilinkHref` slugifies the link *text* into an absolute `/site/<slug>/` (single-note export and zip), the zip nav uses relative `../<slug>/`, `PublishShareAction.tsx:31` uses the live slug, the snapshot renames clashes to `slug-<id6>` (`collections.ts:184`). So `[[Alias]]` links to a page that doesn't exist, two published "Plan" notes from different spaces share one Copy link, a renamed note's Copy link 404s under model B, and a zip hosted as a GitHub Pages project site breaks every in-text wikilink. Package: one `sitePathFor(nodeId, servedNodes)` over the served snapshot; server returns `published_url`. After #175 #176 #178 #180 #183.
- **D43 (M, bug):** which note `[[label]]` names is resolved 6 times; only the server (`nodes.ts` syncWikilinkEdges) and `useOverviewMode.openWikilink` apply the space rule. `MarkdownRenderer.tsx:214` and `NoteVersionHistory.tsx:88` take the first title match in the workspace and then re-resolve by slug (no longer unique). `findBacklinkSnippet` (`lib/backlinks.ts:28`) compares the raw body, so `[[Plan|our plan]]` / `[[Plan#Goals]]` backlinks have no snippet and don't jump to the link. `appStore.wikilinkBacklinksOf` is dead. Package: `resolveWikilink(label, fromNode, nodes)` + `wikilinkSpan`; the renderer carries the node id. Free now (touches lib/utils.ts lightly vs #253).
- **D44 (S–M, bug):** the attribute key alphabet differs: the UI makes Unicode keys (`TagsPanel.fieldKeyFrom` keeps `\p{L}\p{N}`), the API takes any string, the text grammars are ASCII (`frontmatter.ts:21`, `attributeLines.ts:27`). Set `作者 = 王`, export, re-import: the attribute is gone; an Obsidian vault with CJK property keys imports without attributes; `due date` exports as YAML that doesn't parse back. Package: one `ATTRIBUTE_KEY` / `isAttributeKey()` in @onden/markdown (alphabet `\p{L}\p{N}_-`, as Obsidian), used by both grammars, the zod schemas and the UI; `entryFor` quotes or refuses others. Free now.
- **D45 (S–M, risk):** a queued offline write's target entity is decoded from the HTTP path 7 times with 5 grammars (`localDbWorker.ts:161,484,517,266`, `pendingNoteProjection.ts`, `taskAgenda.ts`, `canvasWriter.ts`, `draftActions.ts`). A queued create isn't "queued" for the slim bootstrap paint; `forgetBody` substring-matches path and body, so a write that merely mentions X keeps X's refused body on the device. Package: record `target_ids` at enqueue. After #164 #167.
- **D46 (S, minor bugs):** time display has no owner. `timeLabels` groups by the browser day while "today" is the workspace zone; `HistoryView` and `NodeEventHistory` copy `dayLabel`/`relTime` with different year rules and no `t()` ("5m" vs "5 分鐘"); `TodayLens` uses browser locale+zone; hard-coded `"zh-TW"` in two places; `formatSiteDate` runs in SSR without TZ (frontend container has no ONDEN_TIMEZONE), so the server says 10月16日 and a Taipei reader's client 10月17日 (hydration mismatch). Package: `lib/timeLabels` sole formatter over `getLocale()` + `workspaceTimeZone()`; site zone in the snapshot; lint against bare `toLocale*String`. After #185 #253.
- **D47 (S, no bug yet):** `/api/ai/ask` is a shim over `/api/ai/run` with its own wire shape (`blocked_space_ids` vs `blockedSpaceIds`) and its own client frame loop. One `/run` contract. After #177.
- **Small:** ⌘S is bound twice (`useKeyboardShortcuts.ts:111` and `OverviewEditor.tsx:253`), so each save sends two PATCHes. One-line delete.

### Checked and left alone (round 12)
Dates/recurrence (one owner each), shortcuts list, the three ⌘Z handlers (coordinated on purpose), live refetch and SSE parsing, `not found`/`not_found` (handled on purpose), canvas geometry (`reviewExtract` CARD_W minor), board zod schemas, `UUID_RE` copies (identical), space capability defaults (differ per kind on purpose), folder import extensions, Notion collection key, tag-name/hashtag/capabilities/site token, backend `blockRenderer` gaps (go with W38d), export file names, site router.

## Round 13 (main db12d365) — scan by a read-only agent, coordinated by note-59 (/loop 一直掃)

Status of round 12: D43 #254, D44 #256, D44b #259, ⌘S + card links #258 — all merged and deployed (2fcbe1e7). D42, D45, D46, D47 wait on #255 / #260.

- **D48 (S, bug):** a schema field's shape is checked three ways. `routes/collections.ts:45` enumerates 9 types without `rating` (and its `z.object` drops `max`); `agentTools/proposeTagPack.ts:18` allows 6; `PATCH /tags/:id/schema` and tag-pack import check nothing. The type list is `AttributeFieldType` (`@onden/markdown attributeValue.ts:43`). Website › Collections → add "Rating (stars)" → Save is a 400 (an edit is acknowledged offline, then rejected on replay); a collection with a rating field added in TagsPanel can't be saved from the Collections manager; `"dat"` passes the tag route and becomes text. Package: one `attributeFieldSchema` in @onden/markdown, `writeTagSchema` its only gate. Free.
- **D49 (S–M, bug):** the `onden-base` block (`lib/basesEval.ts`) compares raw strings: `rating == 5` never matches, `due >= "2026-10-01"` is always false (`Number()` → NaN), `order: [rating]` sorts "10" before "9"; `file.hasLink` misses `[[Plan|alias]]`. Package: pure `compareAttribute(value, valueType, op, rhs)` with the SQL guards' typing; hasLink via `wikilinkBodies` + D43 resolver. Loosely after #260.
- **D50 (S, bug):** numeric reads follow 4 rules. The rollup (`nodeAttributes.ts:86`) casts `value::float` unguarded inside a try/catch that drops the rollup: one `"2h"` hides it; `"1e3"` counts as 1000 in rollup and table footer (`groupRows.ts:94`) but not in filters; rollup tag is `t.title = $tag` (exact case, no children). Package: `numericValueSql` / `isStoredNumber`; rollup tag via `memberTagIds`. Number part free; tag part after #260.
- **D51 (S, bug):** Notion CSV import infers field types with its own grammar (`csvDatabaseImport.ts:35-67`); Notion's `October 16, 2026` makes a `date` field whose values are all stored as text (typed sort/filters skip them, editing is refused). Package: `inferFieldType`/`isCalendarDate` per cell, long dates and `M/D/YYYY` → ISO. Free.
- **D52 (S, bug):** single-note "Download Markdown"/"Copy Markdown" (`useNoteExport.ts:49`) writes the raw body, bypassing `exportedNoteFile` (zip): stale frontmatter values, no tags, no title. Package: one exported-file rule (server export format). Free.
- **D53 (S–M, risk):** RSS "this node is a subscription source" is written 7 times with different filters; the subscriptions read model and subscribe/OPML orchestration live in `modules/rss/routes.ts`; OPML accepts `feed://` URLs the form refuses (every fetch then fails), duplicates by exact string, relative Atom item links open on Onden's origin. Package: `modules/rss/sources.ts` + `feedUrl()` normaliser + item URLs resolved against the feed. Free.
- **Small:** DOI normalisation twice (`citations/crossref.ts:37` strips `doi:`, BibTeX import `papers.ts:236` doesn't) → duplicate paper notes.

### Checked and left alone (round 13)
Realtime ticks, offline retry classification, 401 codes, AI built-in skills, dispatcher registry, reminders/review, daily note, JSON Canvas/ink (frontend-only), card colours, breakpoints (one owner; touch-target media queries cosmetic), localeCompare, slides `parseDeck` (goes with D24/D34), inbox grouping. Canvas rename is a raw title UPDATE without slug or undo (low impact; note for later).

## Round 14 (main 0a375282) — scan by a read-only agent, coordinated by note-59 (/loop 一直掃)

Status of round 13: D48 #264, D50 #266 (numeric part), D51 #262 merged and deployed (edb9a3e3). D52 = #267 and D53 = #265 (note-50) wait for the user to merge. D49 and D50's tag part wait on #260.

- **D54 (S–M, bug):** "notes under a tag" is computed three ways. `memberTagIds` (tag + child tags + extending tags) is the rule for saved views, `/api/query` and the tag page; search `#tag` (`nodeSearch.ts:57`) counts direct membership only; the AI tag scope `gatherTag` (`harness/scope.ts:206`, also Slides › Make deck from tag) counts extenders but not children. A note tagged only `#課程/演算法` is on the 課程 page but not found by `#課程` and left out of Ask AI / deck. Package: both through `memberTagIds`; extend the tagMembershipParity test.
- **D55 (S–M, bug):** "slug follows the title" has no owner. Event-history undo of a rename restores the title but not the slug; Trash › Restore re-slugs a tag `tag-book` → `book`; Markdown re-import changes the title only. Rename Plan → Roadmap, undo: title Plan, slug `roadmap`; a new "Roadmap" then makes `[[Roadmap]]` link to both. Package: one `slugFor(kind, title)` / `reslug(id)` in `services/nodes.ts` used by every title writer; guard test over `UPDATE … title`.
- **D56 (S–M, security risk):** two rules decide who owns an uploaded file: "claimed" (first note whose title/body is saved with the URL, `mediaOwners.ts`) and the fallback for unclaimed files (oldest note whose body/attribute/presentation contains it, `mediaAccess.ts:72`). Files uploaded into a media field or the site design are never claimed, so pasting their URL into a note in a shared space claims them and the whole space can read a private space's file. Package: claim on attribute and presentation writes too; fallback by reference time or dropped after a backfill.
- **D57 (S, bug):** tag merge moves child tags but leaves `tag_schema.extends` lists naming the source; merging #book into #livre drops #novel's notes from #livre and its inherited fields, and the preview doesn't say so. Package: re-point extenders as cascade events chained to TAG_MERGED; count them in the preview.
- **D58 (M, bug):** every text grammar uses `[\p{L}\p{N}]` without `\p{M}`, and nothing normalises to NFC. `slugify("हिंदी")` = "हद", "कल"/"काल"/"कील" share a slug (wrong `[[link]]` edges), `#हिंदी` searches as text, `कीमत:: 5` is no attribute, NFD titles from macOS zips don't match NFC links. Package: one `WORD_CHAR = [\p{L}\p{M}\p{N}]` + `normalizeText()` (NFC) at write/import in @onden/markdown; existing slugs keep their value. Redaction's slug copy after #178/#255.
- **Small:** two command-palette entries for the same workspace zip; the zip URL written 3 times.

### Checked and left alone (round 14)
Space move (owned by `moveToSpace`), trash cascade (only the slug base, folded into D55), tag paths offline vs server, versions (4 SQL copies agree), saved views schema, node delete (D18), `content_nodes` inserts, mentions/comments (none), template `uniqueSlug` (stricter, harmless).

## Round 15 (main 8b46a759) — scan by a read-only agent, coordinated by note-59 (/loop 一直掃)

Status: D45 #278, D49 + D50 tag #280, D54 #270 (+ #271 system notes), D56 #272 (migration 107), D46 #274, D47 #275 merged; all but #278/#280 deployed (167ff336). D42 #279, D52 #267, D53 #265, D55 #273, D57 #276 (note-50) wait for the user; D58 (note-50) stacked on #279.

- **D59 (M, bug; = old D24):** the `^id` grammar has 9 copies (`blockIds.ts`, `remarkBlockId.ts`, `blocks.ts`, `index.ts` BLOCK_REF, `summary.ts`, `editorBlocks.ts`, `publishedCore.extractBlock`, `editorCompletion.ts`, the DB CHECK). The renderer hides an id only on a top-level paragraph: `- item ^abc` and `## Title ^h1` render the `^id` and get no `data-block-id`, so Obsidian imports show `^abc` and `[[Note#^abc]]` can't scroll on the site; a quote block node's standalone id makes `extractBlock` return null. `node_block_ids` indexes ids inside `~~~` and indented code that `parseBlocks` doesn't see; its only reader (`GET /api/nodes/block/:id`) is unused. Package: one `blockAnchors(markdown)` on the `blocks.ts` scanner; `remarkBlockId` on every block; retire or rebase `node_block_ids`.
- **D60 (S, bug, verified):** event-history undo builds its own inverse patch (`restore.ts:850 makeForwardInverse`) without `bodyPatch.makeInversePatch`'s diff-match-patch #69 guard: undoing "Mood 😀 ok" → "Mood 😁 ok" throws "URI malformed" inside the transaction → 500. Package: use `makeInversePatch`; guard `patch_make` to `bodyPatch.ts`.
- **D61 (M, bug):** wikilink edges are kept from one side. Incoming edges are synced only on create and space move (`syncIncomingWikilinkEdges`, ILIKE prefilter, no aliases); a rename or a new alias never re-wires them. Rename Plan → Roadmap: X's `[[Plan]]` still counts as a backlink of Roadmap, Y's `[[Roadmap]]` doesn't until Y is edited; `[[my-plan]]` misses the prefilter. Package: one `relinkTarget(nodeIds)` sharing `syncWikilinkEdges`' matcher, called on create, title change, aliases change, space move, trash restore. Loosely after #273.
- **D62 (S–M, bug):** heading anchors have no owner. Rendered headings have no ids, so the published TOC (`extractTOC`, ASCII-only ids) links nowhere; `## 目標` gives `href="#"`; a `## comment` inside a code fence is in the TOC; `[[Note#Goals]]` drops the heading. Package: `headingAnchors(markdown)` (mdast, Unicode slug, de-duplicated) + a rehype step setting the ids; TOC and link hrefs use it. After D58/D59.
- **D63 (S, risk once block nodes are on):** a written tag name resolves two ways: `resolveOrCreateTagPath` (exact title, root) vs `blockNodes.resolveTagNames` (lower(title), any tag anywhere). With only `課程/book`, frontmatter `tags: [book]` creates a root "book" while `{book}` attaches `課程/book`. Package: one `tagIdForWrittenName(name, {create})` in tagHierarchy.
- **Small:** `git.getHistory` dead and wrong for non-default spaces; a rename leaves the old `<slug>.md` in the git backup; backup files are raw bodies (fold into the D52 exported-file rule); two `^id` generators (cosmetic).

### Checked and left alone (round 15)
Agent tools vs REST (same services), AI reads/writes through `aiReadable`, embeddings trigger, body derived state (`applyBodyChange`/`finishNewNote`), env flags (one reader each), backup scripts (full pg_dump), server `withBlockIds`, tag-name shape, error codes, space capability defaults.

## Round 16 (main 225a25f8) — scan by a read-only agent, coordinated by note-59 (/loop 一直掃)

Status: D45 #278, D49/D50-tag #280, D60 #283, guards #282 merged and deployed (2c4522ce); D61 #286 merged; D63 in final checks. note-50: D42 #279 → D58 #281 → D59 #284 → D62 (stacked), plus #265 #267 #273 #276 — all wait for the user.

- **D64 (M, bug):** sibling order has no owner. `lib/childOrder.ts` (sort_order, created_at) is used by the tree/canvas and the backend bootstrap, but the sidebar's "natural" order shows the store array (upserts move a node to the end), the offline mirror boot has no ORDER BY, and the published site sorts children by title. The drag writer (`useSidebarDrag.ts:285`) renumbers the whole workspace by global index and PATCHes every node whose index changed — with notes created at sort_order 0 that is ~every note: 199 PATCHes / NODE_UPDATED events and "modified just now" everywhere for one drag. Package: one `siblingOrder` rule; sidebar and mirror use it; snapshot carries sort_order; `reorder(parentId, ids)` renumbers only that parent's children without touching updated_at.
- **D65 (S, bug):** upload caps three ways: `mediaTypes.ts` (image 50 MB, PDF/audio 200 MB, video 500 MB), nginx `client_max_body_size 20m` for `/api/`, folder import's 19 MB. `uploadMedia` checks nothing, so a 30 MB mp3 or 25 MB PDF is accepted by the picker and refused by nginx with an HTML 413. Package: `MAX_REQUEST_BYTES` in mediaTypes, nginx checked against it (or a larger `location = /api/media`), client checks size and maps 413.
- **D66 (S–M, bug):** list paging has no contract: 7 limit/offset parsers, 3 response shapes. `/api/versions/recent?limit=abc` → `LIMIT 'NaN'` → 500; tag view `?limit=-5` → 500; a saved table view of a 350-note tag shows 200 rows with Σ over 200 and no "more"; a query block says "50 matches" for 120. Package: `services/paging.parsePage` (400 on bad input), one `{ rows, total?, next }` shape, clients load more.
- **D67 (S, bug):** note size caps (`NODE_TITLE_MAX` 500, `NODE_MARKDOWN_MAX` 2,000,000) are checked only at the REST edge; importers and `createNote` don't. A 2.1M-char Obsidian file imports, then its first edit is a 400 forever; splitting at a 600-char heading is refused. Package: caps in one module used by createNote/applyBodyChange, importers (`too_large` skip) and the lib/data writers.
- **Small:** trash retention (90 days) is promised in the UI but no scheduler calls `pruneSoftDeleted`; six identical `BUILT_IN_FIELDS` copies (with D66).

### Checked and left alone (round 16)
Clipboard paste, FSRS (server-only), RSS unseen counts (#265), due-soon notifications, pinned notes, spaces cache epoch, app URL grammar, service worker, media cache headers, rate limiter, image resize, recurring tasks, propertyWriter optimistic value, optimistic space_id, tag/space title caps.

## Round 17 (main 20acbd7e) — scan by a read-only agent, coordinated by note-59 (/loop 一直掃)

Status: D64 #292, D65 #290 merged and deployed (4d5bbdbb, nginx recreated); trash text #296 (user: no automatic deletion). note-50: D66 #291, D67 #295 wait for the user; it is rebasing #273 and the chain #279 → #281 → #284 → #287.

- **D68 (S, bug):** "today's note" is found or created in four places (`useNodeCreation.openDailyNote`, `QuickCapture`, `useDayNoteWrites.createAgendaTask`, and the "daily" note template); the template never calls `findDayNode`, so "New from template: Daily note" creates a second `2026-10-17`, only template-made day notes carry `#daily`, and two offline devices mint two day notes. Package: one `dayNotes.openToday({create})` with a deterministic id (personal space + date).
- **D69 (S–M, bug):** two template mechanisms: frontend `noteTemplates` (body scaffold, `{date}` vars) and backend tag `template_children` (child notes, no vars). With the Meeting pack installed, "New from template: Meeting notes" gets the `## Agenda/Decisions/Action items` body *and* three same-named child notes; slash "Template:" drops tags/attributes; `{date}` stays literal in pack children. Package: templates are tag data expanded in one place (`templateExpander` + shared `applyTemplateVars`). After D68.
- **D70 (S, bug, verified):** "Build your first website" (`useWelcomeBanner.ts:71`) still follows the old live-publish rule: it marks pages `_published` and links `/site/home`, but under model B nothing is public until Publish, and the pages land in the personal space (`publish: false`), so even Publish leaves them out. Package: `website.buildIntroSite()` creating pages in a publishable space and publishing through the Studio's writer.
- **D71 (S, bug):** which tags a surface lists is decided 7 ways (ModuleLibrary, SidebarTagPanel, TitleTagRow, SchemaLens, TagsOverview, palette `#`, MakeDeckDialog): the reserved `#subscription` shows under 自訂標籤 and in the palette but not in the sidebar; `#task`/`#page` are taggable but missing from Make deck. Package: one `tagRole(tag)` + named list predicates in `lib/systemNodes`.
- **D72 (S, risk):** "module switches only via the modules endpoint" is enforced in the PATCH schema route, not in `writeTagSchema`; tag-pack import and `proposeTagPack` store `behaviour.modules` verbatim (`{"modules":{"nope":…}}` is accepted). Package: the rule moves into `writeTagSchema`; pack switches go through `setTagModules` validation. Loosely #276.
- **D73 (S, risk):** site design-token defaults differ between the app renderer and the zip/HTML export (accent `#317563` vs `#2f6f5e`, layout `sidebar-right` vs `full`/`sidebar-left`, brand "Onden"/""/"Site"). Package: pure `siteTokens(manifest)` in @onden/markdown next to `siteHead`. With W38d / #183.
- **Small:** example notes can seed again (device-scoped flag + server rule "no nodes"); website module has no `routePrefixes`, so publish/share/access writes are accepted after the module is removed; review settings ranges copied front/back (agree today).

### Checked and left alone (round 17)
Module registry ids/tag functions (test-guarded), "NULL = all imported" (3 copies, same meaning), source_type vocabulary, abilitySource vs effectiveTagModules, saved-view layouts, pinned tag views, capture `@date` grammar, palette vs editor actions, ink codec, token templates, reserved keys, raw site-config writes, landing vs home, RSS saved articles hidden, starter pack field types.

## Round 18 (main 6e2a3b3d) — scan by a read-only agent, coordinated by note-59 (/loop 一直掃)

Status: D70 #299, D68 #301 merged; vitest capped at 2 workers (#297). note-50: D71, D72 in progress; its open PRs are all rebased and mergeable.

- **D74 (M, bug):** edge origin/status never reach the app, so each view decides which edges are real. Wikilink edges (`origin='wikilink'`) and hand-drawn arrows (`origin='manual'`) share `knowledge_link`; the client `NodeEdge` drops `origin`. Deleting a wikilink arrow on a board removes the backlink until the next autosave re-creates it; retyping it ("supports") leaves two arrows after the next save; drawing A→B while A has `[[B]]` stacks two identical arrows. Six views filter edges differently; backlinks and the published "Related" include suggested/rejected `suggested_link` edges (risk). Package: `origin`/status on `NodeEdge`, one `edgeKinds.role(edge)` with named predicates, derived edges not deletable/retypable (server 409), snapshot keeps only active edges.
- **D75 (S–M, bug):** the canvas list lives in two client stores: `state.canvases` (only on refresh) and `data.nodes` (synced). A canvas created on another device opens but dropping a note on it says "no longer available"; renaming/trashing via the note leaves the old name/a 404 in the palette and tab strip. Package: derive the list from `data.nodes`; one rename/delete path.
- **D76 (S, bug):** search snippets: the server sends pgroonga's HTML-escaped snippet, the app renders it as plain text (`Q&amp;A for &lt;tips&gt;`); offline snippets are null or raw markdown. Package: one `{ text, ranges }` contract and one `snippetAround` for local paths.
- **D77 (S–M, bug):** who may review is decided three ways; the owner can demote themselves to editor (200), after which approvals are invisible and self-escalation back to admin is refused; "admin" grants nothing beyond reviewer while an owner exists; viewers see Approve buttons that 403. Package: one `reviewAuthority(actor)`; bootstrap `can_review`; `updateActor` refuses changing the owner's role and validates roles.
- **D78 (S, minor bug):** collection grouping written twice: Kanban orders columns by declared options with a safe empty key; Table/List use first-seen order and `"(none)"` as both key and label. Package: one `groupRows(rows, field, options?)`. Loosely #291.
- **Small:** dead `boardStore.hiddenCardIds`/`clearSurface`; `removeActor` can remove a shared space's only manager; 26 error toasts show raw server text instead of `writeErrors.message`; tag merge drops the source's saved views, board layout and module switches without saying so (goes with #276).

### Checked and left alone (round 18)
Share link lifecycle, board writes (`applyBoardChanges`), board authority (different on purpose), tag board membership (direct tag, deliberate), task status vocabulary, space member rules, kanban value type, mobile navigation, local backup folder (copy only), saved views, lens availability, AllCardsGraph source.

## Round 19 (main 153a5a60) — scan by a read-only agent, coordinated by note-59 (/loop 一直掃)

Status: D74 #314, D77 #307, D78 #320, D69 #324 merged and deployed (45ac05b6). D73 waits on W38d. note-50's PRs wait for the user.

- **D79 (S–M, bug, reproduced):** undo still applies body changes with fuzzy diff-match-patch (`bodyPatch.applyInversePatch`/`canApplyCleanly`), which #312 removed from merge. Event A edits 買牛奶→買豆漿, another writer changes it to 買咖啡; undoing A reports clean and writes 買牛奶 back — the other writer's 咖啡 is lost silently. Package: rebuild the pre-event body exactly and revert with `threeWayMergeBody(post, current, pre)`; conflicts become 409 `patch_conflict`.
- **D80 (S, bug):** the publish preview's "what changed" (`preview.ts` `visible()`: title/slug/markdown/parent/tags) is narrower than what the hash covers and the site renders (sort_order, edges, updated_at). Reordering pages or drawing a link between published notes shows "Nothing has changed" but publishing changes nav/Related. Package: one `readerView(node)` + `siteDiff(last, next)` used for both the diff and the hash.
- **D81 (S, bug):** the calendar has its own date grammar (`calendarGrid.ts` `Date.parse` + `raw.slice(0,10)`): `10`, `Draft 2`, `Oct 14, 2026`, `2026/10/14` are "dates" that land on no cell and aren't counted as undated. Package: `calendarDayOf(value, zone)` on `toCalendarDate`.
- **D82 (S, bug, regression from #322):** three rules for "server unreachable" (syncEngine: not an ApiError; writeErrors: 5xx/408/425/429 retryable; aiErrors: TypeError). During a deploy (502/503) a warm reload of a small cache sits on 「正在確認工作區資料…」 while a big cache goes offline-usable. Package: one `isServerUnreachable(error)` (fetch failure, 502/503/504, timeout).
- **D83 (S, risk):** server-only attributes (`_import_excalidraw`) are stripped only in bootstrap/delta/membership, not in `GET /nodes/:id/attributes` or MCP `get_node`; opening an imported drawing downloads the multi-MB original again (4.9 MB on prod), and an agent's `get_node` gets it too. Package: `clientAttributeSql` on those reads + `?keys=`.
- **D84 (S, bug):** the learner access token is persisted to the 90-day cookie before `/api/site` checks it, and `?access=` wins over the cookie: a revoked `?access=OLD` replaces a valid cookie and gates every later visit. The server gate is copied 3× (/site, /share, /media). Package: one `siteAccessGate(c)`; SSR persists only after a 200. Loosely #279.
- **Small:** skill header buttons use direct tags only (goes with D54's memberTagIds); dispatcher `$now` is UTC while `$today`/`{datetime}` use the workspace zone; a misleading Kanban comment.

### Checked and left alone (round 19)
Body merge (one owner after #312), draft/card base, dispatcher registry, filter evaluators (no fourth), view layout gate, agenda buckets, publish hash (computed once), backend site-access copies agree today, app settings, Excalidraw/ink import, AI skills/budgets, day lens zone, task title writes. No media GC exists (missing feature, not depth).

## Round 20 (main 72591ba7) — scan by a read-only agent, coordinated by note-59 (/loop 一直掃)

Status: D79 #331, D80 #345, D81 #339, D83 #335 merged and deployed (aa94806b). note-50: D82 #341 waits for the user, D84 in progress.

- **D85 (M, bug):** the shortcut list (#343 `lib/shortcuts.ts`) isn't the only one. Hard-coded hints (`AppTopbar` ⌘⇧N/⌘⇧D/⌘K/⌘\, sidebar ⌘F) ignore rebinding and platform; the palette closes on literal ⌘K and stops propagation (rebind to ⌘J: opens but can't close); `CardNode` saves on literal Mod-s; `chordProblem` doesn't know the editor keymaps (⌘B bolds AND opens search), canvas bare letters (bare `c` accepted), or ⌘Z; `?` never matches because a real Shift+/ press is `shift+?`; stale `overridesCache` lets a second tab wipe the first tab's rebinding. Package: `lib/shortcuts` the only vocabulary — one chord grammar (shifted symbols canonical), `kbdHint(id)`, `RESERVED_CHORDS`, palette/card through `matchShortcut`, re-read on `storage`.
- **D86 (S, bug):** Notion import seeds saved views with its own copy of `createTagView` and skips `assertLayoutImported`: a workspace without Board/Calendar/Table still gets those views (opened as "module not imported"); the API would 409. Package: in-transaction `appendTagView` owning gate, shape and event; frontend layout lists derive from `VIEW_MODULES`.
- **D87 (S, bug):** the agent/MCP `updateNode` tool can't send `base_markdown`, so an agent edit silently overwrites the user's later autosave (C lost, no BODY_CONFLICT). Also `stampToday` and dead `nodeMutations.updateNode`. Package: the tool takes a base (getNode documents echoing it); a markdown edit without a base is refused or recorded as a conflict.
- **D88 (M, bug):** handwriting `ink_data` is last-writer-wins with no conflict record: laptop saves {S1,S2}, offline tablet replays {S1,S3} → S2 gone silently (only in ink history); PDF highlights likewise. The ink model is merge-friendly (strokes grow-set, erasures interval union) but nothing merges. Also `propertyWriter` sends `client_updated_at = now` instead of the updated_at it saw. Package: pure `mergeInk(base, stored, incoming)` the backend can run; ink PUT carries its base; attributes send the seen updated_at.
- **Small:** Danger zone says "move or trash its notes first" but `deleteSpace` counts trashed notes (409); settings search misses tag-function settings.

### Checked and left alone (round 20)
Excalidraw converter (client only, server stores ink_data), publish siteDiff (one readerView), other body writers (all send a base; version restore deliberate; import update refuses on local changes), module removal gating, table lens vs table module, tag 全部 tab parity, calendar V3, boot gate (D82).

## Round 21 (main 6b894fa0) — scan by a read-only agent, coordinated by note-59 (/loop 一直掃)

Status: round 20 done — D85 #358, D86 #349, D87 #350, D88 #356 merged and deployed (6c11c65c). RSS model is being redesigned (paused).

- **D89 (S, bug):** collections and the published site ignore inherited fields (#353). `services/collections.ts` (createItem/updateItem/pickTitleField), `routes/collections.ts` SCHEMA_SELECT and `publishing/collections.ts` (public field allowlist, redaction text fields) read the tag's own `tag_schema->'fields'`. #書 has `author`, #書/小說 adds `pages`: the app table edits `author`; Website › Collections lists only `pages`; `PATCH …/items/X {author}` returns 200 but skips it; the published collection drops `author`. Package: read `effectiveFieldsOf` everywhere.
- **D90 (S–M, bug):** ink conflicts are recorded and reverted like text: ATTRIBUTE_CONFLICT stores both multi-MB values inline (polled every 8 s, 50 at a time), ConflictList prints them, and Revert writes `overridden_value` back last-writer-wins without a base — losing the other side's strokes (the D88 loss again). Also Revert writes `value_type: "text"`, so a numeric free-form attribute drops out of numeric filters. Package: conflict records carry value_type (and blob refs + ink_conflicts for merged keys); a per-key `revertConflict` re-applies only the overridden items (`mergeInk` for ink).
- **D91 (M, bug):** export → import doesn't round-trip: the zip collects media from body refs only (a PDF note's `pdf_url`, media fields, frontmatter links are neither copied nor rewritten); the importer rewrites only image/embed syntax with a third extension list (plain `[paper](../../research/x.pdf)` links stay dead, `.mp3` ignored); relation fields export raw UUIDs. Package: one self-contained-bundle pass (shared with publishing mediaBundle), importer resolves any bundled target (mediaTypes), PDF notes export as a body link, relations as `[[Title]]`. Coordinate with #267.
- **D92 (S–M, bug):** two app entry points: web mounts `AppRoot` (persistent storage, error boundary); Vite/Capacitor mount `main.tsx` (neither, and a second outer LoginGate before ServerSetup). Native skips LoginGate, so `AccountSessionBoundary` never binds: unscoped local storage, no expected-user header; the only native auth is the Origin bypass that's off in production — the APK against prod gets 401 with no login screen; changing Backend URL replays server A's queue to server B. Package: one `bootApp()`; native through the same login/account binding; one checked `setApiBase`.
- **D93 (S, bug):** the same-name field rule is written twice: server `fieldNameClashes` matches names; the app's `inheritedClash` also matches labels, and SchemaLens skips the whole save when any field clashes — a child with a different-name, same-label field (from a pack, an agent proposal, or pre-#353) can never be edited. The rule lives only in `changeTagSchema`, not `writeTagSchema`/`insertTagRow`. Package: one pure rule in @onden/markdown, both sides; block only the clashing field.
- **Small:** `@onden/markdown` subpath aliases copied into 7 configs (3 lack `/slug`; derive from `exports`); dead `onden://node/` export rewrite; held-approval kinds described by a hard-coded switch and shown "Approve & run" for a removed module's effect (409).

### Checked and left alone (round 21)
D87 base rule for other clients (all append paths go through drafts.editText or send a base), MCP prompt scopes, inheritance in the client catalog and other readers, ink mirror/queued saves, background-write toasts, device vs workspace settings, SQLite backup restore, held-effect approval tiers.

## Round 22 (main ded04289) — scan by a read-only agent, coordinated by note-59 (/loop 一直掃)

Status: round 21 — D89/D93 #370, D90 #365, D91 #375 (migration 116) merged and deployed (5388386a); D92 = #377 (note-50).

- **D94 (M, bug):** `node_attributes.value_type` is derived state (`normalize`) but only attribute writes keep it current. Tag apply/remove (and undo), field type changes in `writeTagSchema`, adding `extends`/parent and tag merge change which field governs a key without retyping stored rows. The server's sorts, range filters and rollups read the stored type; the app derives it from the schema. Change #book `pages` from text to number: the table footer sums, an onden-base `pages > 100` matches, but the saved view filter returns 0 rows and sort is textual ("1000" < "320"). Package: one `retypeGoverned(workspace, {nodeIds|tagIds})` called by every governing change (or type at read time).
- **D95 (S–M, bug, data loss):** "Empty trash" confirms with the caller's readable trash (≤200 rows) but calls `POST /api/maintenance/prune {retention_days:0}`, which purges **every** trashed node in the workspace — including other members' personal-space trash the owner can't see. The route also takes `workspace_id` from the body unchecked and returns the purged ids. Package: `emptyTrash(actor, ids)` purges exactly what the caller was shown (re-checked against readable trash + write authority); the workspace-wide retention purge has no route; counts only.
- **D96 (S, bug):** the static site zip (`GET /api/export-static`) isn't self-contained: no media pass, no blobs copied — images/PDFs/logo stay `/api/media/…` and 404 when hosted elsewhere. Only the Pages push bundles media. The server `GET /:id/export.html` has no caller. Package: one `bundleSiteFiles(files, ws)` (bundleMedia + gated blob copy) for export-static and pagesPush. After #279.
- **Small:** `ai_suggestions` is a dead table still read by every bootstrap; tag merge preview compares own fields only (misses inherited fields — with #276); event-history undo writes NODE_UPDATED that merges into the surrounding edit session instead of being its own restore point.

### Checked and left alone (round 22)
Ink writers (all send base; import refuses local changes; blob GC covers refs), Markdown zip drops drawings (product decision), spaces lifecycle, outbox registry/backoff/lock, background timers (single replica by design), rate limiting, audit tables, tag catalog effective fields, trash/prune FK cascades.

## Round 23 (main 71374a30) — scan by a read-only agent, coordinated by note-59 (/loop 一直掃)

Status: round 22 — D94 #378, D95 #379 (purge = space managers, user decision) merged and deployed (346b43c7). D96 waits on #279. note-50 is deploying its 11-PR batch (#360 … #377, migrations 114/115, nginx #366).

- **D97 (S–M, bug, can drop a field):** Website › Collections edits a third projection of `tag_schema` (bootstrap `collections`) that the sync delta never refreshes, the mirror never stores, and `CollectionsManager` seeds once into state. Add `pages` to #書 on the tag page → open Collections → rename and Save → the PATCH carries the old `fields` and the server removes `pages`. Also empty after a warm reload/offline start. Package: derive the collection list from `data.tags` (schema_fields/views/effective_fields); drop bootstrap `collections`; save only changed slices. After #374.
- **D98 (S, bug):** "Appears on canvases" (`canvas_memberships`) and `graph_positions` exist only in the bootstrap — not in the delta, mirror or any writer. Dropping a note on a board doesn't show in Relations or offer the canvas lens until a reload; empty offline. Package: memberships/positions as synced state (delta + mirror) or optimistic writer projection. With #306.
- **D99 (S–M, bug):** five modals (HistoryView, RestorePreviewModal, CommandPalette, QuickCapture, WebsiteStudio new-page) hand-build focus trap/Esc/z-index instead of `ui/Modal`; global shortcuts still fire behind them. In Version history ⌘K opens the palette *under* it (430 < 1000) with focus inside; Esc closes the history instead. Package: all on `ui/Modal`; lint against `aria-modal` elsewhere. After #317 #303 #362.
- **D100 (S, risk):** the field-name grammar (D44) is checked only in two routes (tags with in-use escape, collections without), not in `writeTagSchema`/`insertTagRow` where D48 put the shape check; tag-pack install, `proposeTagPack` and module templates skip it — a pack with `due date` imports and loses values on export. The lock/compare/changeTagSchema sequence is copied in both routes. Package: one `patchTagSchema` service; name rule in the write gate with the in-use/stored/import exceptions. After #304 #360 #374.
- **Small:** slim bootstrap computes a dead `excerpt` per node; delta ships `SELECT * FROM workspaces` vs bootstrap's 5 columns; ~20 emitted event types have no zh-TW label (raw codes in event views); `PublishShareAction` says "Marked for publishing" for hidden notes the server excludes; the mirror drops last_actor/last_modified_at/recent_actors (offline Bases "modified" filters match nothing); `filterByCapability` lacks `deleted_at IS NULL` (unreachable today).

### Checked and left alone (round 23)
Node row builders (one `nodeRowColumnsSql`), replay idempotency (all queued writers keyed), site-config secrets (memberless system space), AI context (`aiReadable`), published site takedown path, date math owners, number reads, capabilities, event kinds, `lib/data/sync.ts` facade, collection title field (copies agree), collection item rename slug (D55), canvas rename (round 13).

## Round 24 (2026-10-18, main d0f14fc1)

- **D101 (M, bug):** "who may be a note's parent" is decided by five client callers that disagree — move-to picker (`ParentCombobox.parentCandidates`: no tags/descendants/other spaces), sidebar drag (descendants only), pin prompt (`useNodeCreation` `window.prompt`, accepts tags, blank = root), quick capture (`parentId = currentNodeId`), canvas parent-connect (none). Server: `nodeUpdate`/`noteCreate` check kind/space/cycle/access, `routes/pointers.ts` only self+read. Inputs: quick capture on a tag page → 409 `parent_kind_mismatch` (regression from #360; offline acks then refuses on replay); pin with blank answer → root pointer that `OverviewSidebar` never renders; pin under tag "book" → invisible; drag into another space group → drop shown, 409 `parent_in_other_space`, rollback. Package: `lib/data/notePlacement.ts` `canPlaceUnder`/`placementCandidates`; pin uses `ParentCombobox`; quick capture falls back to today's note; `createPointer` calls `assertParentKind`. After #303 #354 #310.
- **D102 (S–M, bug):** a tag's reparent is checked in three server paths — `nodeUpdate` (cycle, name, field clash, kind, write, retype), `tagMerge` (cycle, name, clash, retype), `eventRestore/restore.ts` (cycle + read + retype only). Inputs: undo a move back under #書 after giving #小說 its own `author` → field clash D93 forbids; undo after a new same-name sibling → unique index 23505 → 500 instead of 409 `tag_name_conflict`; undo can put a note back under a tag. Package: one `assertReparent` in `services/nodeTree.ts`; all three call it; guard test against other `UPDATE … parent_id`. After #273 #281.
- **D103 (S, bug):** `editorFormat.activeFormats` ("the formats a press would undo") marks Quote and H1–3 pressed in the phone selection bar (#364), but `prefixLines` always adds (`> said` → `> > said`) and `setHeading` on the active level is a no-op. `CardNode.wrapCmd` never unwraps (⌘B on `**x**` → `****x****`) and binds ⌘U the editor doesn't. Package: `toggleLinePrefix`/`toggleHeading` in `editorFormat.ts`; CardNode uses `toggleWrap` (CardNode part after #317).
- **D104 (S, bug):** `hidden` is per-node everywhere (server, publish, graph, home, palette) except the sidebar tree: children are keyed under the hidden id and never rendered; the 已隱藏 group (#367) lists hidden notes flat. Hide "Project" with 5 children → all 5 reachable only by search while still published. Package: one `treeVisibility` rule in `lib/sidebarTidy` (decide: lift children or render subtrees). After #310.
- **D105 (S, risk):** #360 makes user→user `extends` legacy in the UI only; `setTagExtends` (`PUT /api/tags/:id/extends`) still accepts any live tag. Package: new targets must be module tags in `setTagExtends`/`writeTagSchema`, existing ones kept. After #276 #304.
- **Small:** `index.astro` inline copy of `applyThemeMode` is the only writer of `<meta name="theme-color">` (theme switch / OS flip leaves the status bar on the old colour until reload; Capacitor `index.html` has neither); `lib/tagPageRequest.ts` is a third copy of the pending-request channel #369 generalised (`titleFocusChannel`); owner rule twice (`actors.isOwnerRow` vs `authority.isWorkspaceOwner` disagree with no owner) and `external_id = 'system'` literal ×8.

### Checked and left alone (round 24)
#367 inbox badge/kinds, #362 mobile settings registry, #363 System actor, #377 `bootApp` (CSS import differences intended), `setApiBase` vs `canonicalServer`, stale-chunk reload, #360 tag-name lookups (`findTagIdByPath` parity fixture), tag schema authority, `tagMerge` cycle guard, space move undo, attribute undo typing, `publishBlocker` vs `publishedNodeIds`, `createChildNote` (#369).

## Round 25 (2026-10-18, main f06c5723)

- **D106 (S, bug):** attribute provenance: `spine/attributeSource.ts` calls `explicit` a legacy alias of `ui`, yet Collections create/edit, bookmark, rss, papers, boardStore, siteConfig and the app defaults (`localMirror.ts:114`, `NodeAttributesPanel.tsx:123`) still write `explicit`, and three readers pick "a person's value" differently (`exportZip` {ui, frontmatter}, `noteDuplicate` {ui, explicit}, `importIdentity` all but markdown/dispatcher). Input: `author` set through Website › Collections is missing from the zip export (lost on re-import); the same value typed in a table cell is exported. Package: `isPersonAuthored(source)` + canonical write vocabulary in `attributeSource.ts`. After #267 #295 (near D38).
- **D107 (S–M, bug):** media read: anonymous callers pass via `siteShowsMedia`, signed-in callers only via `canReadNode` of the owning note (`mediaAccess.ts:43-44,104-105`); import dedupe (`media.ts:95-98`) reuses bytes by (workspace, actor, hash, ext) regardless of the new note's space. Inputs: a signed-in non-member opening a published page gets 404 images a logged-out visitor sees; a re-imported image moved to space Team is 404 for teammates (owner = old personal note). Package: `mediaAccess` also lets signed-in callers through `siteShowsMedia`; import reuse only within the same space.
- **D108 (S, bug):** saving an AI result as a note has three source formats: Ask writes unnumbered bullets (`askCitation.ts:14`), Make deck numbers them (`slides.ts:77` `sourcesBlock`), `runSkill` drops sources (`skills/api.ts:31`) while the harness tells skills to cite `[n]`. Input: a saved Ask answer says "[2]" with an unnumbered list; a #技能 note skill saved keeps [1][2] with no sources. Package: one `citedMarkdown(text, sources)` used by all three; `runSkill` returns sources.
- **D109 (S–M, bug):** import turns folders into parent notes (`obsidianFolders.ts`, `importObsidian.ts`), but the zip export and git/GitHub backups write flat `${slug}.md` with no parent. Input: import `課程/演算法.md`, export, import into a fresh workspace → both roots, tree lost. Package: one `vaultPath(node, parentsById)` rule for export, import and backups. After #267 #295.
- **D110 (S–M, bug):** two ways to add a person never meet: `index.ts:262-320` `getCurrentActor` creates actors by `external_id` with raw SQL (viewer, no `ACTOR_CREATED`) and overwrites `name` on every request (no event); `createActor` (Settings › Users & Agents) makes a human with no `external_id` and nothing ever links one. Inputs: owner adds "Bob" as editor in Team → Bob signs up and becomes a second actor, a viewer; `SIGNUP_CLOSED` says "ask its owner to create an account" but no flow exists; a rename via `PATCH /api/actors/:id` is reverted on the member's next request. Package: `services/actors.ts` `actorForSession`; adding a human = invite claimed on first login (product decision). After #354 (index.ts).
- **Small:** the app's duplicate projection (`noteWriter.ts:133-151`) lacks space/tags/attrs (offline duplicate shows untagged, no space until replay); task due dates are shape-checked only (`taskScheduler.ts:46` `DUE_DATE_RE`), so `2026-02-30` is accepted and recurrence rolls it into 03-02.

### Checked and left alone (round 25)
Auth secret/signup mode/bearer tokens/sign-out/membership_removed; i18n placeholders, key guard, site 3-locale dictionaries; time zones (`localDate`/`localDay`, calendar cell math, server-only recurrence); `liveInvalidation`; inbox governance writes; harness tools read-only behind `aiReadable`; `storeMedia` single path; mirror `tag_color` (catalog persisted separately).

## Round 26 (2026-10-18, main 976a14c8)

- **D111 (S–M, bug):** "a live note never has a trashed parent" is kept only by `trashNode` (cascade). `undeleteNode` never checks the parent; Trash lists cascaded children with their own Restore; event undo (`restore.ts` `restoreNodeDeleted`/`restoreNodeUndeleted`, also the inverse of `NODE_CREATED`) uses bare `markLive`/`markTrashed` on the root; `RestorePreviewModal` defaults `cascade=false`. Inputs: undo "created P" with child C → P trashed, C live and invisible in the sidebar but searchable/published; restore C from Trash alone → same, and purging P later makes C a root silently (FK SET NULL); undo "deleted P" → P back without children. Package: `nodeTrash` owns subtree liveness (`restoreLive`/`trashLive`), event restore calls them, guard test on `markLive`/`markTrashed`. Product call: restoring a child under a trashed parent refuses or brings the ancestors back. After #273.
- **D112 (M, bug):** which actions a note offers is decided per surface: ContextMenu gates Move/New inside on `canEdit` but not Rename/Duplicate/Hide/Delete (none on graph or hidden rows); NoteActions gates only Delete; sidebar trash icons ungated; ⌘K offers Split/Merge/Checklist on any note and ignores module `available`. Inputs: a viewer sees Delete → optimistic remove → 403 rollback; ⌘K "Make slides from this board" on a text note → "No such board."; "Use a skill…" offline. Package: one `noteActionList(node, ctx)` in `lib/data` all surfaces render from. After #302 #354 #310 #317.
- **D113 (S, bug):** `onden-query`/`onden-base` blocks: the published site mounts the app components (`MarkdownRenderer` code override) — anonymous visitors see `{"error":"unauthorized"}`, a signed-in owner sees private results linking to unpublished slugs, static hosts fail, `onden-base` is always empty; exports show source text. Package: one published-profile rule (snapshot at publish, or an "app only" placeholder) shared by site and export (product call). After #287 #317 #291 #279 #281 #284.
- **D114 (S–M, bug):** `[@key]` citations: two grammars (`citeEdges.ts:22-31` vs `citekeys.ts:8-19`; `[@a,@b]` exports b but makes no edge), two resolutions (edges per space, export workspace-wide with `key-xxxxxx` renames), key uniqueness only on import and the unused `PUT /papers/:id/citekey` (the tag-card field writes a duplicate with 200), edges synced only from the citing note's hook (importing the paper later leaves "cited by" empty). Package: `extractCiteKeys` in `@onden/markdown`, one `resolveCitekey`, uniqueness in the attribute write gate, re-link on paper create/citekey change/space move.
- **D115 (S, minor):** two error-message tables: `serverErrors.SERVER_ERROR_MESSAGES` (shown via `e.message` at ~25 sites) vs `writeErrors.writeFailureMessage` — `account_changed` advice is opposite, `tag_name_conflict` two texts, `owner_only` vs generic 403, `system_space` in neither (English in zh-TW), `parent_in_other_space` only in writes. Package: one code→message table in `serverErrors`; `writeErrors` keeps retry classification. After #295.
- **Small:** `value_type` enum literal in `routes/nodes.ts:566` and `utils.ts:34` instead of `ATTRIBUTE_VALUE_TYPES`; `realtime.ts` listeners are process-global (every workspace's tick to every stream); bookmark/RSS/DOI outbound fetches have no per-actor rate limit.

### Checked and left alone (round 26)
Migrations vs `schema.sql` (scripted diff clean, seeded `schema_migrations` match), backup/restore coverage, SSE auth and token checks, shortcut ids vs handlers (D85), toasts (one `addToast`), KaTeX/callouts/footnotes (one pipeline), editor history vs external rewrites.

## Round 27 (2026-10-19, main a740d74b)

- **D116 (S, bug):** the site's home page is chosen in five places: Studio publish (`useWebsiteMode.ts:142` home_node_id ?? first untagged note), Timeline publish (`usePublishReview.ts`), approved agent publish (`website/effects.ts:42-47`, null unless the agent names one — ignores `workspaces.home_node_id`), server candidate (`snapshot.ts:105-106` requested-if-published → slug `home` → oldest published), served/static copies (`servedSite.ts:91-92`, `staticBuilders.ts:57`, `:80`/`:205` skip the slug step). Inputs: an approved agent publish switches the front page to the oldest published note (e.g. a #paper); an unpublished first untagged note makes the server open on a tagged paper. Package: one server-side `siteHomeFor(workspace, published, requested?)`; the client sends only an explicit override. After #279.
- **D117 (M, bug):** multi-value attributes (JSON array strings) have no owner: written by frontmatter lists, imported relations and `MultiValueEditor` (only `cardinality === "many"`, which no UI can set); read differently by export (any array), `SchemaRow` (many only), `RelationFieldEditor`/`CollectionViews` (never), SQL `eq` and `groupRows` (raw string); the write gate checks the whole string. Inputs: a pack field `topics: select [ml, db], many` → adding "ml" sends `["ml"]` → 422; export→import `related: [[A]],[[B]]` shows empty and a pick replaces the list; Obsidian `authors: [Alice, Bob]` `eq Alice` → 0 rows. Package: `attributeValues`/`encodeValues` in `@onden/markdown` attributeValue; per-element validation for many; editors through one decoder; SQL element-match arm. Export/import parts after #267 #295 #281; groupRows after #291.
- **D118 (S, bug):** `removeActor` (`actors.ts:549-558`) turns off the leaver's personal-space switches with raw `UPDATE spaces` — no `SPACE_UPDATED`, no `spaceAudienceCommitted`, so no `requestSiteRebuild`. Input: Bob's published "Essay" stays on the static host after Bob is removed (the same switch flipped in Settings re-pushes at once); the rename to "(left)" never appears in history. Package: `spaces.orphanPersonalSpace` via the space service; guard test on `UPDATE spaces SET … capabilities`.
- **D119 (S–M, bug):** `site_config` and `chrome` ship only in bootstrap; the delta never re-ships them (`SITE_CONFIG_UPDATED` not handled), the mirror keeps stale copies, `saveBlocks` replaces the whole chrome and publish sends the tab's blocks (which win over live chrome, `publishing/collections.ts:114`, stale comment). Input: edit the header in tab A, publish (or edit one block) in tab B → B's old header goes out / overwrites A. Package: delta re-ships site_config/chrome on `SITE_CONFIG_UPDATED`; `saveBlocks` sends its base and the server refuses a stale one (409). Client apply after #341 #306.
- **Small:** `POST /api/publish` has no idempotency claim (`buildAndEnqueueSnapshot` uses `event()`), so a retried publish makes a second snapshot/event/push; `PUT /api/site/access {mint:N}` replay answers deduped and the minted tokens are never shown; a saved view filter on a built-in date with a non-date value (`updated_at gt "2026-13-01"`, `tagViews.ts:40-43`) is accepted then 500s on every run (and #月曆); collection delete trashes only the tag root (D111 guard); V4 `setTagExtends` writes the whole list from the client catalog (can drop #月曆); stale comment in `modules/calendar/index.ts`.

### Checked and left alone (round 27)
Idempotency of queued/onlineWrite paths (root `mutate` claims; multi-transaction imports use fresh keys), spaces lifecycle services and token scope, tag field/ability readers and stable field keys, MCP tools sharing REST services, `app_settings` single owner, canvas board writes, server UTC vs browser zone (deliberate), system-note rule, outbox retry (round 22).
