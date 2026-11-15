# Backend modules

The minimal in-repo plugin shape: a **module is one directory + one registry
entry**, deletable in one commit. This is deliberately NOT a plugin *system* —
no dynamic loading, no sandboxing, no versioned manifest (all deferred, see
[[agent-extensibility-and-approval]]). It is a cohesion convention so a
capability's routes, services, algorithm code and tests live together instead
of being smeared across `routes/`, `services/` and `index.ts`.

## Shape

```
src/modules/<id>/
  index.ts     ← exports the ModuleDefinition
  routes.ts    ← the module's Hono router(s)
  *.ts         ← module-private services / algorithms
  *.test.ts    ← pure unit tests (DB-free; integration tests live in src/test/
                 with the rest of the suite so the docker run picks them up)
```

Register it in `modules/index.ts` (`MODULES` array). `index.ts` calls
`mountModules(app)` once — that's the only seam the core knows about.

## What a module MAY own

- **HTTP routes** under `/api/<id>` (mounted via `registerRoutes`).
- **Agent tools** (`agentTools[]`) — fed into `services/agentTools/registry`,
  which is the agent permission boundary. Adding one widens what agents can
  do; treat it as a security decision. Prefer read-only, scope-bounded tools
  (e.g. `review`'s `reviewQueue`: calls the same service `queue()` the HTTP
  route does, so it returns the very cards the app shows, through the same
  `readableScopeSql` gate; an agent can pull the study queue and work solutions with the existing write tools — but never
  grades, since grading models a human's memory). `mountModules()` may run
  more than once in a process (tests re-mount), so the registry treats
  re-registering the identical tool object as a no-op while still rejecting a
  different tool that claims a taken name.
- A module does not register tag-behaviour handlers: tag automation was removed
  (2026-11-15). Work a tag triggers belongs to a function the module owns.
- **Attrs-namespaced state**: per-node state goes in `node_attributes` under a
  reserved `_<id>_*` key (e.g. `_review_state`). Reserved keys are already
  blocked from the user attribute routes, so the module's endpoints are the
  only writers. Mutate via `ATTRIBUTE_SET` through the spine and you get
  inverse-undo + inbox governance for free.
- **Settings are rows, not notes**: configuration a person manages on a page
  (RSS subscriptions, `rss_subscriptions`, migration 145) lives in a table of
  the module, not in a note with `_<id>_*` attributes: nobody edits it as
  writing, so it should not sit in the note tree. It keeps the space rule — the
  row carries `space_id` and is read with `readableSpaceScopeSql`
  (`services/readPolicy.ts`), written under the workspace event lock by the
  current actor with `space_write` on that space — but records no domain
  event, so it has no history to restore (spineGate allowlists the writer).
  Reach for this only for settings; anything a person writes or links stays a
  note.
- **Explicit tag capabilities**: a module with `library.moduleTag` has a
  module tag (`tag_schema.module = "<id>"`, #複習 for review); a tag gets the
  module's function by extending it (`tag_schema.extends`, any depth —
  `services/tagModules.ts effectiveTagModules`), and the legacy switch
  `tag_schema.behaviour.modules`, for example `{ "review": { "enabled": true } }`,
  still counts. Titles are display names, so renaming does not retire a
  capability. Only direct memberships enrol a note; a tag follows the settings
  of its source (the nearest tag on its extends chain that provides the module
  itself). Removing the last enabled tag or disabling its module preserves
  reserved state and stops participation. Existing special names are migrated
  once; runtime name fallback must not reactivate a disabled module. RSS still
  uses its existing `subscription` name contract. See
  [`module-library.md`](../../../../docs/architecture/module-library.md).
- **Review settings**: `behaviour.review` on the review module tag (while the
  workspace still has one) and a person's own override (`actor_module_settings`)
  steer only the FSRS scheduler. Values are clamped server-side:
  `request_retention` 0.7–0.97 (default 0.9), `maximum_interval_days` 1–36500
  (default 36500). FSRS weights are not configurable. `new_per_day` is **no
  longer read** and the personal-settings routes refuse it; how much a person
  reviews in a day is the one cap `reviewsPerDay` (actor_prefs), which counts due
  and new cards together. Stored `new_per_day` values are removed in part two.
- **Review composition**: a card is a note or paragraph holding its own review
  function reference (`function_refs`, migration 195); tags never make a card,
  they only pick which cards to study (`tag_id`: the tag, tags under or extending
  it, and the paragraphs of those notes). One card has one schedule per person
  (`review_states`); grading rechecks actor, live content type, the card's own
  reference, settings and write authority within one event transaction. Explicit
  subtree study (`root`) is a filter too: new cards fill what the daily cap leaves.
- **Review stats**: `queue`/`stats` accept `tag_id` (a filter) after a workspace/tag visibility check. Stats are `due`, `new`, `learned` and `new_available` (the new cards today's cap still allows).
- **Needing another module**: `library.requires` (skills need ai) makes a module on only while
  the ones it names are on (`workspaceModules` `moduleOn`); turning it on while one is off is refused
  (400), and its data is kept. `gatesCoreAgentTools` (ai only) puts the built-in agent tools
  (searchNodes, getNode, updateNode…) behind the module's switch.

- **Start-up and takedown seams**: `library.whenTurnedOn(workspaceId)` runs
  inside the transaction of the owner turning the module on (file an outbox
  intent, nothing else; semantic search indexes the notes already there).
  `nodeHooksWhenOff: true` lets a module's node hooks run while it is off, only
  for hooks that can never add anything (the website's takedown re-push); the
  module's routes stay gated, so a live site is still served and can always
  be taken down. See [`decisions-modules.md`](../../../../docs/agents/decisions-modules.md).

## What a module may NOT do

- **No new parallel tables for node-ish state** without strong, written
  justification. `node_tasks` is the cautionary tale ([[collab-merge-model]]:
  parallel tables don't merge, don't restore, don't govern). Default to
  node + tag + namespaced attribute.
- **No bypassing the spine.** Every mutation goes through `mutate()` — actor
  required, authority checked, event emitted, atomic. The spine-gate test
  (`src/test/spineGate.test.ts`) scans `modules/*/` with the same three gates
  as `routes/` (raw `event()` freeze, mutate()-presence, pool.query-mutation
  freeze) — and the module allowlists are EMPTY; keep them that way. The
  workspace-boundary lint covers `modules/` too.
- **No third rails.** External state crosses on inbox/outbox only
  ([[product-thesis]]). A module wanting outbound effects files outbox rows
  (risk-tiered approval included); it does not invent its own queue.
- **No unbounded reads.** Every queue/stats/list endpoint a module exposes
  MUST filter through the appropriate public `readPolicy` query gate, such as
  `readableScopeSql` or `readableNodeIdSet` — policy is not re-derived per module. This is an
  iron law, not a guideline: every read-policy bug so far was caught in
  review, not in development.

## Frontend twin

`packages/frontend/src/modules/<id>/` holds the module's components +
an `index.ts` with its exports. See that README for wiring conventions.
