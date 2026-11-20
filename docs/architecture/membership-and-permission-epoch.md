# Membership & membership-epoch (the read-membership reconciliation boundary)

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/services/readPolicy.ts, packages/frontend/src/lib/data/membershipDigest.ts

Status: **spec / in progress.** Companion to [`sync-protocol.md`](./sync-protocol.md).
The membership *diff* (positive grants + negative revocations + fail-closed
resync) is **implemented** in `routes/sync.ts`; the `membership_epoch` that
*gates* it (so reconciliation runs only when permissions changed, not on every
sync) is the **next step**. This document is the authoritative design.

## 0. The boundary (why this exists)

Two concerns are currently crammed into one endpoint (`/api/sync`):

1. **Incremental data delta** — "what content changed since cursor N", driven by
   the `domain_events` event cursor. High-frequency, cheap, additive.
2. **Read-membership reconciliation** — "which nodes may this actor read *now*",
   driven by diffing the client's held set against the current read policy.
   Triggered by *permission* changes (role, tag policy, token scope, reparent)
   that emit **no node-targeted event**, so the event delta alone can never
   carry them.

These are different axes and must not be conflated. The cursor advances on every
write; membership changes rarely but must be **fail-closed and immediate**. The
keystone that separates them is a **`membership_epoch`**: a monotonic version of
the read-policy state. The client reconciles membership **only when the epoch
advanced**; otherwise it takes the cheap incremental path.

> Event tells you how permission *was* changed (audit/restore/delta source);
> **permission state** decides whether access is allowed *right now*. They are
> written in the **same transaction** but read by **different models**.

## 1. Three layers (keep them distinct)

| Layer | What | Authority | Storage |
|---|---|---|---|
| **Permission state** | who may read/write what, *now* | the single source of truth | `actors.role`, `collection_schemas.policy` (tag policy), token scope, `content_nodes.parent_id` (ancestor cascade) — current tables |
| **Permission event** | who changed what, when (audit + notify + restore) | append-only history | `domain_events` (`ACTOR_UPDATED`, `TAG_SCHEMA_UPDATED`, `TAG_APPLIED/REMOVED`, …) |
| **Membership projection** | which node ids an actor should hold | *derived* from permission state | `readableNodeIdSet(actor)` (computed per request; never persisted per-actor) |

`readableNodeIdSet` (`services/readPolicy.ts`) is the SINGLE permitted input for
**every** read surface (bootstrap, sync, events, query, media, restore preview)
and for **both** directions of the membership diff. No route may re-derive read
rules. Policy is **most-restrictive-wins** (a node's required read rank = MAX
over all its tags + ancestors); a permissive tag never widens access.

## 2. Do NOT compute permission by replaying the event log

Permission is a **hot path** and must be judged against **current** state:

- Permission checks run on every request.
- One role / tag-policy / ancestor change can affect a huge number of nodes.
- Events may be paged, compacted, or archived (pruning, [`sync-protocol.md`] §6).
- Revocation must be **immediate and fail-closed**; it cannot wait on a client
  cursor or a replay.

So Onden keeps a **materialized current-state** (the tables above) and treats
`domain_events` as audit/restore/delta only. This is a deliberate **divergence
from any-sync** (which *replays* its ACL record log to compute state — correct
for a decentralized, E2EE peer model, wrong for a server-authoritative hot path).
See §7.

## 3. The membership_epoch protocol (target)

NAME: **`membership_epoch`**, not `permission_epoch` — node move / tag apply are
not "permission-rule" edits but DO change the readable set. The epoch tracks
"could the readable set have changed", which is the superset that matters.

```
Membership-affecting command
  → assert who may make this change (spine principal_admin / authority)
  → ONE transaction:
       update state (role / matter scope / token scope / tag policy / tag / parent)
       bumpMembershipEpoch(workspaceId)   -- workspace BIGINT monotonic counter
       append the domain event (audit + delta + restore)
  → commit
  → (optional) fire an SSE invalidation tick
```

**bump strategy (decided): the MUTATION declares it; the spine executes it.**
Do NOT infer membership-impact from the event TYPE — an event name describes the
RESULT, not whether the readable set moved: `ACTOR_UPDATED` may be a rename,
`TAG_SCHEMA_UPDATED` may touch only fields/views, `NODE_UPDATED` may be body /
title / parent. So the mutation site — which knows whether the role actually
changed, whether parent_id actually changed — DECLARES it:

```
mutate({ affectsMembership: true, … })   // spine bumps in the same tx
```

Declare `affectsMembership` when, and only when:
- actor role / matter scope / token grant actually changed,
- a tag policy READ rule actually changed,
- a permission tag was actually applied/removed on a node,
- `parent_id` actually changed,
- a restore reverts to ANY of the above states (restore is a mutate() too).
NOT for ordinary content / title / field / ink edits.

**Two landing shapes (until the spine absorbs everything).** `mutate()` is not
yet the only write chokepoint — tag apply/remove run through `withTransaction` +
`dispatchTagApply`. Same principle, two shapes:
- via `mutate()` → the `affectsMembership` flag.
- via dispatcher/`withTransaction` (tag apply/remove) → an explicit
  `bumpMembershipEpoch(workspaceId)` in that tx (always — they inherently move
  membership).
This gives [`spine-refactor`] a new "no bypass" reason: **bypassing the spine =
a missed bump = silent revocation failure.**

Event-type checks are only a **second-line leak guard** (a dev/test assertion
that membership-class events came from an `affectsMembership` mutation) — never
the primary mechanism.

**INVARIANT:** every successful transaction that can change the result of
`readableNodeIdSet()` MUST bump the workspace `membership_epoch`. A MISSED bump
is a stale-membership bug (client permanently retains revoked / misses granted);
OVER-bumping is merely a wasted reconciliation. Hence the bump tests are
two-sided (§8): positive per-mechanism (bump happened) AND negative (a plain
content/title/field/ink edit must NOT bump — else it degrades to full-set
reconciliation on every keystroke).

Sync (two axes):
  data:        event cursor (since)            → incremental changes        (every sync)
  membership:  membership_epoch (epoch)        → membership reconciliation  (only on change)
```

Client request: `{ since, epoch }`. Server response carries the current
`membership_epoch`.
- **epoch unchanged** → incremental event delta only; **skip** the membership
  reconciliation entirely — do not compute `readableNodeIdSet()`, do not carry
  `known[]` (the efficiency win).
- **epoch advanced** → run membership reconciliation (§4), then resume delta.
- **epoch unknown / regressed** → `resync_required` (drop mirror, re-bootstrap).

## 4. Membership reconciliation

The server does NOT persist a prior per-actor membership, so it cannot compute
`revoked` from the epoch alone. The diff happens where the prior state lives —
the **client** owns its complete local id set. So (option 3, chosen over
client-uploads-known and server-stores-snapshot): the server streams the CURRENT
readable id set; the client diffs it against its local set.

### Implemented paginated protocol (2026-09-13)

`GET /sync/membership?cursor=…&expected_epoch=N&expected_event_cursor=M` returns
`{ ids, next_cursor, epoch, event_cursor, retry_required? }`. The first request
may omit the expected event position. Each response uses `withActorReadSnapshot`:
the actor/token authority, readable set, epoch and maximum event ID come from one
`REPEATABLE READ READ ONLY` snapshot. The decimal-string event position also
changes on ordinary event-backed creation/deletion, which need not bump the
permission epoch. Keyset paging is checked against both fields across requests;
it is not a persistent database snapshot session.

`POST /sync/nodes` accepts `{ ids, expected_epoch, expected_event_cursor }` and
returns the full nodes/attributes/edges/tasks projection with the same version
fields. Either expectation mismatch gives `retry_required: true` and empty
channels. More than 50,000 IDs gives 413; no silent truncation. Existing callers
without expected fields remain supported, with their earlier guarantees.

### Digest first (2026-10-19)

Paging the whole set to learn that nothing changed cost a phone on 4G about
14 s at 20,000 notes (20 sequential pages of 1,000 IDs) on every reopen, since
each session's first reconcile always runs. `GET /sync/membership/digest?expected_epoch=N`
answers, in one read snapshot, `{ epoch, event_cursor, count, digest, buckets, tags }`
(or `retry_required` on a stale expectation):

- `digest`: SHA-256 (hex) of the readable IDs sorted by UTF-16 code unit
  (JavaScript's default sort) and joined with `\n`.
- `buckets`: for each two-character ID prefix, the first 16 hex digits of the
  same hash over that bucket's IDs.

The client hashes its held set the same way (`lib/data/membershipDigest.ts`,
Web Crypto). Equal digest and count: the set is current as of that snapshot, so
it applies the tag catalog, saves the epoch and returns the digest's event
position, with no pages. Unequal: it pages only the unequal buckets
(`GET /sync/membership?prefixes=ab,cd`; at most 64 buckets, otherwise all of
them) in pages of up to 5,000 IDs (`limit`, server cap `MEMBERSHIP_PAGE_MAX`),
and counts as revoked only the held IDs in those buckets. Everything after that
is the flow below, scoped the same way, final probe included. An older server
(no `digest` field) or a page without Web Crypto (plain HTTP on a LAN address)
pages everything, as before. A digest never removes anything by itself: it only
lets an equal set skip the pages.

### Client reconciliation flow (gated and restartable)

1. Capture the complete held node ∪ task IDs before starting each attempt.
   Compare digests first (above).
2. Drain pages, checking epoch and the event position discovered on the first page.
3. On drift or `retry_required`, restart from current local state (at most five restarts).
4. Compute revoked and newly readable IDs. Isolate revoked IDs before applying grants.
5. Hydrate grants in batches of 1,000, checking each version and complete node/task coverage.
   Apply every projection channel without advancing the event cursor.
6. After local application, make a final version probe. Drift restarts; only a
   successful probe permits saving the epoch and returning `done.eventCursor`.
7. Sync continues to read deltas from its existing `since` until that event position
   has actually been scanned, then lowers the display gate. Never assign the
   membership event position directly to the saved cursor.

Application is **not one atomic local transaction**: partial batches may survive
an error. The epoch is not certified on partial success; the next attempt diffs
against current local state. Missing or malformed version fields stop new clients
without deleting local data. Deploy the backend first for separate client/server
updates. Routine client sync no longer sends `known[]`; the backend retains that
legacy path and its cap response.

### Boundary of the guarantee

The version check covers writes following the domain-event and permission-epoch
contracts. It cannot detect arbitrary direct SQL that updates neither. Capturing
local IDs before each attempt excludes IDs created later in that attempt from
revocation; pre-existing pending writes and creations spanning retries need a
separate local-write audit. Bootstrap, session-cookie revalidation and true device
reconnect/persistence are also not certified by this batch. A busy workspace may
exhaust bounded retries and remain gated until a later attempt.

A revocation may still commit after the final check. Existing realtime membership
invalidation and subsequent sync/reconnect checks remain necessary; absence of an
SSE tick is not evidence that the membership stayed unchanged. See
[cross-request tests and limits](../research/membership-pages-fixes-2026-09-13.md).

### Realtime invalidation (SSE) — the protocol

Registered via `afterCommit()` (`spine/txHooks.ts`, the same hook the domain-
event tick uses): a committed membership bump fires the tick; a rollback fires
nothing. The frame is BLIND (no sensitive data, like the existing event tick):

```
{ "kind": "membership_changed", "epoch": 14 }
```

Client on receipt:
1. **enter a membership-gated state** — pause showing/reading possibly-restricted
   local content. Background-reconciling while STILL showing old data is NOT
   fail-closed.
2. reconcile (§4) → isolate revoked → finish newlyReadable + local commit.
3. lift the gate.

Two rules:
- **the tick's `epoch` is a wake-up HINT, not the target** — ticks can arrive
  reordered or stale; the client just "goes to reconcile", and the authoritative
  epoch is the one read inside the reconciliation handshake (the snapshot-
  consistent page reads). NEVER use the tick's number as `expected_epoch`.
- **coalesce to "reconcile to latest", not per-tick replay** — via a DIRTY LATCH,
  which is strictly more reliable than plain debounce (debounce can drop a tick
  that lands AFTER reconciliation already started; the latch guarantees another
  pass):
  ```
  tick → mark stale → gate → if not already reconciling, start reconciliation
  during reconciliation: further ticks only set dirty = true
  on completion: if dirty OR the server epoch advanced again → run again
  stable (clean + epoch unchanged) → lift the gate
  ```

Gate scope (CORRECTED — direct-tag narrowing is NOT safe):
- The naive narrowing "gate only nodes that locally carry an access-controlled
  tag" is **unsafe**: readability also changes when an ANCESTOR gains a
  restrictive tag (the child carries none), when a plain node is REPARENTED under
  a restricted ancestor, when actor ROLE / token SCOPE changes (affecting far
  beyond directly-tagged nodes), or via any future read-policy dimension.
- Narrowing therefore requires a **conservative local projection with the same
  semantics as `readableNodeIdSet()`** — call it `potentiallyPolicyAffectedNodeIds`
  — that PROVABLY ⊇ the true affected set: directly-controlled nodes + ALL their
  descendants + every node any active actor/token scope could touch. Looking at
  direct tags alone misses cases.
- **v1: when membership is stale, gate ALL local content.** **v2: build the
  conservative affected-set projection, then narrow the gate to it.**

Livelock: if reconciliation keeps restarting because the epoch is changing at high
frequency, do NOT spin forever and do NOT ungate on a timeout (never trade safety
for UX). Back off, stay GATED, and surface "permissions updating".

`readableNodeIdSet` is the single source; reference-count correct under most-
restrictive-wins. Tested in `syncRevocation.integration` (4 revocation mechanisms
+ GRANT + reference-count + backstop) and pinned in `modelInvariants.integration`.

## 5. Local GC lifecycle + reconnect order (client)

Reconnect order (fail-closed):
```
network recovered
  → stay offline / gated
  → drain / handle pending writes
  → compare membership_epoch
  → if changed: reconcile (§4) — isolate revoked, then newlyReadable + local commit, then save epoch
  → flip online
```

On a revocation the local GC runs, in order:
1. **isolate immediately** — drop the node from the in-memory store + any open view (fail-closed; `applySyncDelta`).
2. **de-index** — clear local search-index entries, adjacency, cached attachments/media for that node (TODO: index + attachment GC not yet explicit).
3. **physical GC** — remove the row + body blob from the local mirror (sql.js/OPFS) (partial via the worker cascade-delete).

Not yet a named lifecycle; today it is the initial `nodes.delete` application only.

## 6. Bump triggers (the membership-affecting set)

The epoch MUST bump (in-tx) on any change that can alter *some* actor's readable
set. Over-bumping is safe (a redundant reconciliation); a *missed* bump is a
stale-membership bug. The set:

- `ACTOR_UPDATED` where role changed.
- Token scope change (`allowedTagIds`).
- Per-person scoped-tag change (`actor.scopedTagIds`, mig 066).
- `TAG_SCHEMA_UPDATED` / tag-policy change (read rank).
- `TAG_APPLIED` / `TAG_REMOVED` (a node gains/loses a restrictive tag).
- `TAG_MERGED` (folds tags → membership shift).
- `NODE` reparent (`parent_id` change → ancestor-cascade read change).
- a restore that reverts to ANY of the above states.
- `NODE_DELETED` / `NODE_UNDELETED` / `NODE_PURGED` already carry node events, but
  reparent/policy do not — those are the epoch's reason to exist.

Must NOT bump (the negative matrix — over-bump = full-set reconciliation on every
edit = perf death; tested negatively in §8):
- body / title edits,
- non-policy schema changes (fields / views),
- ordinary attributes, ink pointers,
- pure sort_order / canvas-coordinate changes — UNLESS they actually alter an
  ancestor relationship that feeds the read cascade.

Declared by the mutation (`affectsMembership` / explicit `bumpMembershipEpoch`),
executed once in-tx by the spine — see §3. **Use `q()`, never `pool.query()`** —
`q()` joins the caller's AsyncLocalStorage-bound tx so the bump is atomic with
the state change + event. A `pool.query()` would commit independently and (a) on
a later rollback leave a phantom epoch (clients reconcile against unchanged
state), or worse (b) bump BEFORE the state change is visible, so a client
reconciling in that window reads the OLD readable set and MISSES the change until
the next bump. Never scatter raw epoch UPDATEs; never infer membership-impact
from the event type (that is the leak-guard only).

## 7. Clone study (license-clean: any-sync MIT, electric Apache 2.0)

Verified licenses before reading (iron rule). anytype-heart (Source Available),
AFFiNE (MPL), AppFlowy/siyuan (AGPL) were **not** read.

**any-sync** (`any-sync/commonspace/object/acl/…`):
- ACL = append-only record log; each grant/revoke/role/key-change is a record
  with a `PrevId` parent ref; the **ACL head id** is the epoch. ✔ *adopt the
  head-as-epoch idea.*
- Permission state is computed by **replaying** the record log
  (`aclstatebuilder.go` `ApplyRecord` per record). ✗ *reject for Onden's hot
  path — keep materialized state (§2).*
- Each data change binds the `AclHeadId` it was authorized under → temporal
  validation ("permissions at record X"). ◑ *optional future: bind the epoch a
  mutation was authorized under for audit.*
- Revocation = read-key rotation + per-member encrypted key distribution
  (`AclReadKeyChange`). ✗ *E2EE-only; Onden is plaintext + query-time policy.*
- Membership reconciliation is **implicit** (you can't decrypt without the key).
  Onden needs an **explicit** diff (§4) because enforcement is query-time.

**electric** (`electric/packages/…`):
- Two orthogonal axes: **offset/LSN cursor** (incremental) vs **handle rotation +
  409 `must-refetch`** (reconciliation). ✔ *exactly our cursor-vs-epoch split.*
- A shape (table + where) changing identity → new handle → client **full
  refetch**. ◑ *Onden does better than full-refetch: a membership delta — but
  keep `resync_required` as the coarse fail-closed fallback (§3).*
- `must-refetch` is a **separate control message**, not a data op. ✔ *model
  `resync_required` / epoch the same way: not an incremental row.*

Net: Onden = electric's cursor/epoch split + an explicit membership delta (not
full-refetch), with materialized state (not any-sync replay) and no key crypto.

## 8. Status & remaining steps

2026-09-13 queued-refusal follow-up: a permanently refused local request survives
as recovery input while the unreadable content mirror is removed. Rejected rows
do not protect slim-bootstrap mirrors or participate in replay. This does not
complete merging for active pending writes; see [verification and limits](../archive/rejected-writes-fixes-2026-09-13.md).

- ✅ Membership diff (INTERIM path): revocation (4 mechanisms), positive grants,
  reference-count, fail-closed `resync_required` cap. (`routes/sync.ts`,
  `syncRevocation`/`modelInvariants`/`eventsFeed` tests.) **Still active** — the
  robust safety net until Step C.
- ✅ Permission state materialized + read via the single `readableNodeIdSet`.
- ✅ **Step A DONE**: `workspaces.membership_epoch` (mig 068) + `bumpMembershipEpoch`
  (`q()`-based) + `mutate({ affectsMembership })`; wired for reparent / tag
  apply-remove / actor role+scope / tag policy / token re-scope+revoke+delete /
  tag merge / membership-reverting restores; epoch exposed on the sync response.
  Two-sided bump tests (`membershipEpoch.integration`). Taking a change bundle
  from another node (`applyChangeBundle`) bumps it too, on that node only, when a
  note's derived space or a space's shown deletion changed (migration 218;
  `mergeSpaceParent.integration` "a note under the moved one…").
- ✅ **Step B implemented**: `GET /sync/membership` (keyset, one read snapshot per
  page as of 2026-09-13 — see §4 and GAP-04 limits) + by-ids content fetch
  (`POST /sync/nodes`) + the pure client orchestrator (`membershipReconcile.ts`:
  epoch-stable drain → final re-confirm → isolate-revoked-first → atomic
  apply+save-epoch) + the three failure-recovery tests, wired epoch-gated into the
  sync loop. Belt-and-suspenders with the interim path (no-ops when interim
  already applied the diff).
- ✅ **Step C DONE**: the routine client no longer sends `known[]` — `POST /sync`
  is a pure event-delta pull (`useAppData` sync loop sends `{since}` only).
  Revocation + grants flow solely through the membership pipeline (GET
  /sync/membership + epoch-gated reconcile + cold-start full reconcile + the
  membership_changed SSE tick + on-reconnect handshake), all fail-closed behind
  the display gate. Drops the per-sync `getAllMembershipIds()`+payload cost.
  `POST /sync` still computes `readableNodeIdSet` (it read-filters the event-delta
  upserts — that never went away). The server's `known[]` diff is RETAINED as a
  legacy capability (a caller may pass `known` for a one-shot full diff; exercised
  by `syncRevocation.integration`) but is no longer the live revocation path.
  Prerequisites that gated this, all met:
  - ✅ **(review #3 DONE) by-ids grant hydration is COMPLETE**: `POST /sync/nodes`
    returns the FULL projection (nodes + attributes channel + edges both-ends-
    readable + synthesized tasks); the client builds a full SyncDelta so applySync
    persists every channel. The data-completeness blocker is cleared.
  - ✅ **(DONE) cold-start full reconcile** safety net: the first reconcile of a
    session runs unconditionally (forced full diff) and gates the cached paint
    gate-first (`useAppData` `coldStartReconciled`).
- ✅ **Step D DONE (online + cold-start fail-closed)**: a real membership display
  GATE (`appStore.membershipGated`), NOT the online flag. `maybeReconcileMembership`
  raises it when a reconcile is needed, lowers it only on convergence; a failed /
  exhausted reconcile leaves it RAISED (self-healing). BuilderApp renders an opaque
  `inert` + `aria-hidden` "Updating permissions…" scrim while gated. Instant via
  the SSE blind tick `{membership_changed,epoch}` (`realtime.ts` + `afterCommit` in
  `bumpMembershipEpoch`, RETURNING the epoch; rollback fires nothing) → client
  dirty-latch (raise on tick, reconcile, lower). Lost-tick recovery: liveEvents
  fires `onReconnect` on each SSE (re)connect → BuilderApp re-handshakes (gate +
  sync). Tests: backend bump→commit→tick / rollback→none; frontend real-tick →
  handler, reconnect → handshake, gate clears/keeps/latches.
- ▢ **Step E**: name the §5 local GC lifecycle (isolate → de-index → physical GC),
  incl. local search-index + attachment cleanup on revoke.
- ▢ **Step F** (optional/audit): bind the authorizing epoch onto each mutation
  (any-sync's per-change `AclHeadId`, §7).

## References

- [`sync-protocol.md`](./sync-protocol.md) — the offline-first event-sourced base.
- `services/readPolicy.ts` — `readableNodeIdSet` / `visibleNodeIdsForActor` (the single read-policy source).
- `routes/sync.ts` — the membership diff (this doc §4).
- any-sync (MIT), electric (Apache 2.0) — clone study (§7).
