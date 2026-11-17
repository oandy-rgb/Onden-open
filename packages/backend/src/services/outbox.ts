import { q, pool, withLeaderLock } from "../db.js";
import { onBeforePoolEnd } from "../dbClose.js";
import { log } from "../logger.js";
import { startPeriodicJob } from "../backgroundJobs.js";
import { writeAndCommit } from "../git.js";
import { afterCommit } from "../spine/txHooks.js";
import { notifyEffects } from "./realtime.js";
import { pushNoteToBackup } from "./githubBackup.js";

import { liveNodeSql } from "../spine/nodeSql.js";
// Transactional outbox for irreducible EXTERNAL effects (migration 046).
//
// The spine ([[spine-refactor]]) makes event + state atomic inside PG, but
// effects that live OUTSIDE PG — the local git commit, the remote GitHub backup
// push — used to be fire-and-forget AFTER commit (`void f().catch(()=>null)`),
// so a transient failure silently lost the backup with no record it was even
// intended. The fix: enqueue an INTENT inside the same transaction as the
// domain_event + state change (so it commits atomically), and let a separate
// retrying reconciler perform the effect later.
//
// This is the `runIO` boundary of the spine's Writer-monad core: reify the
// effect as a durable description, interpret it at the edge. KEEP IT DUMB — one
// table, a fixed set of effect kinds, no generalisation into an effect system.
//
// DELIVERY SEMANTICS: AT-LEAST-ONCE. The advisory lock (drainOutbox) stops two
// instances from performing the SAME row CONCURRENTLY, but it is NOT
// exactly-once. There is an irreducible window: if the process dies AFTER the
// external effect succeeds but BEFORE the row is marked 'done', the next drain
// re-performs it. (Same window every transactional outbox has — the effect and
// the status-update can't be one atomic step across a PG boundary and an
// external system.) Therefore EVERY effect kind in performEffect() MUST be
// idempotent: re-running it must converge, not duplicate. Today's kinds satisfy
// this — git_commit/github_backup re-push identical content (no-op), embed skips
// an unchanged body hash, pages_push re-resolves the snapshot. The two with a
// weaker guarantee (tag_pack installs)
// converges on state but can leave a duplicate history row on a retry — acceptable
// for an approved one-shot, but any NEW effect kind must be checked here.
//
// Effect kinds are REGISTERED, not listed here: core kinds below, module kinds
// through ModuleDefinition.outboxEffects (mountModules). The core therefore
// never names or imports a module, and deleting one leaves its pending intents
// waiting instead of failing (see UnregisteredOutboxEffect).

/** The stored `outbox.effect_kind` string; valid kinds are the registered ones. */
export type OutboxEffectKind = string;

/** One external effect the reconciler can perform.
 *
 *   registerOutboxEffect({ kind: "rss_fetch", parse: parseRssFetch, perform: performRssFetch });
 *   await enqueueEffect({ workspaceId, kind: "rss_fetch", dedupKey: `rss_fetch:${id}`, payload });
 *
 * Delivery is AT-LEAST-ONCE, so `perform` must be idempotent. `parse` validates
 * a stored payload; a throw counts as a failed attempt (retried, then dead).
 * A payload that can never succeed — however often it is retried — throws
 * PermanentOutboxFailure from `parse` or `perform`: the row is buried as dead
 * on that attempt, its reason in `last_error`.
 * A held (`pending_approval`) intent is approved by the workspace owner, the
 * only reviewer (spine/authority.ts reviewAuthority). */
export type OutboxEffect<P = unknown> = {
  kind: string;
  parse: (payload: Record<string, unknown>) => P;
  /** `signal` aborts when the attempt times out: an effect that can cancel its
   *  I/O (a git process) should; one that cannot is simply no longer awaited. */
  perform: (payload: P, signal: AbortSignal) => Promise<void>;
  /** How long one attempt may run before it counts as failed and the drain
   *  moves on (default EFFECT_TIMEOUT_MS). */
  timeoutMs?: number;
};

/** One attempt of an effect may not hold the drain longer than this. */
export const EFFECT_TIMEOUT_MS = 60_000;

/** An attempt that ran past its timeout: a retryable failure, and the drain
 *  moves on. Most effects cannot cancel their I/O (only the git commit honours
 *  the abort), so `attempt` may still be running — and may still finish. */
class OutboxEffectTimeout extends Error {
  constructor(readonly kind: string, readonly ms: number, readonly attempt: Promise<void>) {
    super(`outbox effect '${kind}' timed out after ${Math.round(ms / 1000)}s`);
    this.name = "OutboxEffectTimeout";
  }
}

/** Run one attempt, giving up after `ms`. */
async function attemptWithTimeout(kind: string, ms: number, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = run(controller.signal);
  attempt.catch(() => {}); // a late failure after the timeout is not this drain's to report
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new OutboxEffectTimeout(kind, ms, attempt)); }, ms);
  });
  try { await Promise.race([attempt, timeout]); }
  finally { clearTimeout(timer); }
}

// Rows whose timed-out attempt is still running in this process. The drain
// skips them until it settles: a second attempt alongside it could finish
// first and be overwritten by the older one (GitHub pushes are force pushes),
// leaving old content outside while the row says the newer payload is done.
// In-process only — the reconciler runs in one backend instance (the advisory
// lock keeps a second one from draining at the same time, not from running a
// row whose abandoned attempt lives in another process).
const abandoned = new Map<string, Promise<void>>();
/** The same attempts by dedup key: a newer row on that key (a save that
 *  arrived after the attempt's row went dead) must not run alongside it, or
 *  the older push could land last. */
const abandonedKeys = new Map<string, Promise<void>>();
/** An attempt that never settles (a hung connection) releases its row after
 *  this, so the row is retried rather than stuck until a restart. */
const ABANDONED_HOLD_MS = 60 * 60_000;
/** Each abandoned attempt's bookkeeping (late settle, hold release), by row, until it ends. */
const abandonedSettling = new Map<string, Promise<void>>();

/** A timed-out attempt that later succeeds settles its row — only if the row
 *  is still the version that attempt was performing (xmin after the failure
 *  was recorded). A newer payload folded in meanwhile stays pending and runs
 *  once the old attempt is out of the way. */
function watchAbandoned(rowId: string, dedupKey: string | null, attempt: Promise<void>, recordedXmin: string | undefined): void {
  abandoned.set(rowId, attempt);
  if (dedupKey) abandonedKeys.set(dedupKey, attempt);
  const releaseHold = () => {
    if (abandoned.get(rowId) === attempt) abandoned.delete(rowId);
    if (dedupKey && abandonedKeys.get(dedupKey) === attempt) abandonedKeys.delete(dedupKey);
  };
  const release = setTimeout(() => { releaseHold(); kickOutboxDrain(); }, ABANDONED_HOLD_MS);
  release.unref?.();
  const settling: Promise<void> = attempt.then(async () => {
    if (!recordedXmin) return;
    await pool.query(
      `UPDATE outbox SET status='done', done_at=now(), last_error=NULL, updated_at=now()
        WHERE id=$1 AND xmin::text=$2 AND status IN ('pending', 'dead')`,
      [rowId, recordedXmin],
    ).catch((e) => log.error("outbox", "settling a late attempt failed", { err: e, id: rowId }));
  }, () => {}).finally(() => {
    clearTimeout(release);
    releaseHold();
    kickOutboxDrain();
    if (abandonedSettling.get(rowId) === settling) abandonedSettling.delete(rowId);
  });
  abandonedSettling.set(rowId, settling);
}

/** Tests only: resolves once the abandoned attempt on row `id` has finished,
 *  its row settled and its hold released — what a fixed sleep only guesses. */
export async function _abandonedSettledForTests(id: string): Promise<void> {
  await abandonedSettling.get(id);
}

const effects = new Map<string, OutboxEffect>();

/** Register an effect kind. Re-registering the same object is a no-op (tests
 *  re-mount modules); a different object claiming a taken kind throws. */
export function registerOutboxEffect<P>(effect: OutboxEffect<P>): void {
  const existing = effects.get(effect.kind);
  if (existing === (effect as OutboxEffect)) return;
  if (existing) throw new Error(`[outbox] effect kind already registered: ${effect.kind}`);
  effects.set(effect.kind, effect as OutboxEffect);
}

/** Can a registered effect perform an intent of this kind? When not,
 *  approving it would only strand it. */
export function outboxEffectInstalled(kind: string): boolean {
  return effects.has(kind);
}

/** No registered effect performs this kind — typically a module was removed.
 *  The drain leaves such rows pending (no attempt is consumed) so the intent
 *  runs again once the module is back; it is never buried as dead. */
class UnregisteredOutboxEffect extends Error {
  constructor(readonly kind: string) {
    super(`no registered outbox effect for kind '${kind}'`);
    this.name = "UnregisteredOutboxEffect";
  }
}
const UNREGISTERED_RETRY_SECONDS = 900;

/** This intent can never succeed (its payload is refused as such, e.g. a tag
 *  pack whose behaviour fails validation): the drain marks it dead on this
 *  attempt instead of retrying it for a day. The message is the dead row's
 *  `last_error`, so it should say why. Not for transient failures. */
export class PermanentOutboxFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentOutboxFailure";
  }
}

export function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") throw new Error(`outbox payload field '${key}' must be a string`);
  return value;
}
/** A backup intent names its note by id (node_id). Rows queued before
 *  migration 095 name it by slug, which is no longer unique across spaces;
 *  backupTarget still drains them. */
type BackupPayload = { node_id: string; markdown: string; message: string };
const optionalString = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] as string : undefined;

// How the enqueue runs its INSERT. Defaults to q() (binds to the open
// withTransaction). import.ts manages its own pg client (it doesn't use
// withTransaction), so it passes that client's query instead — keeping the
// intent atomic with its manual BEGIN/COMMIT.
export type Executor = (text: string, params: unknown[]) => Promise<unknown>;

// Post-commit follow-up for every enqueue: raise a blind "effects" tick (the
// outbox table changed — the approvals/outbox-dependent UI refetches), and for
// immediately-runnable intents kick the reconciler so the effect performs NOW
// instead of waiting for the next periodic tick. afterCommit() defers both
// until the enqueueing transaction commits — the intent row must be visible
// to the drain's (separate) connection, and a rolled-back enqueue must stay
// silent. pending_approval rows get the tick but never the kick: the drain
// only ever touches status='pending', so approval-held effects are untouched.
function notifyEnqueued(status: "pending" | "pending_approval"): void {
  afterCommit(() => {
    notifyEffects();
    if (status === "pending") kickOutboxDrain();
  });
}

/**
 * Enqueue one intent, atomically with the caller's transaction (q() binds to
 * it; pass `exec` for a manually managed client). At most one pending row per
 * `dedupKey`: a newer payload folds into it and resets its retry budget.
 * `held: true` files it as pending_approval — nothing runs until the inbox
 * approves it. Returns the row id so a caller can kick a drain scoped to it.
 */
export async function enqueueEffect(input: {
  workspaceId: string;
  kind: string;
  dedupKey: string;
  payload: Record<string, unknown>;
  held?: boolean;
  triggeredByEventId?: string;
}, exec?: Executor): Promise<string> {
  const run: Executor = exec ?? q;
  const status = input.held ? "pending_approval" : "pending";
  const result = (await run(
    `INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload, triggered_by_event_id, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedup_key) WHERE status = '${status}'
     DO UPDATE SET payload = EXCLUDED.payload,
                   triggered_by_event_id = EXCLUDED.triggered_by_event_id,
                   attempts = 0,
                   next_attempt_at = now(),
                   last_error = NULL,
                   updated_at = now()
     RETURNING id::text`,
    [input.workspaceId, input.kind, input.dedupKey, input.payload, input.triggeredByEventId ?? null, status],
  )) as { rows?: Array<{ id: string }> };
  notifyEnqueued(status);
  return result.rows?.[0]?.id ?? "";
}

/**
 * Per-node egress opt-out. A node carrying the `local_only` attribute set to
 * `'true'` is never pushed to the REMOTE GitHub backup repo — its content stays
 * inside the deployment (DB + local container git). This is the per-node escape
 * hatch for the local-first-by-default stance ([[product-thesis]]): remote
 * backup egress is already opt-in at the deployment level (off unless
 * GITHUB_BACKUP_REPO is set), and this lets an operator keep individual nodes
 * off the wire even when the global backup is configured.
 *
 * Mirrors the `_published` attribute convention (publishing/publishedSet.ts):
 * a node-level boolean egress flag stored as value='true'. Checked at the
 * enqueue chokepoint so EVERY write path (route save, import, restore,
 * createNode tool) honours it without each caller re-implementing the check —
 * the github_backup intent is simply never created, so nothing reaches the
 * remote even if the reconciler later drains.
 */
async function isLocalOnly(run: Executor, workspaceId: string, nodeId: string): Promise<boolean> {
  const r = (await run(
    `SELECT 1
       FROM node_attributes na
       JOIN content_nodes n ON n.id = na.node_id
      WHERE n.workspace_id = $1 AND n.id = $2::uuid
        AND na.key = 'local_only' AND na.value = 'true'
      LIMIT 1`,
    [workspaceId, nodeId],
  )) as { rows?: unknown[] };
  return (r.rows?.length ?? 0) > 0;
}

/** Where a note's backup goes, decided when the backup runs (the note may have
 *  been renamed or moved since it was queued), or null to write nothing — the
 *  note is gone, its space does not allow backup, or an intent queued before
 *  095 names a slug that no longer names exactly one note: outbound work fails
 *  closed. The path is
 *  `<slug>.md` for the default space (the layout before spaces) and
 *  `<space-id>/<slug>.md` for any other, since a slug is unique only within
 *  its space. */
export async function backupTarget(note: { nodeId?: string; slug?: string }): Promise<{ path: string } | null> {
  const r = await q<{ slug: string; space_id: string; is_default: boolean; allowed: boolean }>(
    `SELECT n.slug, n.space_id::text, s.is_default, (s.capabilities->>'backup') = 'true' AS allowed
       FROM content_nodes n JOIN spaces s ON s.id = n.space_id
      WHERE ${note.nodeId ? "n.id = $1::uuid" : `n.slug = $1 AND ${liveNodeSql("n")}`}
      LIMIT 2`,
    [note.nodeId ?? note.slug],
  );
  const row = r.rows.length === 1 ? r.rows[0]! : null;
  if (!row || !row.allowed) return null;
  return { path: row.is_default ? `${row.slug}.md` : `${row.space_id}/${row.slug}.md` };
}

/**
 * Enqueue the two backup effects for a saved node. MUST be called inside the
 * same transaction as the domain_event + state change (i.e. inside a mutate()
 * apply()) — it routes through q(), which binds to the open transaction, so the
 * intent commits or rolls back atomically with the data.
 *
 * Collapse: the partial-unique index `outbox_pending_dedup` keeps at most ONE
 * pending row per `dedup_key` (= `kind:node_id`), so a burst of saves on one
 * node folds into a single pending push carrying the newest content.
 *
 * Egress opt-out: a node flagged `local_only` skips the REMOTE github_backup
 * intent (the only effect that crosses the deployment boundary). The LOCAL
 * git_commit still runs — that's in-container redundancy, not egress.
 */
export async function enqueueBackup(opts: {
  workspaceId: string;
  nodeId: string;
  markdown: string;
  message: string;
  triggeredByEventId?: string;
}, exec?: Executor): Promise<void> {
  const run: Executor = exec ?? q;
  const payload: BackupPayload = { node_id: opts.nodeId, markdown: opts.markdown, message: opts.message };
  const localOnly = await isLocalOnly(run, opts.workspaceId, opts.nodeId);
  const kinds = localOnly ? (["git_commit"] as const) : (["git_commit", "github_backup"] as const);
  for (const kind of kinds) {
    await enqueueEffect({
      workspaceId: opts.workspaceId, kind, dedupKey: `${kind}:${opts.nodeId}`, payload,
      triggeredByEventId: opts.triggeredByEventId,
    }, run);
  }
}


type SiteEffectOpts = { workspaceId: string; snapshotId: string; triggeredByEventId?: string };

/** One pending job per workspace and kind (dedup), carrying the snapshot to
 *  act on; shared by the site-copy and Pages-push enqueues. */
async function enqueueSiteEffect(kind: "pages_push" | "site_bundle", opts: SiteEffectOpts, exec?: Executor): Promise<void> {
  await enqueueEffect({
    workspaceId: opts.workspaceId, kind, dedupKey: `${kind}:${opts.workspaceId}`,
    payload: { snapshotId: opts.snapshotId, workspaceId: opts.workspaceId },
    triggeredByEventId: opts.triggeredByEventId,
  }, exec);
}

/**
 * Enqueue a publish deploy: push the static copy of the served site (the
 * zip's files) to the external static host. Same in-tx + collapse
 * discipline; dedup_key is per-workspace (`pages_push:<workspaceId>`) so a burst
 * of publishes folds into a single deploy of the latest snapshot. The payload is
 * just the snapshot id — performPagesPush re-resolves it at drain time, so the
 * effect is idempotent and retryable.
 */
export const enqueuePagesPush = (opts: SiteEffectOpts, exec?: Executor): Promise<void> => enqueueSiteEffect("pages_push", opts, exec);

/**
 * Enqueue the making of the stored static copy (publishing/siteBundle.ts) the
 * zip, the Pages push and the live site's search read. Same in-tx + collapse
 * discipline as the push: one pending job per workspace, and the job makes the
 * copy of the site as it is when it runs.
 */
export const enqueueSiteBundle = (opts: SiteEffectOpts, exec?: Executor): Promise<void> => enqueueSiteEffect("site_bundle", opts, exec);

/** Everything that must follow a change of the served site, in the writing
 *  transaction: the static copy is made, then pushed to the external host. */
export async function enqueueSiteOutput(opts: SiteEffectOpts, exec?: Executor): Promise<void> {
  await enqueueSiteBundle(opts, exec);
  await enqueuePagesPush(opts, exec);
}

/** The default retry budget (migration 101): with backoff 2^n s capped at
 *  1 h, 35 attempts span about 25 hours, so an outage of hours delays an
 *  effect instead of burying it. A dead row can be requeued
 *  (requeueDeadEffect). */
export const RETRY_DAY_ATTEMPTS = 35;

// ── Core effect kinds ───────────────────────────────────────────────────────
// git/backup/pages return harmlessly when there's nothing to do (no staged
// change / no remote configured); only a THROW counts as a failure to retry.
// pages_push belongs to the website module
// (modules/website/effects.ts); the enqueue helpers below stay generic.

const parseBackup = (p: Record<string, unknown>) => ({
  nodeId: optionalString(p, "node_id"), slug: optionalString(p, "slug"),
  markdown: requireString(p, "markdown"), message: requireString(p, "message"),
});
// The target is decided at perform time (backupTarget): a note moved since
// into a space whose backup switch is off never leaves the server
// (docs/architecture/spaces.md), and a note that is gone writes nothing.
registerOutboxEffect({
  kind: "git_commit",
  parse: parseBackup,
  perform: async (p, signal) => {
    const target = await backupTarget(p);
    if (target) await writeAndCommit(target.path, p.markdown, p.message, signal);
  },
});
registerOutboxEffect({
  kind: "github_backup",
  parse: parseBackup,
  // A push of one file over the GitHub API; slower than a local commit.
  timeoutMs: 120_000,
  perform: async (p) => {
    const target = await backupTarget(p);
    if (target) await pushNoteToBackup(target.path, p.markdown, p.message);
  },
});
type Perform = (kind: OutboxEffectKind, payload: Record<string, unknown>, signal: AbortSignal) => Promise<void>;

async function performEffect(kind: OutboxEffectKind, payload: Record<string, unknown>, signal: AbortSignal): Promise<void> {
  const effect = effects.get(kind);
  if (!effect) throw new UnregisteredOutboxEffect(kind);
  await effect.perform(effect.parse(payload), signal);
}

// One reconciler at a time. Two layers:
//   • `draining` (in-process): stops an interval tick from overlapping a slow
//     drain within THIS process — the cheap fast-path.
//   • a session-level Postgres advisory lock (cross-instance): the real guard.
//     Without it, two backend instances would each SELECT the same pending rows
//     and BOTH perform the external effect — a double git push / double deploy /
//     double tag-pack install. pg_try_advisory_lock makes the drain mutually
//     exclusive across ALL processes; a loser simply skips the pass (the row
//     stays pending for the holder or the next tick). The lock auto-releases if
//     the holding connection dies, so a crashed drainer leaves no STUCK rows —
//     un-done rows stay pending and get retried. NB this is concurrency control,
//     NOT exactly-once: a crash after the effect but before the 'done' UPDATE
//     re-performs on retry (at-least-once — see the module header). (Same pattern
//     migrate() uses for MIGRATION_LOCK_KEY.)
let draining = false;

// Arbitrary but stable; distinct from MIGRATION_LOCK_KEY (db.ts).
const OUTBOX_DRAIN_LOCK_KEY = 4_242_046_046;

// ── Instant drain ────────────────────────────────────────────────────────────
// kickOutboxDrain() runs a drain pass NOW (post-enqueue, post-approval) instead
// of waiting for the periodic tick. It is ARMED only by startOutboxReconciler()
// (production bootstrap) or by tests via _armInstantDrainForTests — so the many
// existing tests that enqueue intents and then assert on their *pending* state
// don't get their rows drained out from under them.
//
// Re-entrancy: kicks are serialized on a promise chain with at most ONE pass
// queued behind the running one (`kickQueued`). A burst of concurrent enqueues
// therefore coalesces into ≤2 passes (the running pass plus one queued pass
// that sees every row committed meanwhile) — effects are never double-performed
// because no two passes overlap and a pass marks rows done before the next
// SELECT. drainOutbox's own `draining` guard stays as the backstop against a
// direct caller (periodic tick is also routed through the kick).
let instantDrainArmed = false;
let instantPerform: Perform | null = null;
let instantScope: (() => string) | null = null;
let kickQueued = false;
let kickChain: Promise<void> = Promise.resolve();

function kickOutboxDrain(): void {
  if (!instantDrainArmed || kickQueued) return; // the queued pass will see our row
  kickQueued = true;
  kickChain = kickChain.then(async () => {
    kickQueued = false;
    await drainOutbox({
      ...(instantPerform ? { perform: instantPerform } : {}),
      ...(instantScope ? { workspaceId: instantScope() } : {}),
    })
      .catch((e) => log.error("outbox", "instant drain failed", { err: e }));
  });
}

// A pass still queued or running when the database closes finishes first (dbClose.ts onBeforePoolEnd).
onBeforePoolEnd(async () => { await kickChain; });

/** Tests only: arm the instant drain with an injected performer (no real
 *  git/GitHub/embed I/O) so enqueue→performed can be asserted without the
 *  periodic reconciler. `workspace` scopes each pass to the test's own
 *  workspace, so it neither waits on nor marks done the rows other files
 *  left in the shared test database. Call _disarmInstantDrainForTests()
 *  when done. */
export function _armInstantDrainForTests(perform: Perform, workspace?: () => string): void {
  instantDrainArmed = true;
  instantPerform = perform;
  instantScope = workspace ?? null;
}

/** Tests only: stop kicking, wait until every pass already queued or running
 *  has finished (with the hook that armed it), then drop the hook. Without the
 *  wait, a pass still in flight when the next test arms its own hook would
 *  pick up that test's rows and perform them with the previous test's hook. */
export async function _disarmInstantDrainForTests(): Promise<void> {
  instantDrainArmed = false; // no new kicks; passes already queued still run
  let settled: Promise<void>;
  do {
    settled = kickChain;
    await settled;
  } while (settled !== kickChain);
  instantPerform = null;
  instantScope = null;
}

/**
 * Drain due pending intents: perform each effect, mark done; on failure bump
 * attempts with exponential backoff (capped 1h), and bury as `dead` once
 * `max_attempts` is hit — by default 35 attempts, about a day of retries
 * (RETRY_DAY_ATTEMPTS), so an outage of hours loses nothing. Each attempt runs
 * under its effect's timeout: a stuck effect fails that attempt and the next
 * row runs. `perform` is injectable so tests can drive the state machine
 * without real git/GitHub I/O.
 */
export async function drainOutbox(opts: {
  limit?: number;
  perform?: Perform;
  /** Overrides every effect's timeout (tests). */
  timeoutMs?: number;
  workspaceId?: string; // scope the drain (tests; the reconciler drains all)
  id?: string;          // scope to ONE row (the inbox approve's immediate kick)
} = {}): Promise<{ done: number; retried: number; dead: number }> {
  if (draining) return { done: 0, retried: 0, dead: 0 };
  draining = true;
  // The whole body is wrapped so `draining` is ALWAYS reset. Previously
  // pool.connect() sat OUTSIDE the try, so a connect failure (pool exhausted /
  // DB blip) threw with draining still true — permanently wedging the reconciler
  // (every later drain early-returns on the stuck flag).
  try {
    const perform = opts.perform ?? performEffect;
    const limit = opts.limit ?? 20;
    // The drain's own queries use pool.query; only the cross-instance lock needs a session.
    const led = await withLeaderLock({ key: OUTBOX_DRAIN_LOCK_KEY }, () => runDrain(perform, limit, opts));
    return led.held ? led.value : { done: 0, retried: 0, dead: 0 };
  } finally {
    draining = false;
  }
}

/** The drain body proper — runs while the caller holds the advisory lock. */
async function runDrain(
  perform: Perform,
  limit: number,
  opts: { workspaceId?: string; id?: string; timeoutMs?: number },
): Promise<{ done: number; retried: number; dead: number }> {
  {
    const params: unknown[] = [limit];
    let wsClause = "";
    if (opts.workspaceId) {
      params.push(opts.workspaceId);
      wsClause = ` AND workspace_id = $${params.length}`;
    }
    if (opts.id) {
      params.push(opts.id);
      wsClause += ` AND id = $${params.length}::bigint`;
    }
    if (abandoned.size > 0) {
      params.push([...abandoned.keys()]);
      wsClause += ` AND NOT (id = ANY($${params.length}::bigint[]))`;
    }
    if (abandonedKeys.size > 0) {
      params.push([...abandonedKeys.keys()]);
      wsClause += ` AND (dedup_key IS NULL OR NOT (dedup_key = ANY($${params.length}::text[])))`;
    }
    const due = await pool.query<{
      id: string;
      effect_kind: OutboxEffectKind;
      payload: Record<string, unknown>;
      dedup_key: string | null;
      attempts: number;
      max_attempts: number;
      xmin: string;
    }>(
      // xmin (the system column carrying the row's last-writer xid) is our
      // optimistic-concurrency token: it changes on EVERY update to the row, so
      // the done-mark below can refuse to settle a row a concurrent save has
      // re-dirtied. (updated_at would lose microseconds across node-pg's Date
      // round-trip and mis-compare; xmin is an integer, exact.)
      `SELECT id, effect_kind, payload, dedup_key, attempts, max_attempts, xmin::text AS xmin
       FROM outbox
       WHERE status = 'pending' AND next_attempt_at <= now()${wsClause}
       ORDER BY next_attempt_at
       LIMIT $1`,
      params,
    );
    let done = 0, retried = 0, dead = 0, superseded = 0;
    for (const row of due.rows) {
      try {
        const timeoutMs = opts.timeoutMs ?? effects.get(row.effect_kind)?.timeoutMs ?? EFFECT_TIMEOUT_MS;
        await attemptWithTimeout(row.effect_kind, timeoutMs, (signal) => perform(row.effect_kind, row.payload, signal));
        // Mark done ONLY if the row hasn't changed since we SELECTed it. A
        // concurrent save can fold a newer payload into THIS pending row via
        // `ON CONFLICT (dedup_key) WHERE status='pending' DO UPDATE` between our
        // SELECT and here; an unconditional done-mark would bury that newer
        // payload in a done row, never pushing it (H6 — backup goes stale). The
        // xmin guard leaves the re-dirtied row pending so a follow-up drain (the
        // enqueue's post-commit kick / the periodic tick) performs the new
        // payload. Effects are idempotent under at-least-once, so re-running the
        // old payload first is safe.
        const marked = await pool.query(
          `UPDATE outbox SET status='done', done_at=now(), updated_at=now() WHERE id=$1 AND xmin::text=$2`,
          [row.id, row.xmin],
        );
        if (marked.rowCount === 0) superseded++; else done++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof UnregisteredOutboxEffect) {
          // Its module is absent: keep the intent, consume no attempt, look again later.
          log.warn("outbox", msg, { id: row.id });
          const marked = await pool.query(
            `UPDATE outbox
                SET last_error=$2, next_attempt_at = now() + ($3::text || ' seconds')::interval, updated_at=now()
              WHERE id=$1 AND xmin::text=$4`,
            [row.id, msg, String(UNREGISTERED_RETRY_SECONDS), row.xmin],
          );
          if (marked.rowCount === 0) superseded++; else retried++;
          continue;
        }
        // Failure belongs to the selected version too. A save that coalesced a
        // newer payload reset its retry budget; neither backoff nor exhaustion
        // of the old attempt may settle that new work.
        const attempts = row.attempts + 1;
        let marked: { rowCount: number | null; rows: Array<{ xmin: string }> };
        if (attempts >= row.max_attempts || e instanceof PermanentOutboxFailure) {
          marked = await pool.query<{ xmin: string }>(
            `UPDATE outbox SET status='dead', attempts=$2::int, last_error=$3, updated_at=now() WHERE id=$1 AND xmin::text=$4
             RETURNING xmin::text AS xmin`,
            [row.id, attempts, msg, row.xmin],
          );
          if (marked.rowCount === 0) superseded++; else dead++;
        } else {
          // $2 is used both as the int column and inside power() — pin it to
          // ::int in both spots so PG deduces a single, consistent type. Cap
          // before the cast: 2^31 no longer fits an int, and a day's budget
          // (RETRY_DAY_ATTEMPTS) reaches attempt 31.
          marked = await pool.query<{ xmin: string }>(
            `UPDATE outbox
                SET attempts=$2::int, last_error=$3,
                    next_attempt_at = now() + (least(power(2, $2::int), 3600)::int::text || ' seconds')::interval,
                    updated_at=now()
              WHERE id=$1 AND xmin::text=$4
             RETURNING xmin::text AS xmin`,
            [row.id, attempts, msg, row.xmin],
          );
          if (marked.rowCount === 0) superseded++; else retried++;
        }
        if (e instanceof OutboxEffectTimeout) watchAbandoned(row.id, row.dedup_key, e.attempt, marked.rows[0]?.xmin);
      }
    }
    // A row superseded mid-drain stays pending with its newer payload — re-kick
    // so it drains promptly (no-op when the instant drain isn't armed; the
    // periodic reconciler tick picks it up either way).
    if (superseded > 0) {
      log.warn("outbox", `${superseded} pending row(s) re-dirtied mid-drain; left pending for re-drain`);
      kickOutboxDrain();
    }
    // Realtime: status transitions happened (done/dead/backoff) — raise the
    // blind "effects" tick so outbox-dependent UI refetches. The UPDATEs above
    // are autocommitted pool queries, so this is already post-commit.
    if (done + retried + dead > 0) notifyEffects();
    return { done, retried, dead };
  }
}

// ── Inbox decisions on held and dead rows ──────────────────────────────────
// Called inside the deciding mutate() (q() binds to its transaction, which
// holds the workspace event lock — the same lock every enqueue runs under, so
// no new pending row can appear between the check and the flip).

/** Approve a held intent. When a pending row with the same dedup key already
 *  waits (an earlier approval still retrying), the approved payload folds into
 *  it — the same collapse enqueueEffect applies — and the held row is settled
 *  as merged, instead of violating the one-pending-per-key index.
 *  Returns the row the drain should perform, or null when it is no longer held. */
export async function approveHeldEffect(workspaceId: string, id: string): Promise<{ performId: string; mergedInto?: string } | null> {
  const held = await q<{ dedup_key: string; payload: Record<string, unknown> }>(
    `SELECT dedup_key, payload FROM outbox
      WHERE id = $1::bigint AND workspace_id = $2 AND status = 'pending_approval' FOR UPDATE`,
    [id, workspaceId],
  );
  const row = held.rows[0];
  if (!row) return null;
  const merged = await q<{ id: string }>(
    `UPDATE outbox SET payload = $3, attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
      WHERE workspace_id = $2 AND dedup_key = $1 AND status = 'pending'
      RETURNING id::text`,
    [row.dedup_key, workspaceId, row.payload],
  );
  const into = merged.rows[0]?.id;
  if (into) {
    await q(
      `UPDATE outbox SET status = 'done', done_at = now(), last_error = $2, updated_at = now() WHERE id = $1::bigint`,
      [id, `approved; merged into pending #${into}`],
    );
    notifyEnqueued("pending");
    return { performId: into, mergedInto: into };
  }
  await q(`UPDATE outbox SET status = 'pending', next_attempt_at = now(), updated_at = now() WHERE id = $1::bigint`, [id]);
  notifyEnqueued("pending");
  return { performId: id };
}

/** Why a reviewer's rejection is recorded on its dead row. Such a row is a
 *  decision, not a failed delivery: it is never listed or requeued. */
const REJECTED_BY_REVIEWER = "rejected_by_reviewer";

/** Reject a held intent: it is settled as dead with REJECTED_BY_REVIEWER.
 *  Status-guarded, so a concurrent decision wins; false when it was no
 *  longer held. */
export async function rejectHeldEffect(workspaceId: string, id: string): Promise<boolean> {
  const upd = await q<{ id: string }>(
    `UPDATE outbox SET status='dead', last_error=$3, updated_at=now()
      WHERE id=$1::bigint AND workspace_id=$2 AND status='pending_approval'
      RETURNING id::text`,
    [id, workspaceId, REJECTED_BY_REVIEWER],
  );
  return upd.rows.length > 0;
}

/** A delivery that ran out of retries, as the owner's inbox lists it: what
 *  failed and why — never its payload (note text, possibly from spaces the
 *  viewer cannot read). */
export type DeadEffect = { id: string; effect_kind: string; attempts: number; last_error: string | null; failed_at: string };

export async function listDeadEffects(workspaceId: string, limit = 100): Promise<DeadEffect[]> {
  const r = await pool.query<DeadEffect>(
    `SELECT id::text, effect_kind, attempts, last_error, updated_at AS failed_at
       FROM outbox
      WHERE workspace_id = $1 AND status = 'dead' AND last_error IS DISTINCT FROM $2
      ORDER BY updated_at DESC
      LIMIT $3`,
    [workspaceId, REJECTED_BY_REVIEWER, limit],
  );
  return r.rows;
}

/** Failed deliveries of one kind, as Settings › System status groups them:
 *  how many, the newest error, and when the first and last one failed. */
export type DeadEffectGroup = { effect_kind: string; count: number; last_error: string | null; oldest_at: string; newest_at: string };

export async function listDeadEffectGroups(workspaceId: string): Promise<DeadEffectGroup[]> {
  const r = await pool.query<DeadEffectGroup>(
    `SELECT effect_kind, count(*)::int AS count,
            (array_agg(last_error ORDER BY updated_at DESC, id DESC))[1] AS last_error,
            min(updated_at) AS oldest_at, max(updated_at) AS newest_at
       FROM outbox
      WHERE workspace_id = $1 AND status = 'dead' AND last_error IS DISTINCT FROM $2
      GROUP BY effect_kind
      ORDER BY max(updated_at) DESC`,
    [workspaceId, REJECTED_BY_REVIEWER],
  );
  return r.rows;
}

/** The owner's 「全部清除」: every failed delivery of `kind` is set aside as
 *  'dismissed' — kept, with its attempts and last error, until the reaper
 *  removes it with the dead rows (reapOutbox), but no longer listed or
 *  requeued. Only 'dead' rows change: pending, held and done work, and a
 *  reviewer's rejection, are left alone. Returns how many were dismissed. */
export async function dismissDeadEffects(workspaceId: string, kind: string): Promise<number> {
  const r = await q<{ id: string }>(
    `UPDATE outbox SET status = 'dismissed', updated_at = now()
      WHERE workspace_id = $1 AND effect_kind = $2 AND status = 'dead' AND last_error IS DISTINCT FROM $3
      RETURNING id::text`,
    [workspaceId, kind, REJECTED_BY_REVIEWER],
  );
  if (r.rows.length > 0) afterCommit(() => notifyEffects());
  return r.rows.length;
}

/** The owner's 「全部重試」: requeueDeadEffect for every failed delivery of
 *  `kind`, oldest first, so an older row of a key is settled as superseded
 *  by a newer one and only the newest content is sent again. */
export async function requeueDeadEffectsOfKind(
  workspaceId: string, kind: string,
): Promise<{ requeued: number; merged: number; superseded: number; performIds: string[] }> {
  const ids = await q<{ id: string }>(
    `SELECT id::text FROM outbox
      WHERE workspace_id = $1 AND effect_kind = $2 AND status = 'dead' AND last_error IS DISTINCT FROM $3
      ORDER BY outbox.id ASC`,
    [workspaceId, kind, REJECTED_BY_REVIEWER],
  );
  const out = { requeued: 0, merged: 0, superseded: 0, performIds: [] as string[] };
  for (const { id } of ids.rows) {
    const result = await requeueDeadEffect(workspaceId, id);
    if (!result) continue;
    out[result.status] += 1;
    if (result.status !== "superseded") out.performIds.push(result.performId);
  }
  return out;
}

/** Give a dead delivery a fresh retry budget — unless newer work of the same
 *  key exists. A row of that key with a higher id (any status: a later save
 *  that is done, dead, pending or held) supersedes it: requeueing would send
 *  older content over newer (for pages_push, roll the public site back to an
 *  old snapshot, possibly re-exposing unpublished notes). An OLDER pending row
 *  of that key takes this row's newer payload instead, since only one pending
 *  row per key may exist.
 *  "requeued": pending again. "merged": folded into that older pending row.
 *  "superseded": settled, newer work exists. Null: no such dead delivery (or a
 *  reviewer's rejection). */
export async function requeueDeadEffect(workspaceId: string, id: string): Promise<{ status: "requeued" | "merged" | "superseded"; performId: string } | null> {
  const dead = await q<{ dedup_key: string; payload: Record<string, unknown> }>(
    `SELECT dedup_key, payload FROM outbox
      WHERE id = $1::bigint AND workspace_id = $2 AND status = 'dead' AND last_error IS DISTINCT FROM $3
      FOR UPDATE`,
    [id, workspaceId, REJECTED_BY_REVIEWER],
  );
  const row = dead.rows[0];
  if (!row) return null;
  const settle = (note: string) => q(
    `UPDATE outbox SET status = 'done', done_at = now(), last_error = $2, updated_at = now() WHERE id = $1::bigint`,
    [id, note],
  );
  const newer = await q<{ id: string }>(
    `SELECT id::text FROM outbox WHERE workspace_id = $1 AND dedup_key = $2 AND id > $3::bigint ORDER BY outbox.id DESC LIMIT 1`,
    [workspaceId, row.dedup_key, id],
  );
  if (newer.rows[0]) {
    await settle(`superseded by #${newer.rows[0].id}`);
    afterCommit(() => notifyEffects());
    return { status: "superseded", performId: newer.rows[0].id };
  }
  const olderPending = await q<{ id: string }>(
    `UPDATE outbox SET payload = $3, attempts = 0, max_attempts = GREATEST(max_attempts, $4::int),
            next_attempt_at = now(), last_error = NULL, updated_at = now()
      WHERE workspace_id = $1 AND dedup_key = $2 AND status = 'pending'
      RETURNING id::text`,
    [workspaceId, row.dedup_key, row.payload, RETRY_DAY_ATTEMPTS],
  );
  if (olderPending.rows[0]) {
    await settle(`merged into pending #${olderPending.rows[0].id}`);
    notifyEnqueued("pending");
    return { status: "merged", performId: olderPending.rows[0].id };
  }
  await q(
    `UPDATE outbox SET status = 'pending', attempts = 0, max_attempts = GREATEST(max_attempts, $2::int),
            next_attempt_at = now(), last_error = NULL, updated_at = now()
      WHERE id = $1::bigint`,
    [id, RETRY_DAY_ATTEMPTS],
  );
  notifyEnqueued("pending");
  return { status: "requeued", performId: id };
}

/**
 * Reap old terminal rows so the table doesn't grow without bound on a
 * long-running instance. Migration 046 deliberately lets done/dead history
 * accumulate (the `outbox_due` partial index keeps the pending hot-path fast
 * regardless), but "freely" isn't "forever" — over months that's unbounded
 * disk + bloat. Done rows are pure history (short retention); dead rows are
 * failures worth keeping longer for inspection, and so are the ones the owner
 * dismissed (dismissDeadEffects). Pending rows are never reaped.
 */
export async function reapOutbox(
  opts: { doneRetentionDays?: number; deadRetentionDays?: number } = {},
): Promise<{ doneReaped: number; deadReaped: number }> {
  const doneDays = opts.doneRetentionDays ?? 7;
  const deadDays = opts.deadRetentionDays ?? 30;
  const done = await pool.query(
    `DELETE FROM outbox WHERE status = 'done' AND done_at < now() - ($1::text || ' days')::interval`,
    [String(doneDays)],
  );
  const dead = await pool.query(
    `DELETE FROM outbox WHERE status IN ('dead', 'dismissed') AND updated_at < now() - ($1::text || ' days')::interval`,
    [String(deadDays)],
  );
  return { doneReaped: done.rowCount ?? 0, deadReaped: dead.rowCount ?? 0 };
}

/** Start the periodic reconciler. Called once from the server bootstrap. */
export function startOutboxReconciler(intervalMs = 5000, reapIntervalMs = 6 * 60 * 60 * 1000): void {
  // Arm the instant drain: from here on, every committed enqueue kicks an
  // immediate pass; the interval below remains the retry/fallback heartbeat
  // (backoff retries, rows enqueued by paths outside afterCommit's reach).
  instantDrainArmed = true;
  // Routed through the kick so periodic and instant passes serialize on the
  // same chain instead of bouncing off the `draining` guard. The drain takes its
  // own advisory lock, so this job is not `exclusive`.
  startPeriodicJob({ name: "outbox-drain", everyMs: intervalMs }, () => { kickOutboxDrain(); });
  // Low-frequency history reap — keeps the table bounded over a long uptime.
  // Single DELETE each, far apart, so it can't overlap or drift.
  startPeriodicJob({ name: "outbox-reap", everyMs: reapIntervalMs }, async () => { await reapOutbox(); });
}

/** An outbox effect held for a human's approval (status 'pending_approval'). */
export type HeldEffect = { id: string; effect_kind: string; payload: Record<string, unknown>; created_at: string; updated_at: string };

/** The effects awaiting approval, newest first (at most 100). */
export async function listHeldEffects(workspaceId: string): Promise<HeldEffect[]> {
  const { rows } = await pool.query<HeldEffect>(
    `SELECT id::text, effect_kind, payload, created_at, updated_at
       FROM outbox
      WHERE workspace_id = $1 AND status = 'pending_approval'
      ORDER BY created_at DESC
      LIMIT 100`,
    [workspaceId],
  );
  return rows;
}

/** The kind of held effect `id` (a bigint in text form), or null when no such effect awaits approval. */
export async function heldEffectKind(workspaceId: string, id: string): Promise<string | null> {
  const row = await pool.query<{ effect_kind: string }>(
    `SELECT effect_kind FROM outbox
      WHERE id = $1::bigint AND workspace_id = $2 AND status = 'pending_approval'`,
    [id, workspaceId],
  );
  return row.rows[0]?.effect_kind ?? null;
}
