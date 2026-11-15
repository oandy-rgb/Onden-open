// Due-soon reminders — the "nothing ever fires" gap (busy-parent persona #2).
//
// The agenda (GET /api/tasks/agenda) already BUCKETS tasks server-side
// (overdue / today / upcoming / …) but it is a passive lens: you only see a
// due task if you happen to open Tasks. This module turns those buckets into
// ACTIVE reminders — it decides which tasks deserve a one-shot OS notification
// and builds the notification payload. The browser-/SW-side plumbing lives in
// hooks/useDueSoonNotifications.ts; this file is pure so it can be unit-tested
// without a DOM, a service worker, or a network.
//
// De-dupe contract: a task fires AT MOST ONCE per (id, bucket) per device. The
// caller persists the set of already-fired keys (localStorage) and feeds it
// back in; we never re-notify the same overdue task on every poll. A task that
// moves overdue→today (a new day rolled over) is a NEW key, so it fires again
// once — which is the desired "it's due today now" nudge.

import { REMIND_CATCH_UP_MS, dueReminderMoment, reminderAgoMs, reminderKey, reminderMoment, reminderStatusOpen, type ReminderNow as Now } from "@onden/markdown";
import { t as tr } from "./i18n";

/** The agenda task shape returned by GET /api/tasks/agenda. */
export type AgendaTask = {
  id: string;
  /** The task's note; null for a standalone task. */
  node_id: string | null;
  node_title: string;
  title: string;
  status: string;
  due_date: string | null;
  recur: string | null;
  bucket: string;
  /** When to remind: an ISO instant, or YYYY-MM-DDTHH:MM in the workspace's zone. */
  remind_at?: string | null;
  /** HH:MM it starts, on the day `due_date`. */
  time?: string | null;
};

export type Agenda = { buckets: Record<string, AgendaTask[]>; count: number };

/** A ready-to-show notification for one due/overdue task. */
export type DueNotice = {
  /** Stable de-dupe key: `${bucket}:${id}`. One fire per key per device. */
  key: string;
  taskId: string;
  /** Node to open when the notification is clicked. */
  nodeId: string | null;
  title: string;
  body: string;
  /** Overdue is the louder, attention-requiring tier. */
  urgent: boolean;
};

/** Buckets that warrant an active reminder. "upcoming" (next 7 days) is left
 *  to the passive lens — only what's due NOW (or already late) interrupts. */
const NOTIFY_BUCKETS = ["overdue", "today"] as const;

const REMIND_KEY_PREFIX = "remind:";
const isRemindKey = (key: string): boolean => key.startsWith(REMIND_KEY_PREFIX);

/** The fired set to keep: keys of this kind that are still live, every key of
 *  the other kind untouched (the other check owns pruning those), and the new
 *  notices. Both checks share one persisted set, so neither may drop the
 *  other's keys or that one would fire again on the next poll. */
function keepFired(alreadyFired: ReadonlySet<string>, ownsKey: (key: string) => boolean, live: ReadonlySet<string>, notices: readonly DueNotice[]): Set<string> {
  const kept = new Set<string>();
  for (const key of alreadyFired) if (!ownsKey(key) || live.has(key)) kept.add(key);
  for (const n of notices) kept.add(n.key);
  return kept;
}

function dueKey(t: AgendaTask): string {
  return `${t.bucket}:${t.id}`;
}

function noticeBody(t: AgendaTask): string {
  if (t.bucket === "overdue") {
    return t.due_date
      ? tr("Overdue since {date} · {title}", { date: t.due_date, title: t.node_title })
      : tr("Overdue · {title}", { title: t.node_title });
  }
  return tr("Due today · {title}", { title: t.node_title });
}

/**
 * Flatten the agenda's notify-worthy buckets into a stable, de-duped list of
 * tasks that SHOULD currently have a reminder. Order: overdue first (most
 * urgent), then today; stable within a bucket (server order preserved).
 */
export function dueTasks(agenda: Agenda | null | undefined): AgendaTask[] {
  if (!agenda?.buckets) return [];
  const out: AgendaTask[] = [];
  for (const bucket of NOTIFY_BUCKETS) {
    for (const t of agenda.buckets[bucket] ?? []) {
      // Defensive: never nag about a finished task even if the server somehow
      // bucketed it (e.g. status flipped between the bucket query and read).
      if (t.status === "done" || t.status === "cancelled") continue;
      out.push(t);
    }
  }
  return out;
}

/** Whether the moment spelled in a `remind:<task>:<moment>` key is older than the catch-up window
 *  (so it can never be due again) or is no time at all. */
function pastCatchUp(key: string, now: Now): boolean {
  const text = key.slice(key.indexOf(":", REMIND_KEY_PREFIX.length) + 1);
  const ago = reminderAgoMs({ text, instant: /(?:Z|[+-]\d\d:?\d\d)$/.test(text) }, now);
  return !(ago <= REMIND_CATCH_UP_MS);
}

/** Every task the agenda holds, in every bucket (upcoming, unscheduled… too): a reminder is set by
 *  its own moment, which can come while the task is in any of them. */
function openTasks(agenda: Agenda | null | undefined): AgendaTask[] {
  return Object.values(agenda?.buckets ?? {}).flat();
}

/**
 * Decide which due tasks to fire RIGHT NOW given what has already fired.
 * Returns the notices to show plus the updated fired-key set to persist.
 * Pure: no Date.now, no I/O — the bucketing already encodes "now".
 */
export function pendingDueNotices(
  agenda: Agenda | null | undefined,
  alreadyFired: ReadonlySet<string>,
): { notices: DueNotice[]; firedKeys: Set<string> } {
  const tasks = dueTasks(agenda);
  const liveKeys = new Set(tasks.map(dueKey));
  const notices: DueNotice[] = [];

  for (const t of tasks) {
    const key = dueKey(t);
    if (alreadyFired.has(key)) continue;
    notices.push({
      key,
      taskId: t.id,
      nodeId: t.node_id,
      title: t.bucket === "overdue" ? tr("Overdue: {title}", { title: t.title }) : tr("Due today: {title}", { title: t.title }),
      body: noticeBody(t),
      urgent: t.bucket === "overdue",
    });
  }

  // Keep only keys that are still live so the persisted set can't grow forever
  // and so a task that leaves then re-enters a bucket can fire again.
  return { notices, firedKeys: keepFired(alreadyFired, (key) => !isRemindKey(key), liveKeys, notices) };
}

// ── Reminders at a time ──────────────────────────────────────────────────
// A task with a reminder (or a start time) is nudged when that moment comes,
// while the app is open: the hook checks every few seconds against the agenda
// it holds, and when the app comes back it catches up on what passed while it
// was away. Each (task, moment) fires once per device. A browser tab cannot be
// woken while the screen is locked, so a nudge then arrives when the app is
// opened again, not on the minute (docs/architecture/day-timeline.md).

export { REMIND_CATCH_UP_MS, reminderMoment } from "@onden/markdown";
export type { Now };

/** Reminders whose moment has come and not fired yet, with the fired set to
 *  keep. Pure: `now` is given. */
export function pendingRemindNotices(
  agenda: Agenda | null | undefined,
  now: Now,
  alreadyFired: ReadonlySet<string>,
): { notices: DueNotice[]; firedKeys: Set<string> } {
  const notices: DueNotice[] = [];
  const live = new Set<string>();
  // A fired reminder is remembered while its task is in the agenda, and after that until its moment can
  // no longer be caught up: a task finished and reopened must not say the same moment again.
  for (const key of alreadyFired) if (isRemindKey(key) && !pastCatchUp(key, now)) live.add(key);
  for (const task of openTasks(agenda)) {
    if (!reminderStatusOpen(task.status)) continue;
    const moment = reminderMoment(task, now.dayStartHour);
    if (!moment) continue;
    const key = reminderKey(task.id, moment);
    live.add(key);
    if (alreadyFired.has(key) || !dueReminderMoment(task, now)) continue;
    notices.push({
      key, taskId: task.id, nodeId: task.node_id, urgent: false,
      title: tr("Reminder: {title}", { title: task.title }),
      body: task.node_title ? tr("In “{note}”", { note: task.node_title }) : tr("Time to start"),
    });
  }
  return { notices, firedKeys: keepFired(alreadyFired, isRemindKey, live, notices) };
}

/** Count of tasks that currently warrant attention — for an in-app badge. */
export function dueSoonCount(agenda: Agenda | null | undefined): number {
  return dueTasks(agenda).length;
}
