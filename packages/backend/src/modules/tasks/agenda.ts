// The task agenda (GET /api/tasks/agenda, depth audit D13): the SERVER-computed
// buckets TasksMode renders, plus the recent completed tail, all under the
// shared read policy.

import { pool } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { readableScopeSql } from "../../services/readPolicy.js";
import { TASK_COLUMNS_SQL, TASK_JOIN_SQL, taskBucketCaseSql, TASK_HOST_JOIN_SQL, TASK_HOST_LIVE_WHERE, type TaskRow } from "../../services/tasksStore.js";

import { liveNodeSql } from "../../spine/nodeSql.js";
const OPEN = ["todo", "doing"] as const;

/** An agenda row: the task row plus its host note's title ("" for a
 *  standalone task) and, for the active rows, its bucket. */
export type AgendaRow = TaskRow & { node_title: string; bucket: string };

/** The bucketed view TasksMode renders, for what `actor` may read. Buckets:
 *    overdue   open, to do before today        (non-recurring; the scheduler
 *                                               already rolled `fixed` repeats)
 *    today     open, to do today
 *    upcoming  open, to do within the next 7 days
 *    waiting   status=waiting (blocked on someone/something)
 *    later     someday (deliberately parked, whatever its day)
 *    unscheduled  open, no day
 *    scheduled    open, to do later than the next 7 days
 *  Standalone tasks (no host note) are in too: judged by their own space.
 */
export async function taskAgenda(actor: ActorCtx | null, workspaceId: string) {
  // Shared read policy keeps role checks on the task and space scope on it.
  const params: unknown[] = [workspaceId, [...OPEN, "waiting"]];
  const scopeClause = readableScopeSql(actor, "t", params);
  // Days are compared as TEXT (YYYY-MM-DD orders like the date it spells) so a
  // malformed attribute value can never throw a cast error mid-agenda.
  const rows = await pool.query<AgendaRow>(
    `SELECT ${TASK_COLUMNS_SQL}, COALESCE(host.title, '') AS node_title,
            ${taskBucketCaseSql()} AS bucket
       ${TASK_JOIN_SQL}
       ${TASK_HOST_JOIN_SQL}
      WHERE t.workspace_id = $1 AND ${liveNodeSql("t")}
        AND ${TASK_HOST_LIVE_WHERE}
        AND s.value = ANY($2::text[])
        AND ${scopeClause}
      ORDER BY w.value ASC NULLS LAST, t.created_at ASC`,
    params,
  );
  const visible = rows.rows;
  const buckets: Record<string, typeof visible> = {
    overdue: [], today: [], upcoming: [], waiting: [], later: [], unscheduled: [], scheduled: [],
  };
  for (const r of visible) buckets[r.bucket]!.push(r);

  // Completed tail (Apple Reminders' "N completed · Show"): the agenda stays
  // an ACTIVE list — done rows ship separately, capped to the recent few, so
  // yesterday's checkmarks are one tap away without becoming scroll weight.
  // The completed tail uses the same read policy as the active rows.
  // The tail is the 20 most recently updated done rows; done_total reports the uncapped count.
  const doneParams: unknown[] = [workspaceId];
  const doneClause = readableScopeSql(actor, "t", doneParams);
  const doneWhere =
    `${TASK_JOIN_SQL}
       ${TASK_HOST_JOIN_SQL}
      WHERE t.workspace_id = $1 AND ${liveNodeSql("t")}
        AND ${TASK_HOST_LIVE_WHERE}
        AND s.value = 'done'
        AND ${doneClause}`;
  const done = await pool.query<AgendaRow>(
    `SELECT ${TASK_COLUMNS_SQL}, COALESCE(host.title, '') AS node_title
       ${doneWhere}
      ORDER BY t.updated_at DESC
      LIMIT 20`,
    doneParams,
  );
  const doneTotal = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n ${doneWhere}`,
    doneParams,
  );
  return {
    buckets,
    count: visible.length,
    done: done.rows.map((r) => ({ ...r, bucket: "done" })),
    done_total: doneTotal.rows[0]?.n ?? 0,
  };
}
