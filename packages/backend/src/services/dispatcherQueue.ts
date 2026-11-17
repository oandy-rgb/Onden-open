// A2 — per-node post-commit dispatcher queue.
//
// Why: thesis 「不受表達限制的腦力激盪 + 速度 capture」 requires PATCH
// /api/nodes/:id to return as soon as the row is COMMITted, not after
// every derived attribute write has run. Heavy derivations
// (syncAttributesAndDispatch + syncFrontmatterAttributes) move here.
//
// What this gives us:
//   - PATCH returns in ~30ms (DB COMMIT) instead of waiting for cascade
//   - Per-node serialization: a second PATCH for the same node waits
//     for the previous cascade to finish before its own queues, so the
//     dispatcher sees deltas in order
//   - Different nodes have independent queues; each derived write transaction
//     still serializes with other writes in its workspace through the event lock
//   - DISPATCHER_FAILED audit event when a cascade throws — admin
//     looks at domain_events to see what didn't fire
//   - In-flight count introspection for tests + future UI "pending"
//     indicator
//
// Why in-memory (not Redis / job table):
//   - A task that throws a TRANSIENT database error (serialization failure,
//     deadlock, lock timeout, pool exhausted, dropped connection) is re-run
//     in-process up to 3 more times (200ms / 1s / 3s) before the
//     DISPATCHER_FAILED audit, whose payload says how many attempts were made.
//     The chain stays blocked meanwhile, so same-node order holds. Other errors
//     are deterministic and run once. Boot catch-up does not retry.
//   - Single-backend-instance assumption holds for the foreseeable
//     future. When Phase J (ElectricSQL + multi-instance) lands, we
//     swap this for a queue backed by domain_events polling.
//   - Failure mode if process crashes mid-cascade: the NODE_UPDATED
//     event is already committed; the cascade emitted events would be
//     missing.
//
// M1 — crash recovery (the "dispatcher catchup" the paragraph above used
// to defer). Design:
//   - DURABLE INTENT, not a high-water mark. Call sites insert a
//     dispatcher_pending row (migration 065) INSIDE the trigger's own
//     transaction via enqueueCascadeIntent() — same move as the outbox
//     (mig 046) — and queueDispatcher deletes it once the task settles
//     (completed, or failed-and-audited via DISPATCHER_FAILED; a
//     deterministic throw must not be retried at every boot forever).
//     Whatever survives in the table at startup is therefore exactly a
//     crash victim: trigger committed, cascade never reached its
//     success/fail handler. A high-water mark over domain_events.id was
//     rejected because ids are minted at INSERT but become visible at
//     COMMIT: a concurrent slow transaction can commit an id BELOW an
//     already-advanced mark and its cascade would be unrecoverable.
//   - REPLAY = re-run the same convergent reconcilers
//     (syncAttributesAndDispatch + syncFrontmatterAttributes — all three
//     queueDispatcher call sites queue exactly this pair) against the
//     node's CURRENT markdown. Idempotency arbiter: the syncs diff
//     markdown-extracted attributes against node_attributes and only
//     write + dispatch on a CHANGED key (services/nodes.ts), so replaying
//     a completed cascade emits nothing — verified for every effect kind
//     a replay can reach (set_attribute / delete_attribute; set_hidden is
//     a retired no-op; notify only fires behind a changed-key
//     dispatch). Live post-commit derivation and catch-up both acquire the event
//     lock, refresh actor authority, and commit parsed attributes plus derived
//     events in one transaction. Failure rolls back before the failure audit.
//   - ATTRIBUTION: the row stores the trigger's root actor id (+ bearer
//     token id when present). Replay reloads the actor and re-derives the
//     token's tag scope, so replayed cascades carry the ORIGINAL actor —
//     mutate()'s cascade rule — and keep the original authority bound
//     (a revoked/expired token skips the replay rather than escalating
//     to unscoped). Token replay also restores the originating tool from the
//     matching trigger event, then checks its CURRENT grant. Legacy token
//     intents lacking verifiable tool/token metadata fail closed with an audit;
//     ordinary non-token intents remain supported. triggered_by chains to the
//     original trigger event.
//   - Runs at startup (everything pending is a crash leftover; nothing of
//     ours is in flight yet) and on a slow interval as a belt-and-braces
//     pass, with a grace window + in-flight skip so it never races a live
//     chain. Single-instance assumption (above) is what makes "not in my
//     chains map" mean "not running anywhere".

import { event, pool, q } from "../db.js";
import { onBeforePoolEnd } from "../dbClose.js";
import { log } from "../logger.js";
import { startPeriodicJob } from "../backgroundJobs.js";
import { isTransientDbError } from "../dbErrors.js";
import type { ActorCtx } from "../types.js";
import { liveNodeSql } from "../spine/nodeSql.js";

/** Active cascade chains keyed by node id. Each value is the tail of
 *  the chain; the next queueDispatcher call awaits it before running. */
const chains = new Map<string, Promise<void>>();

export interface QueueOptions {
  workspaceId: string;
  nodeId: string;
  actorId: string;
  /** A short label of what's being queued. Surfaces in DISPATCHER_FAILED
   *  events so admins can tell what cascade failed. */
  label: string;
  /** M1: the trigger event guarded by a dispatcher_pending intent row.
   *  When set, the row is deleted once the task settles (success or
   *  audited failure) — the durable "this cascade ran" marker the
   *  catch-up job keys on. Absent = legacy fire-and-forget semantics
   *  (no intent row was enqueued; nothing to clean up). */
  triggerEventId?: string;
  /** Retry a failed task in-process when the error looks transient
   *  (dbErrors.isTransientDbError). Default true. Boot catch-up passes false:
   *  a leftover intent that fails is audited once, as before. */
  retryTransient?: boolean;
}

/** Waits before retries 1..3 of a transiently failed task (1 + 3 attempts).
 *  Bounded on purpose: the chain for this node is blocked while we wait. */
const RETRY_BACKOFF_MS = [200, 1000, 3000] as const;

/** The database is closing (see closeDispatcher): a task waiting to retry stops waiting and is not re-run. */
let closing = false;
const retryWakers = new Set<() => void>();
const CLOSED_BEFORE_RETRY = Symbol("dispatcher closed before the retry");

/** Run `task`, re-running it after a transient failure. Safe because every
 *  queued task is the convergent reconciler pair described in the header and
 *  runs in one transaction that rolls back on throw, so a failed attempt
 *  leaves nothing behind and a re-run only writes what is still missing.
 *  Throws the last error, tagged with the attempts made. */
async function runWithRetry(
  task: () => Promise<void>,
  retryTransient: boolean,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await task();
      return;
    } catch (err) {
      const wait = RETRY_BACKOFF_MS[attempt - 1];
      if (!retryTransient || wait === undefined || !isTransientDbError(err)) {
        throw { original: err, attempts: attempt } satisfies AttemptedError;
      }
      if (closing) throw CLOSED_BEFORE_RETRY;
      log.warn("dispatcher", `transient failure, retrying (attempt ${attempt})`, { err });
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); retryWakers.delete(wake); resolve(); };
        const timer = setTimeout(wake, wait);
        retryWakers.add(wake);
      });
      if (closing) throw CLOSED_BEFORE_RETRY;
    }
  }
}

/** The last error of a task plus how many attempts it took. */
type AttemptedError = { original: unknown; attempts: number };
const isAttempted = (e: unknown): e is AttemptedError =>
  typeof e === "object" && e !== null && "attempts" in e && "original" in e;

/**
 * M1: enqueue the durable cascade intent. MUST be called inside the same
 * transaction as the triggering domain_event + state change (i.e. inside a
 * mutate() apply()) — it routes through q(), which binds to the open
 * transaction, so a crash before COMMIT leaves no orphan intent and a crash
 * after COMMIT leaves exactly the row the catch-up needs. Mirrors
 * enqueueBackup (services/outbox.ts) discipline.
 *
 * ON CONFLICT: one trigger event has one cascade; re-enqueueing the same
 * event id (shouldn't happen, but restores/retries are conceivable) keeps a
 * single row.
 */
export async function enqueueCascadeIntent(opts: {
  workspaceId: string;
  nodeId: string;
  actor: ActorCtx;
  label: string;
  eventId: string;
}): Promise<void> {
  await q(
    `INSERT INTO dispatcher_pending (event_id, workspace_id, node_id, actor_id, token_id, label)
     VALUES ($1::bigint, $2, $3, $4, $5, $6)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      opts.eventId, opts.workspaceId, opts.nodeId, opts.actor.id,
      opts.actor.tokenScope?.tokenId ?? null, opts.label,
    ],
  );
}

/**
 * Queue a post-commit dispatcher task for a node.
 *
 * Returns a Promise that resolves when THIS task finishes (or fails).
 * The PATCH handler does NOT await this — it's fire-and-forget — but
 * tests + the smoke script use the returned Promise to confirm the
 * cascade completed before asserting on side effects.
 *
 * Errors are caught and emitted as DISPATCHER_FAILED events; they
 * never propagate to the PATCH caller (because the caller has already
 * received the 200).
 */
export function queueDispatcher(
  opts: QueueOptions,
  task: () => Promise<void>,
): Promise<void> {
  const prev = chains.get(opts.nodeId) ?? Promise.resolve();
  // .catch on prev: a previous task's failure shouldn't block the next
  // one from running. The failure was already audited via
  // DISPATCHER_FAILED at the time it happened.
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      try {
        await runWithRetry(task, opts.retryTransient !== false);
      } catch (thrown) {
        // Closing, not failing: no audit, and returning here skips the intent DELETE below, so the
        // next boot's catch-up replays the cascade.
        if (thrown === CLOSED_BEFORE_RETRY) return;
        const { original: err, attempts } = isAttempted(thrown) ? thrown : { original: thrown, attempts: 1 };
        await event(
          opts.workspaceId, "DISPATCHER_FAILED", "node", opts.nodeId,
          {
            label: opts.label,
            attempts,
            error: err instanceof Error ? err.message : String(err),
            // Top 3 stack frames are usually enough to pinpoint;
            // domain_events.payload is jsonb and we don't want bloat.
            stack_head: err instanceof Error
              ? (err.stack ?? "").split("\n").slice(0, 3).join("\n")
              : undefined,
          },
          "system", opts.actorId,
          {
            txMeta: { ui_context: "dispatcher.post_commit_failed" },
          },
        );
      }
      // M1: the cascade SETTLED — completed, or failed-and-audited above.
      // Either way the durable intent is consumed: catch-up replays crash
      // victims (no settle ever ran), never audited failures (replaying a
      // deterministic throw at every boot would loop forever; the
      // DISPATCHER_FAILED event is the admin's signal to act). A crash
      // between task completion and this DELETE leaves the row behind —
      // harmless: replay of a completed cascade is a no-op (see header).
      if (opts.triggerEventId) {
        try {
          await pool.query(
            `DELETE FROM dispatcher_pending WHERE event_id = $1::bigint`,
            [opts.triggerEventId],
          );
        } catch (e) {
          // Cleanup failure must not poison the chain (and must not reject a
          // promise nobody awaits). Worst case the row survives and the next
          // catch-up replays a completed cascade — a no-op by design.
          log.error("dispatcher", "intent cleanup failed", { err: e });
        }
      }
    });

  // tail = the actually-stored promise. We chain cleanup as a `.finally`
  // and assign the resulting promise to the map AND return it. This way
  // a caller awaiting the return value also waits for the cleanup; the
  // inflight tracking is consistent after `await`.
  const tail: Promise<void> = next.finally(() => {
    // Self-clean when this is the last in line. Don't delete if a
    // subsequent queueDispatcher has already chained onto us — that
    // call replaced the map entry already.
    if (chains.get(opts.nodeId) === tail) {
      chains.delete(opts.nodeId);
    }
  });
  chains.set(opts.nodeId, tail);

  return tail;
}

/** Wait for all in-flight cascades to finish. Used by tests + the smoke
 *  script. Calling this between writes makes assertions deterministic. */
export async function awaitAllDispatchers(): Promise<void> {
  // Snapshot the values — new chains added during await are not waited.
  // For tests that want a deep drain, call this in a loop until size 0.
  const pending = Array.from(chains.values());
  await Promise.all(pending.map((p) => p.catch(() => undefined)));
}

/** Wait for cascades on a specific node only. Returns immediately if
 *  the node has no in-flight tasks. */
export async function awaitNodeDispatcher(nodeId: string): Promise<void> {
  const tail = chains.get(nodeId);
  if (tail) await tail.catch(() => undefined);
}

/** Snapshot of in-flight nodes. UI + tests use this to render a
 *  "pending" indicator or assert on dispatcher state. */
export function inflightNodeIds(): string[] {
  return Array.from(chains.keys());
}

/** Part of closing the database (dbClose.ts onBeforePoolEnd): tasks waiting to retry stop waiting, then every
 *  queued or running cascade finishes while the pool is still open, including ones queued by the cascades. */
async function closeDispatcher(): Promise<void> {
  closing = true;
  for (const wake of [...retryWakers]) wake();
  while (chains.size > 0) await awaitAllDispatchers();
}
onBeforePoolEnd(closeDispatcher);

/** Test helper — drop all chains. Use sparingly; only between tests. */
export function _resetDispatcherQueueForTests(): void {
  chains.clear();
}

// ── M1: cascade catch-up (crash recovery) ────────────────────────────────────

type PendingIntent = {
  event_id: string;
  workspace_id: string;
  node_id: string;
  actor_id: string;
  token_id: string | null;
  label: string;
};

/**
 * The needs-replay set: durable intents whose cascade never settled.
 *
 * At startup every row qualifies — this process hasn't queued anything yet,
 * and the single-instance assumption means no other process could have. On
 * the interval pass two filters keep us off live chains:
 *   - grace window: a row younger than `graceMs` may belong to a cascade
 *     that is queued-but-not-started (the gap between COMMIT and the
 *     post-commit queueDispatcher call is microseconds, but the cascade
 *     itself can run for a while before its settle-DELETE);
 *   - in-flight skip: a node with an active chain is left alone — its tail
 *     will settle (and delete) the row itself.
 */
export async function pendingCascadeIntents(opts: { graceMs?: number } = {}): Promise<PendingIntent[]> {
  const graceMs = opts.graceMs ?? 0;
  const res = await pool.query<PendingIntent>(
    `SELECT event_id::text AS event_id, workspace_id, node_id, actor_id, token_id, label
       FROM dispatcher_pending
      WHERE created_at <= now() - ($1::text || ' milliseconds')::interval
      -- qualified: a bare event_id would bind to the ::text output alias and
      -- sort lexicographically ("10" < "9"); replay should follow commit order.
      ORDER BY dispatcher_pending.event_id ASC`,
    [String(graceMs)],
  );
  const inflight = new Set(inflightNodeIds());
  return res.rows.filter((r) => !inflight.has(r.node_id));
}

/**
 * Replay one crash-orphaned cascade. Runs the SAME reconciler pair every
 * queueDispatcher call site queues (node PATCH / version restore / MCP
 * updateNode), against the node's CURRENT markdown — the syncs derive
 * attribute state from the body, so replaying with a newer body just
 * converges to the same end-state a later cascade would have produced.
 *
 * Discards (row deleted, nothing replayed) when the replay is meaningless
 * or would break the authority bound:
 *   - node gone / trashed: a cascade mutates the node; trash hides it from
 *     every surface and undelete re-derives on the next edit;
 *   - actor gone: nothing to attribute the cascade to — attribution is
 *     non-forgeable (spine rule), so we don't guess;
 *   - token revoked/expired/deleted: the original cascade was bounded by
 *     the token's tag scope; replaying without it would let a crash widen
 *     an agent's blast radius. Skipping is the conservative inverse.
 * Each discard is audited as DISPATCHER_FAILED so the admin sees that a
 * cascade was lost and why — same surface as a live cascade failure.
 */
async function replayIntent(intent: PendingIntent): Promise<void> {
  // Through queueDispatcher, not around it: per-node serialization against
  // live traffic, then refresh authority under the event lock. The original
  // trigger's identity survives a crash, but its old grants never do.
  const [
    { syncAttributesAndDispatch, syncFrontmatterAttributes },
    { resolveCurrentActor },
    { withEventTransaction },
    { assertAuthority },
    { UnauthorizedError },
    { withToolAuthority },
  ] = await Promise.all([
    import("./nodes.js"),
    import("../spine/currentActor.js"),
    import("../spine/eventTransaction.js"),
    import("../spine/authority.js"),
    import("../spine/mutate.js"),
    import("../spine/toolScope.js"),
  ]);
  await queueDispatcher(
    {
      workspaceId: intent.workspace_id, nodeId: intent.node_id,
      actorId: intent.actor_id, label: `${intent.label}.catchup`,
      triggerEventId: intent.event_id, retryTransient: false,
    },
    () => withEventTransaction(intent.workspace_id, async () => {
      const discard = async (reason: string) => {
        await event(
          intent.workspace_id, "DISPATCHER_FAILED", "node", intent.node_id,
          { label: intent.label, error: `catchup: ${reason}` },
          "system", intent.actor_id,
          { txMeta: { ui_context: "dispatcher.catchup_discarded" } },
        );
        await q(`DELETE FROM dispatcher_pending WHERE event_id = $1::bigint`, [intent.event_id]);
      };

      const node = await q<{ markdown: string | null }>(
        `SELECT markdown FROM content_nodes
          WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()}`,
        [intent.workspace_id, intent.node_id],
      );
      if (!node.rows[0]) return discard("node missing or trashed; cascade dropped");

      // The live callback inherits the registry's tool context. Reconstruct it
      // from the immutable trigger on recovery, never from a guessed queue
      // label. Otherwise a crash would bypass a tools-only token revocation.
      const trigger = (await q<{ token_id: string | null; tool_name: string | null }>(
        `SELECT tx_meta->>'token_id' AS token_id,
                CASE WHEN jsonb_typeof(tx_meta->'tool_name')='string'
                  THEN tx_meta->>'tool_name' END AS tool_name
           FROM domain_events
          WHERE id=$1::bigint AND workspace_id=$2 AND actor_id=$3
            AND target_type='node' AND target_id=$4`,
        [intent.event_id, intent.workspace_id, intent.actor_id, intent.node_id],
      )).rows[0];
      if (!trigger || trigger.token_id !== intent.token_id) {
        return discard("trigger identity/token mismatch; cascade dropped");
      }
      if (intent.token_id && !trigger.tool_name?.trim()) {
        return discard("token trigger lacks verifiable tool authority; cascade dropped");
      }

      const replay = async () => {
        let actor: ActorCtx;
        try {
          actor = await resolveCurrentActor({
            id: intent.actor_id,
            ...(intent.token_id ? { tokenScope: {
              tokenId: intent.token_id,
            } } : {}),
          }, intent.workspace_id);
        } catch (error) {
          if (!(error instanceof UnauthorizedError)) throw error;
          return discard("actor missing or bearer token revoked/expired/mismatched; cascade dropped");
        }

        // The reconcilers write parsed attributes before dispatching behaviours.
        // Gate the whole replay first so a denied scope leaves neither derived
        // attributes nor successful behaviour events behind. A later failure
        // rolls this unit back before queueDispatcher audits it.
        await assertAuthority(actor, { kind: "node", nodeId: intent.node_id, op: "write_node" });
        const markdown = node.rows[0].markdown ?? "";
        await syncAttributesAndDispatch(intent.workspace_id, intent.node_id, markdown, actor, intent.event_id);
        await syncFrontmatterAttributes(intent.workspace_id, intent.node_id, markdown, actor, intent.event_id);
      };
      return intent.token_id ? withToolAuthority(trigger.tool_name!, replay) : replay();
    }),
  );
}

/**
 * Replay every crash-orphaned cascade. Called once at startup (before the
 * server accepts writes is ideal but not required — per-node serialization
 * makes a replay racing a fresh PATCH safe) and periodically as a backstop.
 * Errors are contained per-intent: one bad row can't starve the rest.
 */
export async function runDispatcherCatchup(opts: { graceMs?: number } = {}): Promise<{ replayed: number }> {
  const intents = await pendingCascadeIntents(opts);
  for (const intent of intents) {
    try {
      await replayIntent(intent);
    } catch (e) {
      log.error("dispatcher", `catchup replay failed for event ${intent.event_id}`, { err: e });
    }
  }
  return { replayed: intents.length };
}

/** Start the periodic catch-up. Called once from the server bootstrap, next
 *  to startOutboxReconciler. The first pass runs immediately (boot recovery);
 *  the interval is a low-frequency backstop with a grace window so it never
 *  touches cascades the live queue is still responsible for. */
export function startDispatcherCatchup(intervalMs = 5 * 60 * 1000, graceMs = 60 * 1000): void {
  startPeriodicJob(
    { name: "dispatcher-catchup", everyMs: intervalMs, runFirstAfterMs: 0, exclusive: true },
    async () => { await runDispatcherCatchup({ graceMs }); },
  );
}
