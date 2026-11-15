import { pool, q, withLeaderLock } from "../../db.js";
import { localDayId } from "../../localDay.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { mutate } from "../../spine/mutate.js";
import { systemActorFor } from "../../spine/systemJobs.js";
import { log } from "../../logger.js";
import { startPeriodicJob } from "../../backgroundJobs.js";
import { moveTaskLine } from "../../services/blockNodes.js";
import { finishNewNote } from "../../services/newNoteDerived.js";
import { K, TASK_JOIN_SQL, cancelTaskTx, insertTaskNodeTx, liveSuccessorTaskId, successorTaskId, taskBodyMarkdown, taskMintedNextOccurrence, type RecurMode } from "../../services/tasksStore.js";
import { TASKS_MODULE_ID } from "../../spine/taskIdentity.js";
import { isParsableRecur, nextOccurrence } from "./recurrence.js";
import { liveNodeSql } from "../../spine/nodeSql.js";

// D8's time-trigger primitive — deliberately minimal (the dispatcher has no
// notion of time; this is the one genuinely new piece of infra). Same posture
// as the outbox reconciler: a periodic scan over durable state, idempotent,
// every action an attributed event.
//
// Break-or-make recurrence: every occurrence is a REAL task node (migration
// 062 — hidden #task child with _task_* attributes; see services/tasksStore).
//   • make — completing a recurring task mints the next occurrence (handled in
//     the PATCH route, same transaction as the completion).
//   • break — this scheduler finds recurring tasks whose due date passed
//     UNATTENDED, cancels the missed occurrence (TASK_OCCURRENCE_MISSED) and
//     mints the next one due in the future, so a skipped day never silently
//     kills the chain. A task in `waiting` (blocked on someone) is not "missed": the agenda lists it
//     under Waiting whatever its date, so it is left as it is. Non-recurring overdue tasks are NOT touched — they
//     simply sit in the Overdue bucket until a human decides.
//
// The scheduler is a system job (spine/systemJobs.ts "task-scheduler"): both its
// events go through mutate() as actor_type='system', so each task's roll is one
// transaction of event + write under the workspace event lock, and its
// permissions are what that declaration lists (TASK_OCCURRENCE_MISSED and
// NODE_CREATED on nodes, tasks module on).

type DueRow = {
  id: string; workspace_id: string; node_id: string | null; space_id: string | null; title: string;
  when_date: string; recur: string; recur_mode: RecurMode; evening: boolean;
  deadline: string | null; remind_at: string | null; time: string | null; until: string | null;
};

/** Tasks whose stored repeat rule cannot be parsed (an old import wrote "1y"):
 *  logged once per process, then skipped, so a tick does not fail on them again. */
const reportedBadRecur = new Set<string>();

/**
 * One scheduler tick: roll every unattended recurring task forward. Returns
 * counts for observability/tests. `today` is injectable for deterministic
 * tests; production uses the same calendar date the agenda buckets on.
 *
 * Only for what is scheduled: a `fixed` repeat with a day, in a workspace where
 * the tasks module is on. An `after` repeat (完成後起算) has no schedule to
 * miss and waits for its completion; a workspace that turned the module off
 * keeps its tasks untouched (docs/architecture/tasks-module.md).
 */
export async function drainDueTasks(opts: { today?: string } = {}): Promise<{ rolled: number }> {
  const today = opts.today ?? localDayId();
  // Text comparison on the YYYY-MM-DD attr — orders identically to date and
  // never throws on a malformed value.
  const due = await pool.query<DueRow>(
    `SELECT t.id, t.workspace_id, t.parent_id AS node_id, t.space_id, t.title,
            w.value AS when_date, r.value AS recur, COALESCE(rm.value, 'fixed') AS recur_mode,
            COALESCE(ev.value = 'true', false) AS evening,
            dl.value AS deadline, ra.value AS remind_at, tm.value AS time, un.value AS until
       ${TASK_JOIN_SQL}
       JOIN workspaces ws ON ws.id = t.workspace_id AND NOT (ws.modules_off ? '${TASKS_MODULE_ID}')
      WHERE ${liveNodeSql("t")}
        AND s.value NOT IN ('done', 'cancelled', 'waiting')
        AND r.value IS NOT NULL
        AND COALESCE(rm.value, 'fixed') = 'fixed'
        AND COALESCE(sd.value, '') <> 'true'
        AND w.value < $1`,
    [today],
  );

  const scheduler = systemActorFor("task-scheduler");
  let rolled = 0;
  for (const t of due.rows) {
    // A rule nextOccurrence cannot even parse (an old import stored "1y") is
    // skipped: it would throw on every tick. A parsable but zero interval
    // ("0d") still goes through the terminal break below.
    if (!isParsableRecur(t.recur)) {
      if (!reportedBadRecur.has(t.id)) {
        reportedBadRecur.add(t.id);
        log.warn("task-scheduler", `skipping repeat of task ${t.id}: invalid recur rule "${t.recur}"`);
      }
      continue;
    }
    // Per-task transaction: one bad row can't wedge the whole tick.
    try {
      await withEventTransaction(t.workspace_id, async () => {
        // Lock the task node and re-check inside the tx — a human may have
        // completed it between scan and roll (their completion already minted
        // the next occurrence).
        const locked = await q<{ id: string }>(
          `SELECT id FROM content_nodes WHERE id = $1 AND ${liveNodeSql()} FOR UPDATE`, [t.id]);
        if (!locked.rows[0]) return;
        const fresh = await q<{ value: string }>(
          `SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [t.id, K.status]);
        if (!fresh.rows[0] || ["done", "cancelled"].includes(fresh.rows[0].value)) return;

        // Hardening (review 2026-06-11): if the recur token cannot produce a
        // date strictly in the future — a zero interval ('0d'), or a chain so
        // stale the 1000-step advance guard caps out — minting would recreate
        // the SAME overdue task and the next tick would cancel + remint it
        // again, forever. Break the recurrence instead (break-or-make's
        // "break", terminally): cancel the missed occurrence and mint nothing.
        // A task that already made its next occurrence (it was finished, then reopened) only closes: a
        // second chain would repeat every period twice. Same rule as the completion's (M9, update.ts).
        const alreadyMinted = await taskMintedNextOccurrence(t.workspace_id, t.id);
        const next = alreadyMinted ? null : nextOccurrence({
          when: t.when_date, evening: t.evening, deadline: t.deadline, remindAt: t.remind_at,
          recur: t.recur, recurMode: "fixed",
        }, today);

        let missedId = "";
        await mutate({
          actor: scheduler,
          workspaceId: t.workspace_id,
          authority: { kind: "system" },
          event: {
            type: "TASK_OCCURRENCE_MISSED", targetType: "node", targetId: t.id,
            payload: { title: t.title, due_date: t.when_date, when_date: t.when_date, recur: t.recur, ...(next || alreadyMinted ? {} : { chain_broken: true }) },
          },
          apply: async ({ eventId }) => {
            missedId = eventId;
            await cancelTaskTx(t.workspace_id, t.id);
          },
        });

        if (!next) {
          // A missed occurrence that had made its next one (finished, reopened, then missed): its line goes on to it.
          const made = alreadyMinted ? await liveSuccessorTaskId(t.id) : null;
          if (made) await moveTaskLine(t.workspace_id, t.id, made);
          if (!alreadyMinted) log.warn("task-scheduler", `recurrence broken for task ${t.id} (recur=${t.recur}): no future occurrence reachable`);
          rolled++;
          return;
        }

        // Derived from the missed occurrence: a node that rolled it already made this one, and it is not made twice.
        const nextId = await successorTaskId(t.id);
        if (!nextId) { rolled++; return; }
        const body = await taskBodyMarkdown(t.id);
        await mutate({
          actor: scheduler,
          workspaceId: t.workspace_id,
          authority: { kind: "system" },
          event: {
            type: "NODE_CREATED", targetType: "node", targetId: nextId,
            payload: { node_id: t.node_id, title: t.title, due_date: next.when, when_date: next.when, recur: t.recur, task: true, rolled_from: t.id },
            triggeredBy: missedId,
            // Same undo as a task a person adds (createTaskNode).
            txMeta: { inverse_op: "node.deleted", ui_context: "task.scheduler" },
          },
          apply: async ({ eventId }) => {
            await insertTaskNodeTx({
              workspaceId: t.workspace_id,
              id: nextId,
              hostId: t.node_id,
              spaceId: t.space_id,
              title: t.title,
              when: next.when,
              evening: next.evening,
              deadline: next.deadline,
              remindAt: next.remindAt,
              time: t.time,
              until: t.until,
              recur: t.recur,
              markdown: body,
              bodyFrom: { eventId, actor: scheduler, finish: finishNewNote },
            });
            // The line of its note stands for the occurrence that is current (the one the line pointed at was missed).
            await moveTaskLine(t.workspace_id, t.id, nextId);
          },
        });
        rolled++;
      });
    } catch (e) {
      log.error("task-scheduler", `roll failed for task ${t.id}`, { err: e });
    }
  }
  return { rolled };
}

// Leader election for the periodic tick. Without it, every backend replica runs
// its own scheduler and the SAME overdue recurring task gets rolled forward N
// times per tick (advanceDue applied N times → the due date skips ahead, or
// duplicate child tasks mint). A non-blocking session-level advisory lock makes
// the tick mutually exclusive across ALL instances: a loser simply skips this
// pass (the holder rolls the tasks; the row stays for the next tick if it dies).
// The lock auto-releases if the holder's connection dies — no stuck leadership.
// Distinct from MIGRATION_LOCK_KEY / OUTBOX_DRAIN_LOCK_KEY. drainDueTasks itself
// stays lock-free so tests + the API can drive a tick directly.
const SCHEDULER_TICK_LOCK_KEY = 4_242_044_044;

export async function tickWithLeaderLock(): Promise<void> {
  await withLeaderLock({ key: SCHEDULER_TICK_LOCK_KEY }, drainDueTasks); // not held: another instance is ticking
}

/** Start the periodic time-trigger. Called once from the server bootstrap. */
export function startTaskScheduler(intervalMs = 10 * 60 * 1000): void {
  // One tick shortly after boot (a long-sleeping instance catches up fast),
  // then the steady interval. Each tick is leader-locked (one instance per pass).
  startPeriodicJob({ name: "task-scheduler", everyMs: intervalMs, runFirstAfterMs: 15_000 }, tickWithLeaderLock);
}
