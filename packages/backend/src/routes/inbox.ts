import { Hono, type Context } from "hono";
import { getWorkspaceId } from "../services/workspaceId.js";
import { reviewEvents, type ReviewDecision, type ReviewOutcome } from "../services/eventReview.js";
import type { ActorCtx } from "../types.js";
import { mutate, requireActor } from "../spine/mutate.js";
import { isPerson, isWorkspaceOwner, reviewAuthority, type Authority } from "../spine/authority.js";
import { drainOutbox, outboxEffectInstalled, approveHeldEffect, rejectHeldEffect, listDeadEffects, listHeldEffects, heldEffectKind, listDeadEffectGroups, requeueDeadEffect, requeueDeadEffectsOfKind, dismissDeadEffects } from "../services/outbox.js";
import { inboxQueue, loadGroupMembers } from "../services/inboxQueue.js";
import { parsePage } from "../services/paging.js";
import { parseBigintId, readJsonBody } from "./params.js";
import { StatusError } from "../statusError.js";

// D7: inbox-as-governance. The review surface for changes the human did NOT
// author themselves. Today that's the AI agent; the same lens serves multi-user
// collaboration later. It is NOT a capture pile (that's the day node).
//
// TWO queues, by risk tier:
//
//   APPLY-THEN-REVIEW (reversible agent writes — the default):
//   • GET  /api/inbox                  → unreviewed agent events (the queue)
//   • POST /api/inbox/:id/approve      → accept it; leaves the queue
//   • POST /api/inbox/:id/reject       → inverse-undo it (eventRestore) + record
//   The change is already applied + reversible (no sandbox since 047): the
//   queue surfaces what happened, reject *reverts* it. Deliberate — a low-risk,
//   reversible agent edit shouldn't block on a human.
//
//   APPROVE-BEFORE-APPLY (outbound/irreversible effects — D7's gate):
//   • GET  /api/inbox/approvals              → held effects (outbox 'pending_approval')
//   • POST /api/inbox/approvals/:id/approve  → flip to 'pending'; reconciler performs it
//   • POST /api/inbox/approvals/:id/reject   → bury as 'dead'; it never runs
//   No proposed-vs-committed split in domain_events is needed: the held thing
//   is an outbox INTENT, so the event log stays append-only committed facts.
//   Today's held effect: tag_pack (a delegated agent's proposed tag pack —
//   nothing is installed before approval).
//
// We scope the event queue to actor_type = 'ai_agent' on purpose: 'system'
// events are deterministic dispatcher/migration consequences of an already-
// judged action, not a governance subject, and surfacing them would bury the
// real decisions.

type Env = { Variables: { actor: ActorCtx | null } };

const router = new Hono<Env>();

// Governance gate: reviewing non-self-authored (agent) changes is a privileged,
// human-in-the-loop act. Who may is spine/authority.ts reviewAuthority — the
// workspace owner; never a delegated token — the same rule the spine's
// `review` authority and the bootstrap's `can_review` use.
// Returns a 403 reason string when the actor isn't allowed to review, else null.
async function reviewerDenied(actor: ActorCtx): Promise<string | null> {
  if (!isPerson(actor)) return "a delegated token cannot approve or reject agent changes";
  if (!(await reviewAuthority(actor))) return "only the workspace owner can approve or reject";
  return null;
}

// ── D7 approve-BEFORE-apply: the held-effect queue ──────────────────────────
// The complement to the apply-then-review event queue below. A delegated agent
// requesting an outbound/irreversible effect (today: tag_pack) lands here
// as an outbox row with status='pending_approval' — the effect has NOT run and
// will not until a human principal approves. Approve flips it to 'pending'
// (the reconciler then performs it); reject buries it as 'dead'. Both are
// spine-mutated so the decision itself is an attributed, auditable event.

// Who decides: the workspace owner, the only reviewer. Approving a publish
// authorizes public exposure and a tag pack installs tag definitions — both the
// owner's acts anyway (POST /api/publish, POST /api/tags/import).

router.get("/approvals", async (c) => {
  // Held payloads (publish titles, whole tag packs) are for the people who can
  // decide on them: the same gate as approving. Anyone else gets an empty
  // queue, not an error — the inbox UI polls this for every member.
  const viewer = requireActor(c.get("actor"));
  if (await reviewerDenied(viewer)) return c.json({ approvals: [], count: 0 });
  const workspaceId = await getWorkspaceId();
  const approvals = await listHeldEffects(workspaceId);
  return c.json({ approvals, count: approvals.length });
});

router.post("/approvals/:id/:decision{approve|reject}", async (c) => {
  const id = c.req.param("id");
  const decision = c.req.param("decision") as "approve" | "reject";
  if (parseBigintId(id) === null) throw new StatusError(400, "id must be a positive integer");
  const actor = requireActor(c.get("actor"));
  const denied = await reviewerDenied(actor);
  if (denied) return c.json({ error: "forbidden", detail: denied }, 403);
  const workspaceId = await getWorkspaceId();

  const effectKind = await heldEffectKind(workspaceId, id);
  if (effectKind === null) return c.json({ error: "not_found", detail: "no effect awaiting approval with that id" }, 404);
  // An unregistered kind (its module removed) could not run, so approving it
  // would only strand it.
  if (!outboxEffectInstalled(effectKind)) {
    return c.json({ error: "effect_unavailable", detail: `no installed module performs ${effectKind}` }, 409);
  }

  type DecidedThrow = Error & { already?: boolean };
  let approved: { performId: string; mergedInto?: string } | null = null;
  try {
    await mutate({
      actor,
      workspaceId,
      authority: { kind: "review" },
      event: {
        type: decision === "approve" ? "EFFECT_APPROVED" : "EFFECT_REJECTED",
        targetType: "outbox_effect",
        targetId: id,
        payload: { effect_kind: effectKind },
      },
      apply: async () => {
        // Status-guarded so a concurrent double-decide can't approve a
        // rejected effect (or vice versa); empty UPDATE → already decided.
        // An approval folds into a pending row of the same key when one
        // already waits (approveHeldEffect), instead of a unique-index 500.
        let decided: boolean;
        if (decision === "approve") {
          approved = await approveHeldEffect(workspaceId, id);
          decided = approved !== null;
        } else {
          decided = await rejectHeldEffect(workspaceId, id);
        }
        if (!decided) { const e = new Error("already_decided") as DecidedThrow; e.already = true; throw e; }
      },
    });
  } catch (e) {
    if ((e as DecidedThrow).already) return c.json({ error: "already_decided", detail: "effect already approved or rejected" }, 409);
    throw e; // spine denials (401/403) map in the central onError handler
  }

  // Responsiveness: perform the just-approved effect now instead of waiting
  // for the next reconciler tick. Failures fall back to the retry loop.
  // Assigned inside apply(); TypeScript cannot see that through the closure.
  const performed = approved as { performId: string; mergedInto?: string } | null;
  if (performed) void drainOutbox({ id: performed.performId }).catch(() => null);
  return c.json({
    id, decision: decision === "approve" ? "approved" : "rejected",
    ...(performed?.mergedInto ? { merged_into: performed.mergedInto } : {}),
  });
});

// ── Failed deliveries ───────────────────────────────────────────────────────
// An outbox row that ran out of retries (about a day, migration 101) is dead.
// The owner sees what failed and why (the app's Settings › System status, not
// the inbox: a failed job is not an approval), and can requeue it with a fresh
// budget, or clear a kind's failures (status 'dismissed').
// Owner only: the effects carry note content from every space, and requeueing
// a held kind re-runs an act (publish, tag pack) that the owner authorizes.

router.get("/failed-effects", async (c) => {
  const viewer = requireActor(c.get("actor"));
  // The owner always reviews (reviewAuthority), so the owner check is the gate.
  if (!(await isWorkspaceOwner(viewer))) return c.json({ failed: [], count: 0, groups: [], total: 0 });
  const workspaceId = await getWorkspaceId();
  const [failed, groups] = await Promise.all([listDeadEffects(workspaceId), listDeadEffectGroups(workspaceId)]);
  // `failed` is the newest 100 rows; `groups` counts every one, by kind.
  return c.json({ failed, count: failed.length, groups, total: groups.reduce((n, g) => n + g.count, 0) });
});

// Per kind: 「全部重試」 (requeue every failed delivery of the kind) and
// 「全部清除」 (set them aside as 'dismissed', services/outbox.ts
// dismissDeadEffects). Owner only, like the single retry.
router.post("/failed-effects/kinds/:kind/:action{retry|dismiss}", async (c) => {
  const kind = c.req.param("kind");
  if (!/^[a-z0-9_]{1,64}$/.test(kind)) throw new StatusError(400, "kind must be an effect kind");
  const action = c.req.param("action") as "retry" | "dismiss";
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  let retried: Awaited<ReturnType<typeof requeueDeadEffectsOfKind>> | null = null;
  let dismissed = 0;
  await mutate({
    actor,
    workspaceId,
    authority: { kind: "principal_admin" },
    event: {
      type: action === "retry" ? "EFFECT_REQUEUED" : "EFFECTS_DISMISSED",
      targetType: "outbox_effect",
      targetId: kind,
      payload: { effect_kind: kind },
    },
    apply: async () => {
      if (action === "retry") retried = await requeueDeadEffectsOfKind(workspaceId, kind);
      else dismissed = await dismissDeadEffects(workspaceId, kind);
    },
  });
  if (action === "dismiss") return c.json({ effect_kind: kind, dismissed });
  const r = retried as Awaited<ReturnType<typeof requeueDeadEffectsOfKind>> | null;
  // The requeued rows are due now; one drain pass (the reconciler's own,
  // kicked by the enqueue) sends them, rather than a drain per row.
  if (r && r.performIds.length > 0) void drainOutbox({ workspaceId }).catch(() => null);
  return c.json({ effect_kind: kind, requeued: r?.requeued ?? 0, merged: r?.merged ?? 0, superseded: r?.superseded ?? 0 });
});

router.post("/failed-effects/:id/retry", async (c) => {
  const id = c.req.param("id");
  if (parseBigintId(id) === null) throw new StatusError(400, "id must be a positive integer");
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  let result: Awaited<ReturnType<typeof requeueDeadEffect>> = null;
  await mutate({
    actor,
    workspaceId,
    authority: { kind: "principal_admin" },
    event: { type: "EFFECT_REQUEUED", targetType: "outbox_effect", targetId: id, payload: {} },
    apply: async () => {
      result = await requeueDeadEffect(workspaceId, id);
      if (!result) throw Object.assign(new Error("not_found"), { notFound: true });
    },
  }).catch((e: Error & { notFound?: boolean }) => { if (!e.notFound) throw e; });
  if (!result) return c.json({ error: "not_found", detail: "no failed delivery with that id" }, 404);
  const { status, performId } = result as NonNullable<typeof result>;
  void drainOutbox({ id: performId }).catch(() => null);
  return c.json({
    id, status,
    ...(status === "superseded" ? { superseded_by: performId } : {}),
    ...(status === "merged" ? { merged_into: performId } : {}),
  });
});

// GET /api/inbox — the apply-then-review queue (services/inboxQueue.ts):
// ?actor_id= / ?event_type= / ?since=<ISO> narrow it; `groups` and `facets`
// come with it.
router.get("/", async (c) => {
  const workspaceId = await getWorkspaceId();
  // services/paging.ts: the one limit grammar (bad → 400). A queue, not an
  // offset list — `since` below is a date filter, not a cursor.
  const { limit } = parsePage({ limit: c.req.query("limit") }, { default: 100, max: 500 });
  const actorIdFilter = c.req.query("actor_id")?.trim() || null;
  const eventTypeFilter = c.req.query("event_type")?.trim() || null;
  const sinceRaw = c.req.query("since")?.trim() || null;
  if (sinceRaw && Number.isNaN(Date.parse(sinceRaw))) {
    throw new StatusError(400, "since must be an ISO datetime");
  }
  return c.json(await inboxQueue(c.get("actor"), workspaceId, { limit, actorId: actorIdFilter, eventType: eventTypeFilter, since: sinceRaw }));
});

// ── Batch review: approve / reject a whole triggered_by chain ───────────────
// The chain (root + descendants) IS the batch — e.g. one RSS fetch's articles.

// Deciding events: services/eventReview.ts (reviewEvents). These routes check
// the reviewer, validate ids and turn the outcomes into a response.

/** One event's outcome as the single-event routes answer it. */
function singleResponse(c: Context<Env>, outcome: ReviewOutcome, decided: () => Response): Response {
  switch (outcome.status) {
    case "decided": return decided();
    case "not_found": return c.json({ error: "not_found", detail: outcome.detail }, 404);
    case "already_reviewed": return c.json({ error: "already_reviewed", detail: outcome.detail }, 409);
    case "restore_failed": return c.json({ error: outcome.code, detail: outcome.detail }, outcome.httpStatus as 404);
    case "forbidden": throw outcome.error; // spine denial → central onError (401/403)
  }
}

/** The reviewer, or a 403 response. */
async function reviewer(c: Context<Env>): Promise<ActorCtx | Response> {
  const actor = requireActor(c.get("actor"));
  const denied = await reviewerDenied(actor);
  return denied ? c.json({ error: "forbidden", detail: denied }, 403) : actor;
}

// POST /api/inbox/groups/:root_event_id/{approve,reject} — decide one agent
// chain: approve = one attributed EVENT_APPROVED on the root + a review row per
// member; reject = inverse-undo the chain newest first in one transaction,
// leaving members that genuinely can't revert in the queue (reported).
router.post("/groups/:root_event_id/:decision{approve|reject}", async (c) => {
  const rootEventId = c.req.param("root_event_id");
  if (parseBigintId(rootEventId) === null) throw new StatusError(400, "root_event_id must be a positive integer");
  const actor = await reviewer(c);
  if (actor instanceof Response) return actor;
  const workspaceId = await getWorkspaceId();

  const members = await loadGroupMembers(workspaceId, rootEventId, actor);
  if (members.length === 0) return c.json({ error: "not_found", detail: "no unreviewed agent events in that chain" }, 404);

  const decision = c.req.param("decision") as ReviewDecision;
  const outcomes = await reviewEvents(actor, workspaceId, members.map((m) => m.id), decision, { group: { rootEventId } });
  const decided = outcomes.filter((o) => o.status === "decided").length;
  if (decision === "approve") return c.json({ root_event_id: rootEventId, decision: "approved", approved: decided });
  return c.json({
    root_event_id: rootEventId, decision: "rejected", rejected: decided,
    skipped: outcomes.flatMap((o) => o.status === "restore_failed" ? [{ event_id: o.eventId, detail: o.detail }] : []),
  });
});

// Approve: accept the change as-is (it leaves the queue). Reject: inverse-undo
// it with cascade, so the agent's downstream effects go with it, and record
// the restore event that reverted it.
router.post("/:event_id/:decision{approve|reject}", async (c) => {
  const eventId = c.req.param("event_id");
  if (parseBigintId(eventId) === null) throw new StatusError(400, "event_id must be a positive integer");
  const actor = await reviewer(c);
  if (actor instanceof Response) return actor;
  const decision = c.req.param("decision") as ReviewDecision;
  const [outcome] = await reviewEvents(actor, await getWorkspaceId(), [eventId], decision);
  return singleResponse(c, outcome!, () => decision === "approve"
    ? c.json({ event_id: eventId, decision: "approved" })
    : c.json({ event_id: eventId, decision: "rejected", restore: outcome!.status === "decided" ? outcome!.restore : null }));
});

// ── Batch review: approve / reject MANY independent events in one call ──────
// The queue grows fast (a chatty agent mints dozens of small events), so the
// review surface needs one-shot clearing of the CURRENTLY FILTERED set. The
// client sends explicit event ids (what its filters showed) — auditable and
// race-free against events that arrive mid-decision. Each event is decided in
// its OWN transaction with the exact single-event semantics; one stubborn
// event must not roll back sixty good decisions. Newest first, so rejects
// unwind later changes before earlier ones.
const BATCH_SKIP_DETAIL: Record<Exclude<ReviewOutcome["status"], "decided" | "restore_failed">, string> = {
  not_found: "no reviewable agent event with that id",
  already_reviewed: "already reviewed",
  forbidden: "forbidden",
};

router.post("/batch", async (c) => {
  const actor = await reviewer(c);
  if (actor instanceof Response) return actor;
  const workspaceId = await getWorkspaceId();

  const body = (await readJsonBody(c)) as
    | { decision?: unknown; event_ids?: unknown }
    | null;
  const decision = body?.decision;
  if (decision !== "approve" && decision !== "reject") {
    throw new StatusError(400, "decision must be 'approve' or 'reject'");
  }
  const rawIds = body?.event_ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new StatusError(400, "event_ids must be a non-empty array");
  }
  if (rawIds.length > 500) {
    throw new StatusError(400, "at most 500 event_ids per batch");
  }
  if (!rawIds.every((v): v is string => typeof v === "string" && parseBigintId(v) !== null)) {
    throw new StatusError(400, "event_ids must be positive integer strings");
  }

  const outcomes = await reviewEvents(actor, workspaceId, rawIds, decision);
  const decided = outcomes.filter((o) => o.status === "decided").map((o) => o.eventId);
  const skipped = outcomes.flatMap((o) => o.status === "decided" ? [] : [{
    event_id: o.eventId,
    detail: o.status === "restore_failed" ? o.detail : BATCH_SKIP_DETAIL[o.status],
  }]);
  return c.json({ decision, decided: decided.length, decided_ids: decided, skipped });
});

export default router;
