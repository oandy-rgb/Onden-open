// System jobs — the operator for work nobody triggers.
//
// A background job that runs on a timer (the task scheduler) has no person or
// agent behind it, yet its changes must still go through mutate(): the event
// lock, event + write in one transaction, membership epoch, cascades. It acts
// as a SYSTEM ACTOR: one identity per job (like a Kubernetes ServiceAccount per
// controller), with the permissions it may use declared here (like a GitHub
// Actions `permissions:` block) and nowhere else.
//
//   • actor_type is 'system'; actor_id is derived from the job and cannot be
//     passed in, so a job cannot sign as another job or as a person.
//   • assertAuthority() gives a system actor ONE authority, `{kind:"system"}`
//     (or `cascade` inside its own cascade), and mutate() checks every event it
//     emits against the job's declaration: event kind, target kind, and the
//     workspace module the job belongs to. Anything else is an AuthorityError.
//     A system actor is not the workspace owner and has no owner shortcut.
//   • It is not the System account of the native app (spine/systemActor.ts,
//     external_id 'system'): that is an owner-level login with a row in
//     `actors`; this is no row at all and cannot sign in.
//   • A system actor can only be made by systemActorFor(), whose callers are
//     fixed by test/guards/systemActor.guard.test.ts. requireActor, routes, bearer tokens and
//     MCP only produce ordinary ActorCtx values, and mutate() recognises a
//     system actor by object identity (a private registry), so a value built
//     from request data — even one with type:'system' — is refused.
//   • It has no personal space: a create without a parent or a space is refused
//     by the database (migration 140), not placed in a default space.

import type { ActorCtx } from "../types.js";
import { q } from "../db.js";
import { TASKS_MODULE_ID } from "./taskIdentity.js";
import { AuthorityError } from "./authorityError.js";

type SystemJobDeclaration = {
  /** domain_events.actor_id of the job's events. Stable: history keeps it. */
  actorId: string;
  /** Shown where an actor name is needed (never a row in `actors`). */
  name: string;
  /** Event types the job may emit. */
  events: readonly string[];
  /** domain_events.target_type values the job may change. */
  targets: readonly string[];
  /** Module that must be on in the workspace (modules_off), or null. */
  module: string | null;
};

export const SYSTEM_JOBS = {
  "task-scheduler": {
    actorId: "system-task-scheduler",
    name: "任務排程器",
    events: ["TASK_OCCURRENCE_MISSED", "NODE_CREATED"],
    targets: ["node"],
    module: TASKS_MODULE_ID,
  },
  // 2026-11-07: puts a tagged paragraph's `{…} ^id` back on its last line when text typed under it left it
  // mid-paragraph (blocks.ts repairSplitBlockMarker). Edits a note's body, nothing else.
  "block-marker-repair": {
    actorId: "system-block-marker-repair",
    name: "段落標記修復",
    events: ["NODE_UPDATED"],
    targets: ["node"],
    module: null,
  },
  // 2026-11-17 (review of PR #1853, point 11): the background pass that looks up the anchors a save had no budget for (services/blockAnchors/recover.ts). It writes
  // the anchors' places and no event. Its stamp is a system one, so it never resolves a conflict on a place (migration 206: a system write to a unit with other heads is refused).
  "anchor-recovery": {
    actorId: "system-anchor-recovery",
    name: "段落位置找回",
    events: [],
    targets: [],
    module: null,
  },
} as const satisfies Record<string, SystemJobDeclaration>;

export type SystemJobId = keyof typeof SYSTEM_JOBS;

declare const systemJobBrand: unique symbol;
/** An ActorCtx that systemActorFor() made. The brand exists only in types; the
 *  runtime proof is the private registry below. */
export type SystemActorCtx = ActorCtx & { readonly type: "system"; readonly [systemJobBrand]: SystemJobId };

const registered = new WeakMap<object, SystemJobId>();
const minted = new Map<SystemJobId, SystemActorCtx>();

/** The system actor of `job`. Server-internal: only the jobs listed in
 *  test/guards/systemActor.guard.test.ts import it. */
export function systemActorFor(job: SystemJobId): SystemActorCtx {
  let actor = minted.get(job);
  if (!actor) {
    const declared: SystemJobDeclaration = SYSTEM_JOBS[job];
    actor = Object.freeze({ id: declared.actorId, name: declared.name, type: "system" }) as unknown as SystemActorCtx;
    registered.set(actor, job);
    minted.set(job, actor);
  }
  return actor;
}

/** Which job this actor is, or null for anyone else. Identity, not shape: a
 *  copy or a look-alike is not a system actor. */
export function systemJobOf(actor: ActorCtx): SystemJobId | null {
  return registered.get(actor) ?? null;
}

/** mutate() entry check: a value claiming type 'system' that is not a registered
 *  actor is refused, so 'system' can never come from outside. */
export function assertSystemActorGenuine(actor: ActorCtx): void {
  if (actor.type === "system" && !registered.has(actor)) {
    throw new AuthorityError("system", "only a registered system job may act as a system actor");
  }
}

/** The `system` authority: valid for a system actor only. What the job may do
 *  is checked per event by assertSystemEvent. */
export function assertSystemAuthority(actor: ActorCtx, kind: string): void {
  if (!systemJobOf(actor)) throw new AuthorityError("system", "system authority is only for system jobs");
  if (kind !== "system" && kind !== "cascade") {
    throw new AuthorityError("system", `a system job cannot use '${kind}' authority; it holds only what systemJobs.ts declares`);
  }
}

/** Is this event inside the job's declaration, in a workspace where its module
 *  is on? Called by mutate() for the root event and every nested one. */
export async function assertSystemEvent(
  actor: ActorCtx, workspaceId: string, event: { type: string; targetType: string },
): Promise<void> {
  const job = systemJobOf(actor);
  if (!job) return;
  const declared: SystemJobDeclaration = SYSTEM_JOBS[job];
  if (!declared.events.includes(event.type)) {
    throw new AuthorityError("system", `system job ${job} may not emit ${event.type}`);
  }
  if (!declared.targets.includes(event.targetType)) {
    throw new AuthorityError("system", `system job ${job} may not change a ${event.targetType}`);
  }
  if (declared.module) {
    const on = await q(
      `SELECT 1 FROM workspaces WHERE id = $1 AND NOT (modules_off ? $2)`, [workspaceId, declared.module]);
    if (!on.rows[0]) throw new AuthorityError("system", `system job ${job} needs the ${declared.module} module on`);
  }
}
