# Sync protocol (offline-first, event-sourced)

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/routes/sync.ts, packages/backend/src/services/sync/**

Status: **draft / target** — spec first, incremental migration. Authored 2026-06-14.
Drivers: architecture review #7 (four-layer state has no formal sync protocol) + the
principle "offline sync should use the same mechanism as the current events" + the
license-clean clone study (any-sync DAG, Electric state machine).

## 0. The principle (one mechanism, both directions)

**The domain event log is the single sync mechanism. Offline is just "events not yet
synced." There is no second outbound channel.**

Today the model is asymmetric:

- **Inbound (server → client)** is already event-sourced: `GET /api/sync?since=<cursor>`
  pages rows from `domain_events` (`packages/backend/src/routes/sync.ts`), the client
  advances `last_event_id` and folds them in via `applySyncDelta`
  (`packages/frontend/src/lib/data/storeOps.ts`).
- **Outbound (client → server)** is NOT events: offline writes are buffered as raw HTTP
  requests in `pending_writes` (`{method, path, body, idem_key}`,
  `packages/frontend/src/lib/localDbWorker.ts`) and replayed as `api()` calls on
  reconnect (`flushPendingWrites`). The **server** turns the replayed request into events.

This asymmetry is the root of the four-layer-consistency problem (and the ink-reconnect
race we patched 2026-06-14): the client speaks "HTTP intents" while the server speaks
"events," so there is no single ordering, no client-side provenance, and the local mirror
can briefly disagree with both. The fix is to make the **client mint the same domain
events**, so both sides exchange one kind of thing.

## 1. The four layers and who is authoritative

| Layer | Role | Authority |
|---|---|---|
| Postgres `domain_events` | the durable, ordered event log | **source of truth** for *synced* history |
| Client local event log (in sql.js/OPFS) | locally-minted events, incl. an **unsynced tail** | source of truth for *not-yet-synced* local intent |
| Projection (app store + sql.js node/attr tables) | derived read-model | **never authoritative** — always rebuildable from the merged log |
| Pending queue | *retired* — folds into the unsynced tail of the client log | — |

Invariant: **the projection is a pure function of (synced log ⊕ unsynced local tail).**
Any disagreement is resolved by re-folding, never by trusting the projection.

## 2. Event shape (unify client + server)

Server events today: `NODE_CREATED/UPDATED/DELETED/RESTORED/PROMOTED`, `ATTRIBUTE_SET/DELETED`,
`TAG_*`, `EDGE`/`POINTER_*`, `CANVAS_*`, `COLLECTION_*`, `TAG_SCHEMA_UPDATED`, `ACTOR_*`,
`TOKEN_*`, `SITE_CONFIG_UPDATED`, … (one enum, already the spine's vocabulary).

The client mints these **same** event types. Each event carries:

- `event_id` — server sequence id once synced; before sync, a client-minted **stable id**
  (ULID/uuid; the existing `idem_key` becomes this id — replay-safe by construction).
- `parents` — the event_id(s) this change was made *against* (the client's known head[s]).
  This is the any-sync DAG idea: parents make ordering explicit and replay impossible to
  double-apply. Minimal form = the single `last_event_id` the client had when it minted.
- `actor` + **`source`** — who/what produced it: `human` | `agent` | and the input rail
  (`ui` | `markdown` | `frontmatter` | `dispatcher`). `source` is architecture debt **#1
  (attribute provenance)** — fold it in here so provenance is native to every event, not a
  later bolt-on.
- `ts` — client clock (advisory; ordering is by parents + server seq, not wall-clock).

## 3. Write path (client)

1. Optimistically apply to the projection (unchanged UX).
2. **Append a domain event to the local log** with a client-minted `event_id`, `parents =
   current head`, `actor/source`, payload. (This replaces `queueWrite`/`sendOrQueue` of an
   HTTP request.)
3. If online: push the event (see §4). If offline: it simply stays in the unsynced tail —
   nothing special happens, because offline ≠ a different code path anymore.

## 4. Reconnect / sync (the state machine)

Borrow Electric's sealed-state idea — sync is an explicit state machine, not timing:

`Offline → Draining(push) → Pulling → UpToDate` (and `→ Conflict` only if a merge needs a
non-commutative decision; see §5). **`online` flips true only on entering `UpToDate`** —
this is the generalization of the 2026-06-14 fix (drain before flipping online), now a
protocol state rather than an ad-hoc ordering.

1. **Push**: send unsynced-tail events (in DAG order) to a new `POST /api/events` (batch,
   idempotent by `event_id`). Server appends any it hasn't seen, assigns server seq ids,
   returns the mapping.
2. **Pull**: `GET /api/sync?since=<cursor>` as today — remote events the client lacks.
3. **Merge + re-fold**: order the union by (parents DAG, then server seq), re-derive the
   projection. Rebase the local tail's parents onto the new head.

## 5. Conflict resolution (reuse the commutative shapes)

Most concurrency is already commutative (see [[collab-merge-model]]) — merge needs no human:

- **tags** → grow-set union.
- **edges/pointers** → union.
- **attributes** → per-key LWW, **now tie-broken deterministically** by `(parents depth,
  ts, source-priority, actor id)` instead of "whoever's HTTP landed last." Source-priority
  encodes #1 (e.g. explicit UI > frontmatter > markdown-inline > dispatcher, configurable).
- **node body (text)** → 3-way char merge (diff-match-patch), already the editor's model.
- **non-commutative** (reparent vs delete, sort) → the only `Conflict` state; surface in
  the inbox (governance) for a human/agent decision rather than silently losing one side.

## 6. Idempotency, replay, mirror invalidation

- Replay-safe: events are keyed by `event_id`; re-pushing is a no-op (server dedups). This
  subsumes today's `Idempotency-Key`.
- Mirror invalidation stops being implicit: the projection is invalidated by *re-folding
  the merged log*, never by a GET racing an undrained queue (the bug class behind #2 of the
  reconnect review).
- Cold-start = load the log, fold to projection (the sql.js layer already persists; it just
  stores events + a projection cache instead of only the projection).

## 7. Migration path (incremental, low-risk — do NOT big-bang)

The current code already has the inbound half. Evolve outbound in steps, each shippable:

1. **Provenance first (#1)**: add `source`/`actor` to `ATTRIBUTE_SET` (and the client write
   helpers) — small, immediately useful, and the smallest piece of the event shape.
2. **Client event log alongside the queue**: introduce the local event log + minting, write
   BOTH (event log + existing `pending_writes`) but still replay via HTTP. Validate the
   projection re-folds identically.
3. **`POST /api/events`**: accept client-minted events (id + parents); server appends
   instead of re-deriving from an HTTP intent. Cut `flushPendingWrites` over to it.
4. **Retire `pending_writes`**: the unsynced tail of the event log replaces it.
5. **DAG ordering + state machine**: formalize parents + the `Offline/Draining/Pulling/
   UpToDate/Conflict` machine.

## 8. Deferred / out of scope (explicit)

- **Real-time multi-user CRDT (Yjs)** stays deferred — no real-time user yet
  ([[collab-merge-model]], [[offline-sync-decision]]). This spec is single-human +
  one-agent + multi-device-of-the-same-owner; the DAG gives a clean upgrade path to CRDT
  later without another rewrite.
- Full peer-to-peer (any-sync's transport/diff-hash exchange) is not adopted — we keep
  Postgres as the hub; only the **operation model** (signed, parent-referenced events) is
  borrowed.

## References

current code: `routes/sync.ts`, `lib/useAppData.ts` (sync/flushPendingWrites),
`lib/data/storeOps.ts` (applySyncDelta), `lib/data/writeQueue.ts`, `lib/localDbWorker.ts`
(pending_writes). Memory: [[architecture-debt-2026-06-14]], [[collab-merge-model]],
[[offline-sync-decision]], [[rebuild-foundation]] (event sourcing).

## Cursor acknowledgement correction (2026-09-13)

A delta page acknowledges only its scanned event window. A non-empty page returns
its final event id, including events that produce no readable projection; an empty
page returns the input `since`. A separate later `MAX(id)` must not advance an empty
page past a concurrent commit that the event query did not see. That batch only
fixed the cursor; see [core fix verification](../archive/core-design-fixes-2026-09-13.md).

## Implemented response snapshots (2026-09-13)

`GET/POST /sync`, `GET /sync/membership` and `POST /sync/nodes` now use
`withActorReadSnapshot` (built on `withReadSnapshot`) for their query-bearing response work. The actor/token authority, role-policy query,
scope membership queries, event window, membership epoch and all content channels
join the same `q()` client in a `REPEATABLE READ READ ONLY` transaction. Helpers
retain their domain interfaces; the transaction owner controls the snapshot.

A revoke committed after the snapshot can leave an in-flight response carrying
the prior content and epoch. It cannot authorize later content with that earlier
read set. A fresh request observes the revoke. Membership expectation mismatches
still return `retry_required`; a concurrent write no longer forces a retry of an
otherwise consistent page. Empty delta pages still retain `since`.

The first snapshot query now reloads the trusted actor ID in the requested
workspace and, when present, its still-valid owned token. The callback actor
carries current role and both scopes; stale authentication fields cannot grant
access to newer content. Invalid actor/token references return 401, database
failures remain 500. Native ID caching cannot decide these sync permissions.
See [actor freshness verification](../archive/actor-snapshot-fixes-2026-09-13.md).

This does not reauthenticate the session cookie itself, or refresh actor authority
for other reads/writes. Bootstrap and local mirror persistence do not share this
snapshot. The following batch covers membership pagination and event handoff.

## Implemented cross-request membership checks (2026-09-13)

Membership pages and by-id projections now return `{ epoch, event_cursor }` from
their actor/data snapshot. `event_cursor` is the decimal string of the workspace's
visible maximum domain event id. After the first page, callers send both
`expected_epoch` and `expected_event_cursor`. A mismatch returns
`retry_required: true` with the current pair and empty channels; this is a retry
marker, never an authoritative empty readable set. Epoch guards policy changes;
the event position also detects ordinary committed creation, deletion and edits.
No server transaction or snapshot handle is kept between HTTP requests.

`reconcileMembership` captures local IDs at the start of each attempt, drains the
pages, isolates revoked IDs, and fetches complete projections in batches of 1,000.
Each batch must match the pair and contain every requested node/task. Only after
application and a final version probe succeeds does it persist the epoch. Drift
restarts from current local state; failures and exhausted retries keep sync
incomplete. Local batches are not one atomic transaction and partial rows may
remain; they do not certify the epoch. The by-id endpoint explicitly rejects
more than 50,000 IDs with 413 instead of silently truncating.

The result's `eventCursor` is a catch-up requirement, not an acknowledgement.
Hydration preserves `last_event_id`. `sync()` continues scanning deltas from its
previous `since` until it has reached that position before opening the display
gate. It never jumps to membership's `MAX(id)`.

Old clients may omit the expected event position, retaining their old guarantees.
New clients reject missing/malformed versions; deploy the backend first when
updating separately. Writes outside the event/epoch contracts, bootstrap merging,
pre-existing pending local writes, cookie revalidation and real-device reconnect
remain outside this batch. Continuous writes may exhaust bounded reconciliation;
no performance or eventual-convergence guarantee is made under unending churn.
GAP-04 remains partial. See [cross-request verification](../archive/membership-pages-fixes-2026-09-13.md).

### Permanently refused queued input (implemented 2026-09-13)

The current SQLite queue retains a refused request with its original body and
idempotency key. A non-null `rejection` excludes it from replay and pending counts.
`writeRecovery` exposes this input after reload; the user can copy or remove it,
but cannot automatically replay a known refusal. Both rejection and removal wait
for durable persistence; failure restores the original row and stops the drain
when preservation failed. Authentication and transient retry behavior is unchanged.

Recovery input is not readable membership. Reconciliation can remove the live
node/task/attribute/edge projections, and slim bootstrap does not use rejected
requests to protect content mirrors. The retained body is only the original
request, not an additional remote snapshot. Zero pending requests therefore means
neither that recovery is empty nor that all changes were accepted.

This completes the permanent-refusal case, not the merge contract for still-active
pending writes or unqueued editor drafts. See [storage and browser verification](../archive/rejected-writes-fixes-2026-09-13.md).

### Active queued note text (implemented 2026-09-13)

The existing SQLite receive operations now return their effective projection.
Bootstrap, delta/membership hydration and single-node reads overlay active queued
node PATCH title/markdown onto supplied readable nodes. `useAppData` uses the
returned result; `loadBootstrap` uses the same projection for locally cached nodes.
This also handles queue durability preceding the optimistic mirror's persistence.
Empty text is an edit; base_markdown and structural/policy fields are not overlaid.

Remote deletions still remove mirrors. Slim-bootstrap protection is limited to
explicit queued POST /api/nodes creation IDs, rather than arbitrary ID references.
This narrows an existing exception; pending creation lifecycles are not fully
resolved. Other domains, newer already-accepted edits against late GET responses,
and multi-tab coordination remain outside this change. API-unreachable cold start
currently stops at LoginGate before the editor (GAP-20).
See [verification and remaining work](../archive/pending-note-text-fixes-2026-09-13.md).

### Tag catalog and functions (implemented 2026-09-29)

Tag catalog visibility uses `visibleClassTagRows`, distinct from content-node
membership: a scoped actor may see a granted tag without its node appearing in
the readable node set. Bootstrap supplies that catalog. Sync deltas include an
optional complete `tags` snapshot when a tag or its schema changes; omission
preserves the held catalog, while `[]` clears it. The first membership page also
supplies a catalog from the same actor read snapshot, so revocation does not
depend on a tag-targeted event.

The client persists this catalog separately and replaces it during membership
reconciliation before confirming the membership version. Node hydration cannot
reintroduce catalog entries excluded by the supplied snapshot. Tag schema
changes also refresh direct member rows, including their class/label tag IDs.
Module bindings travel in `schema_behaviour`, including after a cached reload.
These fields describe available functions; they do not grant permission.
See [module center contracts and evidence](../archive/research/tag-module-center-2026-09-29.md).

## Reopen: deltas, not the bootstrap (2026-10-19)

A device with a mirror and an event cursor is brought current by the deltas.
It used to download the whole bootstrap again on every reopen and every
reconnect: the slim one above 2,000 notes (3 MB at 5k, 10 MB at 20k), the full
one below. Now (`lib/data/syncEngine.ts`):

- **Reopen**: paint the mirror, sync (the gate waits for this only, #322), then
  on idle either the whole bootstrap, when the mirror last stored one more than
  a day ago (`sync_state.full_refresh_at`, written by `persistBootstrap`), or
  `GET /api/bootstrap?nodes=none`. A large workspace takes the same path and
  stays slim; its whole refresh is the slim one.
- **Reconnect** (a later offline→online flip): sync, then the same choice.
- **`resync_required`**: the whole bootstrap, as before.

`?nodes=none` (`nodes_omitted: true`) leaves out every per-node channel (nodes,
edges, tasks, pointers, attributes, blocks) and carries what the delta does not:
graph positions, suggestions, recent events, the tag catalog, site config,
chrome and the actor's flags — and the boards each note is on, in full (the
delta keeps those current between snapshots, below). The client stores the
workspace parts (`persistBootstrapMetaInto`) and merges the rest into the store
without touching a node.

### Boards a note is on (D98, 2026-10-21)

"Appears on canvases" (`canvas_memberships`: a `node_positions` row whose
surface is a live note's own id — a note with a whiteboard tab, docs/architecture/canvas-as-view.md —, both ends readable) has its own delta channel,
`canvas_memberships: { upsert, replace_for }`. A canvas is a node, so its events
(`CANVAS_CREATED`, `CANVAS_UPDATED` — a rename or a card placed, moved or taken
off) re-ship the canvas node like any node event; every shipped node then brings
every membership touching it, as note or as canvas, and `replace_for` (the
shipped ids) says that list is complete. The worker resolves it into explicit
deletes against the mirror (`replaceTouchingMemberships`), a deleted node takes
its memberships along, and the store applies the same resolved change
(`lib/canvasMemberships.ts`). The mirror keeps them (table `canvas_memberships`)
for a warm or offline start, and `canvasWriter.change` applies this device's own
placements at once (rolled back on a refusal).

Graph positions (`graph_positions`) are layout state written with no domain
event, so the delta cannot see another device's drag; they stay a bootstrap /
`?nodes=none` field. The mirror now keeps them (table `graph_positions`), and
`graphPositionWriter` writes this device's own placements into it. An older server ignores the parameter and answers with
its whole (capped) payload; without `nodes_omitted` the client discards it
rather than let a capped full payload replace a large mirror.

### Lean bootstrap: each attribute once, drawings on open (2026-10-19)

The client asks for every whole bootstrap with `X-Onden-Bootstrap: lean`
(a header, so the URLs and their caches stay as they were). The answer
(`attrs_omitted: true`, `deferred_attribute_keys: ["ink_data", "board_ink", "note_ink", "pdf_annotations", "pdf_text"]`):

- nodes carry no `attrs` map; it repeated every typed `attributes` row, and the
  client rebuilds it from them (`syncEngine.fetchBootstrap`);
- `attributes` leaves out those keys' values — drawings, the largest values a
  workspace has (`ink_data` was 38 of 64 MB raw of a 20k-note slim payload,
  sent twice). Every reader already loads them on open
  (`lib/ink/store` → `GET /api/nodes/:id/attributes?keys=`), and that read now
  keeps a copy in the mirror (`fillNodeAttributes`, never replacing one), so a
  drawing once opened opens offline. Deltas still carry drawing changes.
  Persisting a lean payload keeps the mirror's copies of those keys, except for
  notes a full payload no longer has. The in-memory `attrs` map never holds them
  (`loadBootstrap`).

A client that sends no header gets the old shape.

**Drawings offline.** So that a drawing never opened here still opens offline,
the client downloads the missing ones in the background
(`syncEngine.downloadDrawingsForOffline`): when idle, online, the tab visible
and Save-Data off, after the boot gate is down and after a reconnect.
`GET /api/sync/drawings` lists the readable notes holding any deferred key (`BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS`:
`ink_data` / `board_ink` / `note_ink` / `pdf_annotations` / `pdf_text`), each value's size and the SHA-256 of its UTF-8 bytes. The
client plans (`planDrawingDownload`): notes it holds without a copy, and copies
whose hash differs (a missed delta, a migration with no event) unless the note
has a queued attribute write or the copy was written in the last minute. It
fetches them with
`POST /api/sync/drawings {ids}` (at most 20 notes; the client sends 10 or
512 KB per request, one batch per idle slice). Each value is stored with
`fillAttributeRows` (never replacing a copy) or, for a stale one,
`replaceStaleAttributeRows` (only while the copy still has the planned hash and
nothing of its note is queued: the person's own strokes win); both are mirror
changes saved by the coalesced snapshot. It stops when offline or hidden and resumes on the next
boot or reconnect. The user-folder export (fs-access) and the manual `.sqlite3`
backup run it first, forced (also hidden or on Save-Data; a forced call that
finds a background pass waits for it, then runs its own). When it cannot finish
(offline, a failed request) the backup says how many drawings are missing,
counted from the last list read, instead of writing silently.
