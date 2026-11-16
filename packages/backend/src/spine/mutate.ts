// Spine — the mutation gate.
//
// Every state change should flow through mutate(). It is the single place that
// guarantees, BY CONSTRUCTION rather than by discipline:
//
//   1. An actor is present.            (the type requires it; routes start with
//                                        requireActor() at their boundary.)
//   2. Authority is checked first.     (declared per call as a required field;
//                                        apply() never runs if it throws. Bearer
//                                        token tag-scope is enforced here too.)
//   3. A domain_event is ALWAYS        (its actor_type / actor_id are DERIVED
//      emitted, attributed correctly.   from the actor and cannot be passed in —
//                                        this is what kills the class of bugs
//                                        where routes hardcoded "user" /
//                                        defaulted to "demo-user".)
//   4. event + apply are atomic.       (one transaction; commit or roll back
//                                        together.)
//   5. Cascades stay bounded & traced. (a mutate() nested inside apply() — e.g.
//                                        a template expansion — inherits the
//                                        ROOT actor for both attribution AND
//                                        authority, so a behaviour can't escalate
//                                        past whoever triggered it, and its event
//                                        links back via triggered_by.)
//
// actor_type is therefore 'user' or 'ai_agent' — a real actor acted — or
// 'system' for a background job nobody triggered (the task scheduler). A system
// actor is made only inside the server (spine/systemJobs.ts), holds the
// `system` authority only, and every event it emits (root or cascaded) is
// checked against the job's declared event kinds, targets and module.
// Audit records written BESIDE someone else's operation (dispatcher, conflict
// notes) still call event() with 'system' directly; test/guards/systemActor.guard.test.ts
// lists each with its reason.

import { nodeVisibilityCommitted } from "./nodeHooks.js";
import { createContextSlot } from "../requestContext.js";
import type { ActorCtx } from "../types.js";
import { eventActorType } from "../types.js";
import { event, withTransaction, inTransaction, bumpMembershipEpoch, q } from "../db.js";
import { assertAuthority, AuthorityError, writesAsPerson, type Authority } from "./authority.js";
import { ScopeError, assertWriteModeAllows } from "./toolScope.js";
import { lockEventAppend, withEventTransaction } from "./eventTransaction.js";
import { withIdempotencyClaim } from "./idempotency.js";
import { resolveCurrentActor } from "./currentActor.js";
import { stampTransaction } from "./stamps.js";
import { UnauthorizedError } from "./actor.js";
import { assertSystemActorGenuine, assertSystemEvent, systemJobOf } from "./systemJobs.js";
export { requireActor, UnauthorizedError } from "./actor.js";

export { IdempotentReplay, withIdempotencyKey, isCommittedIdempotencyKey } from "./idempotency.js";

export { AuthorityError };
export type { Authority };

// Propagated down a cascade of nested mutate() calls. rootActor is the human /
// agent who started the chain; causeEventId is the event of the immediately
// enclosing mutation, so each nested event records what triggered it. It is
// optional only because runCascade() can root a cascade on an upstream event
// that already committed in a PRIOR transaction (the post-commit dispatcher
// queue) where there is no in-tx event to point at — there the children simply
// carry no triggered_by, same as the legacy direct-emit path did.
type CascadeCtx = { rootActor: ActorCtx; causeEventId: string | undefined };
const cascade = createContextSlot<CascadeCtx>();

/** The root actor of a transaction, read under the event lock. A person or
 *  agent is reloaded (role and token may have changed while waiting); a system
 *  actor has no row to reload and is checked for being a registered job. */
async function currentRootActor(actor: ActorCtx, workspaceId: string): Promise<ActorCtx> {
  assertSystemActorGenuine(actor);
  return systemJobOf(actor) ? actor : resolveCurrentActor(actor, workspaceId);
}

/** Run `body` as the ROOT of a behaviour cascade. This is how a dispatcher that
 *  does NOT itself emit a rooting event (an attribute-change cascade descending
 *  from an already-committed NODE_UPDATED) establishes the cascade store that
 *  nested mutate({authority:{kind:"cascade"}}) calls inherit.
 *
 *  It is the single authority-checked gate for entering a cascade from outside a
 *  root mutate: it asserts `authority` (the real gate — typically
 *  {kind:"node", op:"write_node"}) against the effective root actor, THEN opens
 *  the store. Because `cascade` authority is unusable without a store (mutate()
 *  throws), and the store can only be opened here or by a root mutate's apply(),
 *  a cascade child can never escalate past — nor act outside — what this gate
 *  allowed. A denial throws (AuthorityError/ScopeError); the caller decides
 *  whether to audit it as CASCADE_DENIED and skip, or propagate.
 *
 *  Nesting: if already inside a cascade, the effective actor stays the existing
 *  root (a nested cascade cannot swap actors), and a fresh causeEventId layer is
 *  pushed so deeper children point triggered_by at the nearer ancestor. */
export async function runCascade<T>(
  opts: { actor: ActorCtx; workspaceId: string; authority: Authority; causeEventId: string | undefined },
  body: () => Promise<T>,
): Promise<T> {
  const parent = cascade.getStore();
  const run = async () => {
    const actor = parent ? parent.rootActor : await currentRootActor(opts.actor, opts.workspaceId);
    if (!parent) await stampTransaction(opts.workspaceId, actor.id, { system: !!systemJobOf(actor), notAPerson: !writesAsPerson(actor) });
    await assertAuthority(actor, opts.authority);
    return cascade.run({ rootActor: actor, causeEventId: opts.causeEventId }, body);
  };
  return parent ? run() : withEventTransaction(opts.workspaceId, run);
}

/** Root of an event restore (services/eventRestore): one atomic, idempotent
 *  unit that opens the cascade store its inverse events are written in. It
 *  claims the request's idempotency key, resolves the CURRENT actor under the
 *  event lock and hands it to `body`. The restore's own authority depends on the
 *  event being undone, so `body` asserts it (authorizeRestore) before writing;
 *  every write inside goes through mutateRestore and inherits that root actor.
 *
 *  Nesting (cascade:true restores a chain): the existing root actor stays and
 *  the unit still opens its own savepoint, so a child that returns a domain
 *  refusal (body throws) rolls back only itself. */
export async function runRestore<T>(
  opts: { actor: ActorCtx; workspaceId: string },
  body: (actor: ActorCtx) => Promise<T>,
): Promise<T> {
  return withIdempotencyClaim(opts.workspaceId, (claim) =>
    withEventTransaction(opts.workspaceId, async () => {
      await claim();
      const parent = cascade.getStore();
      const actor = parent ? parent.rootActor : await currentRootActor(opts.actor, opts.workspaceId);
      if (!parent) await stampTransaction(opts.workspaceId, actor.id, { system: !!systemJobOf(actor), notAPerson: !writesAsPerson(actor) });
      return cascade.run({ rootActor: actor, causeEventId: parent?.causeEventId }, () => body(actor));
    }),
  );
}

export type Mutation<T> = {
  actor: ActorCtx;
  workspaceId: string;
  authority: Authority;
  /** Optional durable idempotency claim. When set (or when an ambient key is
   *  present via withIdempotencyKey), the ROOT mutation atomically claims the
   *  key inside its own transaction before emitting the event. A replay of an
   *  already-committed key throws IdempotentReplay (→ HTTP 200 {deduped:true});
   *  a first attempt that rolls back releases the claim with it. Ignored on
   *  nested/cascade mutations — only the request's root write is guarded. */
  idempotencyKey?: string;
  /** With no `event`: the event type the agent write-mode gate (suggest mode) judges the write as, so a write that skips the
   *  history entry (a burst of one person's moves) is refused to exactly the actors the recorded one is refused to. */
  gateAs?: string;
  /** What the history records. Omitted = the write is personal data or a personal
   *  setting (preferences, review progress, read marks, subscription settings):
   *  everything else a mutation does still happens (the workspace write lock, the
   *  current actor re-read under it, the authority check, the idempotency claim,
   *  the transaction, and the write stamp every stamped table records) but no
   *  domain_event is written. Use mutatePersonal() instead of leaving it out by hand. */
  event?: {
    type: string;
    targetType: string;
    /** The id of the thing changed. A literal string in the default
     *  "before" timing. With timing:"after" it may be a function that derives
     *  the id from apply()'s result — for creates where the DB mints the id. */
    targetId: string | ((result: T) => string);
    payload?: Record<string, unknown>;
    txMeta?: Record<string, unknown>;
    external?: boolean;
    /** Explicit causation link, overriding the ambient cascade store. Lets a
     *  dispatcher emit a rooting event (TAG_APPLIED) that points triggered_by at
     *  the upstream user/agent event it was passed, WITHOUT the caller having to
     *  open a cascade store first. Inside a cascade store this is normally left
     *  unset and the store's causeEventId is used. */
    triggeredBy?: string;
    /** sha256 hex of the body an editor save was based on (see EventOptions.baseHash). */
    baseHash?: string;
  };
  /** When the event is emitted relative to apply():
   *    "before" (default) — emit, then apply with the event id in hand (apply
   *                         receives it). Required for rooting a behaviour
   *                         cascade: nested mutate() calls point triggered_by
   *                         at it.
   *    "after"            — apply first (to obtain a DB-generated id), then
   *                         emit with a targetId resolved from the result; apply
   *                         must not itself spawn nested mutate() calls (there
   *                         is no event yet for them to be triggered_by).
   *  (Versions come from body_hash on the event; the old version trigger is gone.) */
  timing?: "before" | "after";
  /** Declare that this mutation can change the result of readableNodeIdSet()
   *  (actor role / matter scope / token scope / tag policy READ rule / permission
   *  tag apply-remove / parent_id / a restore that reverts to any of those). When
   *  true the spine bumps the workspace membership_epoch IN THIS TRANSACTION, so
   *  the sync client knows to run a membership reconciliation. Declared here (the
   *  mutation knows whether the role/parent ACTUALLY changed) rather than inferred
   *  from the event type — see docs/architecture/membership-and-permission-epoch.md.
   *  Default false: ordinary content/title/field/ink edits must NOT bump. */
  affectsMembership?: boolean;
  /** Notes whose visibility this mutation may change (hidden, promoted): once
   *  the root transaction commits, modules hear it through the shared
   *  visibilityCommitted hook (the website takes a hidden page off). Declared
   *  by the caller, like affectsMembership, not inferred from the event. */
  visibilityChanged?: string[];
  /** The actual state change. Runs inside the transaction with the emitted
   *  event id available (empty string under "after" timing). */
  apply: (ctx: { eventId: string }) => Promise<T>;
};

/** A write made through an agent session's token names that session, so
 *  History can group the agent's writes into one run (services/history/
 *  agentRuns.ts). Derived from the actor like actor_type, never passed in. */
function withAgentRun(payload: Record<string, unknown> | undefined, actor: ActorCtx): Record<string, unknown> {
  const sessionId = actor.tokenScope?.sessionId;
  return sessionId ? { agent_run_id: sessionId, ...payload } : payload ?? {};
}

function resolveTargetId<T>(t: string | ((r: T) => string), r: T): string {
  return typeof t === "function" ? t(r) : t;
}

export async function mutate<T>(m: Mutation<T>): Promise<T> {
  const parent = cascade.getStore();
  // Inside a cascade the effective actor is the root, never the nested call's
  // claimed actor — a behaviour cannot act as someone else or escalate.
  let actor = parent ? parent.rootActor : m.actor;
  assertSystemActorGenuine(actor);

  // By-construction confinement: `cascade` authority skips the permission check
  // on the premise that the cascade root already passed one. That premise only
  // holds inside an established cascade store — so reject it as a root. This is
  // what stops {kind:"cascade"} from being a universal authority bypass.
  if (m.authority.kind === "cascade" && !parent) {
    throw new AuthorityError(
      "cascade",
      "cascade authority is only valid inside an established cascade (use runCascade, or nest inside a root mutate's apply)",
    );
  }

  const emit = (targetId: string) =>
    m.event === undefined ? Promise.resolve("") : event(
      m.workspaceId,
      m.event.type,
      m.event.targetType,
      targetId,
      withAgentRun(m.event.payload, actor),
      eventActorType(actor.type), // derived — callers cannot set actor_type
      actor.id,
      {
        txMeta: m.event?.txMeta,
        external: m.event?.external,
        baseHash: m.event?.baseHash,
        // Explicit link wins; otherwise inherit the enclosing cascade's cause.
        triggeredBy: m.event?.triggeredBy ?? parent?.causeEventId,
      },
    );

  // Membership keystone: a mutation that can move readableNodeIdSet() bumps the
  // workspace epoch IN THIS tx (so a sync client knows to reconcile). Declared by
  // the caller (m.affectsMembership) — never inferred from the event type. Runs
  // after apply so it shares the same transaction; q()-based, so it commits/rolls
  // back atomically with the state change + event.
  // docs/architecture/membership-and-permission-epoch.md.
  const maybeBump = async (): Promise<void> => {
    if (m.affectsMembership) await bumpMembershipEpoch(m.workspaceId);
    if (m.visibilityChanged?.length) {
      await nodeVisibilityCommitted({ workspaceId: m.workspaceId, actor, nodeIds: m.visibilityChanged });
    }
  };

  const run = async (claim: () => Promise<void>): Promise<T> => {
    // C1 — event-cursor skip (data loss). domain_events.id is a bigserial:
    // assigned at INSERT but only VISIBLE at COMMIT. Under concurrent writers in
    // READ COMMITTED a higher id can commit (and be delivered by the /api/sync
    // cursor = max visible id) while a lower id is still in-flight; the cursor
    // then advances PAST that lower id and never re-pulls it. A per-workspace
    // xact-advisory lock serializes event-id assignment AND commit, so ids are
    // ordered by commit and the cursor can never skip an in-flight lower
    // id. Held only by the ROOT mutate (nested cascade emits share this tx + lock;
    // the lock is re-entrant and released at commit). Negligible at the single-
    // user + agent concurrency; mirrors the actor-bootstrap advisory lock (services/actors.ts actorForSession).
    if (!parent) {
      await lockEventAppend(m.workspaceId);
      actor = await currentRootActor(m.actor, m.workspaceId);
      // A root note created in this transaction without a parent or an
      // explicit space lands in the actor's personal space (the
      // content_nodes_derive_space trigger reads this setting). A system job
      // has none: the trigger refuses such a create instead of picking a space.
      await q(`SELECT set_config('onden.actor_space', COALESCE(
                 (SELECT id::text FROM spaces WHERE owner_actor_id::text = $1 AND kind = 'personal' AND deleted_at IS NULL), ''), true),
                      set_config('onden.system_actor', $2, true)`,
        [actor.id, systemJobOf(actor) ? "on" : ""]);
      await stampTransaction(m.workspaceId, actor.id, { system: !!systemJobOf(actor), notAPerson: !writesAsPerson(actor) });
    }
    // A policy may change while this writer waits. Check it using the same
    // transaction, after acquiring the lock shared by policy and content writes.
    await assertAuthority(actor, m.authority);
    // An agent in suggest mode may only file suggestions (the actor was just re-read).
    // A personal write has no event to gate: authority is the actor's own data.
    if (m.event) {
      assertWriteModeAllows(actor, m.event.type);
      // A system actor's declaration covers every event it emits, nested ones too.
      await assertSystemEvent(actor, m.workspaceId, m.event);
    } else if (m.gateAs) {
      assertWriteModeAllows(actor, m.gateAs);
    }
    await claim();
    if ((m.timing ?? "before") === "after") {
      const result = await m.apply({ eventId: "" });
      if (m.event) await emit(resolveTargetId(m.event.targetId, result));
      await maybeBump();
      return result;
    }
    if (m.event && typeof m.event.targetId !== "string") {
      throw new Error("mutate: before-timing requires a literal event.targetId");
    }
    const eventId = await emit(m.event ? m.event.targetId as string : "");
    const result = await cascade.run({ rootActor: actor, causeEventId: m.event ? eventId : undefined }, () => m.apply({ eventId }));
    await maybeBump();
    return result;
  };

  // Nested cascade writes share the root claim. The acquiring SQL scope owns
  // invalidation even if a caller's outer transaction rolls back later.
  if (parent) return run(async () => {});
  return withIdempotencyClaim(
    m.workspaceId,
    (claim) => inTransaction() ? run(claim) : withTransaction(() => run(claim)),
    m.idempotencyKey,
  );
}

/** Write the actor's OWN personal data or settings — preferences, review progress, read marks,
 *  subscription and calendar settings — through the one write entry, without a history event.
 *  Same lock, same current-actor re-read, same transaction, same write stamp as mutate();
 *  only the domain_event is left out, because these are high-frequency and nobody could
 *  restore or review them (docs/architecture/proposals/causal-stamps-2026-11-12.md §3).
 *  `apply` runs inside the transaction. Example:
 *    await mutatePersonal({ actor, workspaceId, apply: async ({ actor }) => { await q(...); } }); */
export function mutatePersonal<T>(m: {
  actor: ActorCtx;
  workspaceId: string;
  idempotencyKey?: string;
  /** Gets the actor as re-read under the lock (a role or token may have changed while waiting): use it, not `actor`. */
  apply: (ctx: { actor: ActorCtx }) => Promise<T>;
}): Promise<T> {
  return mutate({
    actor: m.actor,
    workspaceId: m.workspaceId,
    authority: { kind: "open", why: "the actor's own personal data (mutatePersonal)" },
    idempotencyKey: m.idempotencyKey,
    apply: () => m.apply({ actor: cascade.getStore()!.rootActor }),
  });
}

/** One inverse event of an event restore, written through mutate() so its
 *  attribution, same-transaction commit and membership epoch follow the same
 *  rules as any other write. Only valid inside runRestore (mutate rejects
 *  `cascade` authority without a store): the restore root already asserted the
 *  authority for the event being undone, and domain conflict rules stay with
 *  the caller. Adds the provenance every restore event carries: triggered_by
 *  and tx_meta.restored_from point at `original`, ui_context is "event.restore". */
export function mutateRestore<T>(m: {
  actor: ActorCtx;
  original: { id: string; workspace_id: string };
  event: { type: string; targetType: string; targetId: string; payload: Record<string, unknown>; txMeta: Record<string, unknown> };
  /** The restore reverts a permission state (see Mutation.affectsMembership). */
  affectsMembership?: boolean;
  apply: (ctx: { eventId: string }) => Promise<T>;
}): Promise<T> {
  return mutate({
    actor: m.actor,
    workspaceId: m.original.workspace_id,
    authority: { kind: "cascade" },
    event: {
      ...m.event,
      triggeredBy: m.original.id,
      txMeta: { ...m.event.txMeta, restored_from: m.original.id, ui_context: "event.restore" },
    },
    affectsMembership: m.affectsMembership,
    apply: m.apply,
  });
}

/** Map a spine error to its HTTP status, or null if it isn't one. Lets a route do:
 *    catch (e) { const s = spineErrorStatus(e); if (s) return c.json({error:e.message}, s); throw e } */
export function spineErrorStatus(e: unknown): 401 | 403 | null {
  if (e instanceof UnauthorizedError) return 401;
  if (e instanceof AuthorityError) return 403;
  if (e instanceof ScopeError) return 403;
  return null;
}
