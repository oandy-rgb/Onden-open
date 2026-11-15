// Reviewing agent events (D7 inbox, apply-then-review queue): approve keeps a
// change, reject inverse-undoes it. One function decides any set of events —
// a single id, a filtered batch, or one agent chain (a "group") — and
// recordReview() is the only writer of event_reviews. routes/inbox.ts only
// validates the request and turns the outcomes into a response.
//
//   • approve: an attributed EVENT_APPROVED through the spine, atomic with the
//     review row. Per event; a group gets ONE EVENT_APPROVED on its root
//     (payload.group) covering every member.
//   • reject: restoreEvent, then the review row with the restore event id, in
//     one transaction. Per event with cascade (the agent's downstream effects
//     go with it), newest first, so one stubborn event doesn't roll back the
//     rest; a group is ONE transaction without cascade (its members ARE the
//     chain) that leaves unrevertable members in the queue.
//   An event with no inverse to run (a marker, already reverted) is recorded
//   as rejected with no restore event, so it still leaves the queue.

import { pool, q, withTransaction } from "../db.js";
import type { ActorCtx } from "../types.js";
import { mutate, spineErrorStatus } from "../spine/mutate.js";
import { restoreEvent, type RestoreResult } from "./eventRestore/index.js";
import { canReadRetainedNode } from "./readPolicy.js";
import { targetsNode } from "./eventTargets.js";

export type ReviewDecision = "approve" | "reject";

export type ReviewOutcome =
  | { eventId: string; status: "decided"; restore: RestoreResult | null }
  | { eventId: string; status: "not_found" | "already_reviewed"; detail: string }
  // A spine denial; a single decision rethrows `error` (401/403 centrally).
  | { eventId: string; status: "forbidden"; detail: string; error: unknown }
  | { eventId: string; status: "restore_failed"; code: string; httpStatus: number; detail: string };

/** The one writer of event_reviews. False when the event was already decided. */
async function recordReview(
  workspaceId: string, eventId: string, decision: "approved" | "rejected",
  reviewerId: string, restoreEventId: string | null = null,
): Promise<boolean> {
  const ins = await q(
    `INSERT INTO event_reviews (event_id, workspace_id, decision, reviewed_by, restore_event_id)
     VALUES ($1::bigint, $2, $3, $4, $5::bigint)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, workspaceId, decision, reviewerId, restoreEventId],
  );
  return (ins.rowCount ?? 0) > 0;
}

const NOT_REVIEWABLE = "no reviewable agent event with that id";

/** An agent-authored event in this workspace whose target the reviewer may
 *  read (trash included). Anything else reads as missing — no existence
 *  oracle, no blind governance of restricted content. */
async function isReviewable(actor: ActorCtx, workspaceId: string, eventId: string): Promise<boolean> {
  const evt = await pool.query<{ target_type: string; target_id: string }>(
    `SELECT target_type, target_id FROM domain_events
      WHERE id = $1::bigint AND workspace_id = $2 AND actor_type = 'ai_agent'`,
    [eventId, workspaceId],
  );
  const row = evt.rows[0];
  if (!row) return false;
  return !targetsNode(row.target_type) || await canReadRetainedNode(actor, row.target_id);
}

class AlreadyReviewed extends Error {}
class RestoreFailed extends Error {
  constructor(readonly failure: { code: string; status: number; detail: string }) { super(failure.code); }
}

const noInverse = (code: string) => code === "unsupported" || code === "already_in_state";

async function approveOne(actor: ActorCtx, workspaceId: string, eventId: string): Promise<void> {
  // An empty insert means it was already reviewed: throw to roll back, so no
  // spurious EVENT_APPROVED is written.
  await mutate({
    actor,
    workspaceId,
    authority: { kind: "review" },
    event: { type: "EVENT_APPROVED", targetType: "domain_event", targetId: eventId, payload: { reviewed_event_id: eventId } },
    apply: async () => {
      if (!(await recordReview(workspaceId, eventId, "approved", actor.id))) throw new AlreadyReviewed();
    },
  });
}

async function rejectOne(actor: ActorCtx, workspaceId: string, eventId: string): Promise<RestoreResult | null> {
  // Undo + record in ONE transaction so they can't diverge (a restore whose
  // review row never lands; a concurrent reject double-running the restore).
  // withTransaction is reentrant: restoreEvent's own transaction joins it.
  return withTransaction(async () => {
    // Re-running restore would oscillate undo/redo: bail if already decided.
    const existing = await q(`SELECT 1 FROM event_reviews WHERE event_id = $1::bigint`, [eventId]);
    if (existing.rows[0]) throw new AlreadyReviewed();
    const r = await restoreEvent(eventId, { cascade: true, actor, workspaceId });
    if ("code" in r) {
      if (noInverse(r.code)) { await recordReview(workspaceId, eventId, "rejected", actor.id); return null; }
      // Genuinely can't be inverted (external side effect, purge, diverged
      // patch, target gone): roll back, record nothing; the change stands.
      throw new RestoreFailed(r);
    }
    await recordReview(workspaceId, eventId, "rejected", actor.id, r.restore_event_id);
    return r;
  });
}

/** Decide events one by one (a single id or a batch). Each is checked with
 *  the queue's read gate and decided in its own transaction, newest first. */
async function decideEach(actor: ActorCtx, workspaceId: string, ids: string[], decision: ReviewDecision): Promise<ReviewOutcome[]> {
  const ordered = [...new Set(ids)].sort((a, b) => (BigInt(b) < BigInt(a) ? -1 : 1));
  const outcomes: ReviewOutcome[] = [];
  for (const eventId of ordered) {
    if (!(await isReviewable(actor, workspaceId, eventId))) {
      outcomes.push({ eventId, status: "not_found", detail: NOT_REVIEWABLE });
      continue;
    }
    try {
      if (decision === "approve") {
        await approveOne(actor, workspaceId, eventId);
        outcomes.push({ eventId, status: "decided", restore: null });
      } else {
        outcomes.push({ eventId, status: "decided", restore: await rejectOne(actor, workspaceId, eventId) });
      }
    } catch (e) {
      if (e instanceof AlreadyReviewed) outcomes.push({ eventId, status: "already_reviewed", detail: "event already approved or rejected" });
      else if (e instanceof RestoreFailed) outcomes.push({ eventId, status: "restore_failed", code: e.failure.code, httpStatus: e.failure.status, detail: e.failure.detail });
      else if (spineErrorStatus(e)) outcomes.push({ eventId, status: "forbidden", detail: "forbidden", error: e });
      else throw e;
    }
  }
  return outcomes;
}

/** Decide one agent chain. `members` come from the queue's own listing (already
 *  visibility-filtered), root first. */
async function decideGroup(actor: ActorCtx, workspaceId: string, rootEventId: string, members: string[], decision: ReviewDecision): Promise<ReviewOutcome[]> {
  const outcomes: ReviewOutcome[] = [];
  if (decision === "approve") {
    await mutate({
      actor,
      workspaceId,
      authority: { kind: "review" },
      event: {
        type: "EVENT_APPROVED", targetType: "domain_event", targetId: rootEventId,
        payload: { group: true, count: members.length, reviewed_event_ids: members },
      },
      apply: async () => {
        for (const eventId of members) {
          outcomes.push(await recordReview(workspaceId, eventId, "approved", actor.id)
            ? { eventId, status: "decided", restore: null }
            : { eventId, status: "already_reviewed", detail: "already reviewed" });
        }
      },
    });
    return outcomes;
  }
  // Reverse order: deepest/newest first, like the cascading reject of a chain.
  await withTransaction(async () => {
    for (const eventId of [...members].reverse()) {
      const r = await restoreEvent(eventId, { cascade: false, actor, workspaceId });
      if ("code" in r && !noInverse(r.code)) {
        outcomes.push({ eventId, status: "restore_failed", code: r.code, httpStatus: r.status, detail: r.detail });
        continue;
      }
      const restore = "code" in r ? null : r;
      await recordReview(workspaceId, eventId, "rejected", actor.id, restore?.restore_event_id ?? null);
      outcomes.push({ eventId, status: "decided", restore });
    }
  });
  return outcomes;
}

/** Approve or reject agent events. Without `group`, each id is checked and
 *  decided on its own; with it, `ids` are that chain's members. */
export async function reviewEvents(
  actor: ActorCtx, workspaceId: string, ids: string[], decision: ReviewDecision,
  opts: { group?: { rootEventId: string } } = {},
): Promise<ReviewOutcome[]> {
  return opts.group
    ? decideGroup(actor, workspaceId, opts.group.rootEventId, ids, decision)
    : decideEach(actor, workspaceId, ids, decision);
}
