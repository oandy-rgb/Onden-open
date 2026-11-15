import { q } from "../../db.js";
import { log } from "../../logger.js";
import { startPeriodicJob } from "../../backgroundJobs.js";
import { dayClock, localDateTimeId, localDayId, addDays, workspaceTimeZone } from "../../localDay.js";
import { TASKS_MODULE_ID } from "../../spine/taskIdentity.js";
import { readableAmong } from "../../services/readPolicy.js";
import { TASK_COLUMNS_SQL, TASK_JOIN_SQL, TASK_HOST_JOIN_SQL, TASK_HOST_LIVE_WHERE } from "../../services/tasksStore.js";
import { defaultSender, endpointHost, pushConfigured, type PushSender } from "../../services/webPush.js";
import type { ActorCtx } from "../../types.js";
import { dueReminderMoment, reminderKey, type ReminderMoment } from "@onden/markdown";

import { liveNodeSql } from "../../spine/nodeSql.js";
// Lock-screen reminders (docs/architecture/day-timeline.md §5). Every minute: the
// open tasks whose reminder moment has come (the same rule the app uses while it
// is open, @onden/markdown taskReminder) and was not pushed yet go to the devices
// of every member who may read the task. A task has no owner or assignee in
// Onden, so "who is told" is "who can read it", the same people the agenda shows it to.
//
// Sent once per (task, moment): the claim is an insert into push_reminder_sent,
// so a restart, or a second backend process, cannot send it again; the job also
// runs on one instance at a time (advisory lock, backgroundJobs `exclusive`).
// A moment is claimed before sending (at most once); if every device failed with
// something that may pass (network, 5xx) the claim is given back for the next
// minute, until the 12-hour catch-up window ends. 404/410 from the push service
// mean the device is gone: its subscription is deleted.

type TaskDueRow = { id: string; workspace_id: string; node_id: string | null; title: string; status: string; when_date: string | null; remind_at: string | null; time: string | null };
type SubRow = { id: string; workspace_id: string; endpoint: string; p256dh: string; auth: string; actor_id: string; actor_name: string; actor_type: ActorCtx["type"] };

export type PushReminderResult = { due: number; sent: number; removed: number };

const SENT_KEEP_DAYS = 3;

/** "HH:MM" the task is to be reminded at — the only time the notification shows. */
function momentClock(moment: ReminderMoment): string {
  if (!moment.instant) return moment.text.slice(11, 16);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: workspaceTimeZone(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(moment.text));
  return parts;
}

/** What a device shows. Only the task title and the time: never the note's text.
 *  `tag` is the in-app notice's key, so a notice already shown by the open app is replaced, not doubled. */
export function reminderPayload(task: TaskDueRow, moment: ReminderMoment): string {
  return JSON.stringify({
    title: task.title || "Onden",
    body: momentClock(moment),
    tag: reminderKey(task.id, moment),
    data: { nodeId: task.node_id, taskId: task.id, url: task.node_id ? `/?view=notes&node=${task.node_id}` : "/?view=tasks" },
  });
}

const statusOf = (e: unknown): number | null => {
  const code = (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : null;
};

/** One pass. `at` and `send` are injectable for tests; production passes neither. */
export async function drainPushReminders(opts: { at?: Date; send?: PushSender } = {}): Promise<PushReminderResult> {
  const result: PushReminderResult = { due: 0, sent: 0, removed: 0 };
  if (!pushConfigured()) return result;
  const at = opts.at ?? new Date();
  const send = opts.send ?? defaultSender;
  const now = { ms: at.getTime(), wall: localDateTimeId(at), dayStartHour: dayClock().dayStartHour };

  // Rows that could be due: a day window wide enough for any zone, then the shared rule decides.
  const dayFrom = addDays(localDayId(at), -2);
  const dayTo = addDays(localDayId(at), 1);
  const candidates = await q<TaskDueRow>(
    `SELECT ${TASK_COLUMNS_SQL}
       ${TASK_JOIN_SQL}
       JOIN workspaces ws ON ws.id = t.workspace_id AND NOT (ws.modules_off ? '${TASKS_MODULE_ID}')
       ${TASK_HOST_JOIN_SQL}
      WHERE ${liveNodeSql("t")} AND ${TASK_HOST_LIVE_WHERE}
        AND s.value IN ('todo', 'doing')
        AND (ra.value IS NOT NULL OR (tm.value IS NOT NULL AND w.value IS NOT NULL))
        AND COALESCE(left(ra.value, 10), w.value) BETWEEN $1 AND $2`,
    [dayFrom, dayTo],
  );
  const due = candidates.rows.flatMap((task) => {
    const moment = dueReminderMoment(task, now);
    return moment ? [{ task, moment }] : [];
  });
  result.due = due.length;
  if (due.length > 0) await sendDue(due, send, result);

  await q(`DELETE FROM push_reminder_sent WHERE sent_at < now() - make_interval(days => $1)`, [SENT_KEEP_DAYS]);
  return result;
}

async function sendDue(due: { task: TaskDueRow; moment: ReminderMoment }[], send: PushSender, result: PushReminderResult): Promise<void> {
  const workspaces = [...new Set(due.map((d) => d.task.workspace_id))];
  const subs = await q<SubRow>(
    `SELECT p.id, p.workspace_id, p.endpoint, p.p256dh, p.auth, p.actor_id, a.name AS actor_name, a.type AS actor_type
       FROM push_subscriptions p JOIN actors a ON a.id = p.actor_id
      WHERE p.workspace_id = ANY($1::uuid[])`,
    [workspaces],
  );
  if (subs.rows.length === 0) return;

  // Who may read which due task (the agenda's rule, per person, in one query each).
  const byActor = new Map<string, { actor: ActorCtx; workspaceId: string; subs: SubRow[] }>();
  for (const s of subs.rows) {
    const entry = byActor.get(s.actor_id) ?? { actor: { id: s.actor_id, name: s.actor_name, type: s.actor_type }, workspaceId: s.workspace_id, subs: [] };
    entry.subs.push(s);
    byActor.set(s.actor_id, entry);
  }
  const readable = new Map<string, Set<string>>();
  for (const [actorId, entry] of byActor) {
    const ids = due.filter((d) => d.task.workspace_id === entry.workspaceId).map((d) => d.task.id);
    readable.set(actorId, await readableAmong(entry.actor, entry.workspaceId, ids));
  }

  for (const { task, moment } of due) {
    const targets = [...byActor.values()].filter((e) => readable.get(e.actor.id)?.has(task.id)).flatMap((e) => e.subs);
    if (targets.length === 0) continue; // nobody to tell: not claimed, a device added within the window still gets it
    const claim = await q(
      `INSERT INTO push_reminder_sent (task_id, moment) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [task.id, moment.text],
    );
    if ((claim.rowCount ?? 0) === 0) continue; // already pushed

    const payload = reminderPayload(task, moment);
    let delivered = 0;
    let retryable = 0;
    for (const sub of targets) {
      try {
        await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        delivered++;
        await q(`UPDATE push_subscriptions SET last_ok_at = now() WHERE id = $1`, [sub.id]);
      } catch (e) {
        const status = statusOf(e);
        if (status === 404 || status === 410) {
          await q(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
          result.removed++;
        } else {
          retryable++;
          log.warn("push-reminders", `push to ${endpointHost(sub.endpoint)} failed`, { status });
        }
      }
    }
    result.sent += delivered;
    if (delivered === 0 && retryable > 0) {
      await q(`DELETE FROM push_reminder_sent WHERE task_id = $1 AND moment = $2`, [task.id, moment.text]);
    }
  }
}

/** Start the every-minute pass. Without VAPID keys nothing is scheduled at all. */
export function startPushReminders(): void {
  if (!pushConfigured()) return;
  startPeriodicJob({ name: "push-reminders", everyMs: 60_000, runFirstAfterMs: 20_000, exclusive: true }, async () => { await drainPushReminders(); });
}
