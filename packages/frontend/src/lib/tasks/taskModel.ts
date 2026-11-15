// The task page's model: one normalised task shape and the pure rules that
// sort tasks onto the four tabs (今天 / 接下來 / 隨時 / 某天).
//
// Which tab a task lives on is @onden/markdown's rule (taskHome), the same one the
// server's agenda and the exported list follow.

import { taskBucket, taskHome, weekdayOf } from "@onden/markdown";
import type { NodeTask } from "../api";
import { addDays, daysBetween } from "../localDate";

/** The task row. Fields past NodeTask are optional so the offline mirror's rows still type-check. */
export type TaskRow = Omit<NodeTask, "node_id"> & {
  node_id: string | null;
  when_date?: string | null;
  evening?: boolean;
  someday?: boolean;
  deadline?: string | null;
  recur_mode?: "fixed" | "after";
  remind_at?: string | null;
  time?: string | null;
  until?: string | null;
  done_at?: string | null;
  block_ref?: string | null;
  space_id?: string | null;
  has_body?: boolean;
};

/** Where an item comes from: its own task node (standalone) or a checkbox line of a note. */
export type TaskSource = "standalone" | "line";

export type TaskItem = {
  id: string;
  title: string;
  status: NodeTask["status"];
  source: TaskSource;
  /** The note holding this task as a checkbox line; null = a standalone task. */
  noteId: string | null;
  /** "" for a standalone task or a note that is gone. */
  noteTitle: string;
  /** YYYY-MM-DD, or null. */
  whenDate: string | null;
  evening: boolean;
  someday: boolean;
  deadline: string | null;
  /** `<n><d|w|m>` or null. */
  recur: string | null;
  recurMode: "fixed" | "after";
  /** YYYY-MM-DDTHH:MM wall clock, or null. */
  remindAt: string | null;
  /** HH:MM it starts and ends (written at the start of its line), or null. */
  time: string | null;
  until: string | null;
  /** ISO instant it was completed, or null. */
  doneAt: string | null;
  /** The `^id` of its line in `noteId`, or null. */
  blockRef: string | null;
  hasBody: boolean;
};

export type TaskTab = "today" | "upcoming" | "anytime" | "someday";
export const TASK_TABS: readonly TaskTab[] = ["today", "upcoming", "anytime", "someday"];

/** A deadline this close (in days, today included) floats onto 今天. */
export const DEADLINE_SOON_DAYS = 2;

const dayOf = (value: string | null | undefined): string | null => (value ? value.slice(0, 10) : null);

export function isOpen(status: NodeTask["status"]): boolean {
  return status !== "done" && status !== "cancelled";
}

export function toTaskItem(row: TaskRow, noteTitleOf: (noteId: string) => string | undefined): TaskItem {
  const whenDate = dayOf(row.when_date);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    source: row.node_id ? "line" : "standalone",
    noteId: row.node_id,
    noteTitle: row.node_id ? noteTitleOf(row.node_id) ?? "" : "",
    whenDate,
    evening: row.evening ?? false,
    someday: !whenDate && (row.someday ?? false),
    deadline: dayOf(row.deadline),
    recur: row.recur ?? null,
    recurMode: row.recur_mode ?? "fixed",
    remindAt: row.remind_at ?? null,
    time: row.time ?? null,
    until: row.until ?? null,
    doneAt: row.done_at ?? null,
    blockRef: row.block_ref ?? null,
    hasBody: row.has_body ?? false,
  };
}

export type DayGroup = { date: string; items: TaskItem[] };

export type TaskBuckets = {
  today: { today: TaskItem[]; evening: TaskItem[]; dueSoon: TaskItem[] };
  upcoming: DayGroup[];
  anytime: TaskItem[];
  someday: TaskItem[];
};

/** Which tab the task lives on by its own fields (the 快到期 section is an
 *  extra view onto 今天, not a home). */
export function homeTab(task: TaskItem, today: string): TaskTab {
  return taskHome({ when: task.whenDate, someday: task.someday }, today);
}

/** An open task whose day has passed: it sits on 今天, but the page says it is
 *  late, in the word the due-soon notification uses (taskBucket "overdue"). */
export function isOverdue(task: TaskItem, today: string): boolean {
  return taskBucket({ status: task.status, when: task.whenDate, someday: task.someday }, today) === "overdue";
}

/** True when the deadline is within `days` (DEADLINE_SOON_DAYS) of `today` (or past). */
export function deadlineIsSoon(deadline: string | null, today: string, days = DEADLINE_SOON_DAYS): boolean {
  return deadline !== null && daysBetween(today, deadline) <= days;
}

/** Sort tasks onto the four tabs. `today` is the workspace's YYYY-MM-DD
 *  (lib/localDate todayId), so the day rolls over in the workspace's zone.
 *  Open tasks only, plus any id in `keepDone` — a task just ticked stays on
 *  its row, struck through, until the page moves on to another tab. */
export function bucketTasks(tasks: readonly TaskItem[], today: string, keepDone: ReadonlySet<string> = new Set()): TaskBuckets {
  const out: TaskBuckets = { today: { today: [], evening: [], dueSoon: [] }, upcoming: [], anytime: [], someday: [] };
  const groups = new Map<string, TaskItem[]>();
  for (const task of tasks) {
    if (task.status === "cancelled") continue;
    if (!isOpen(task.status) && !keepDone.has(task.id)) continue;
    const home = homeTab(task, today);
    if (home === "today") (task.evening ? out.today.evening : out.today.today).push(task);
    else {
      if (home === "upcoming") {
        const date = task.whenDate!;
        groups.set(date, [...(groups.get(date) ?? []), task]);
      } else out[home].push(task);
      if (isOpen(task.status) && deadlineIsSoon(task.deadline, today)) out.today.dueSoon.push(task);
    }
  }
  out.upcoming = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, items]) => ({ date, items }));
  out.today.dueSoon.sort((a, b) => (a.deadline! < b.deadline! ? -1 : a.deadline! > b.deadline! ? 1 : 0));
  return out;
}

/** Open tasks per tab: what the tab labels show. A task floating into 今天
 *  for its deadline counts there as well as on its own tab. */
export function tabCounts(buckets: TaskBuckets): Record<TaskTab, number> {
  const open = (items: TaskItem[]) => items.filter((task) => isOpen(task.status)).length;
  const { today, evening, dueSoon } = buckets.today;
  return {
    today: open(today) + open(evening) + open(dueSoon),
    upcoming: buckets.upcoming.reduce((sum, group) => sum + open(group.items), 0),
    anytime: open(buckets.anytime),
    someday: open(buckets.someday),
  };
}

// ── Days ─────────────────────────────────────────────────────────────────

/** The next Monday strictly after `today`. */
export function nextMonday(today: string): string {
  const w = weekdayOf(today);
  return addDays(today, ((8 - w) % 7) || 7);
}

/** The coming Friday (today when today is Friday). */
export function thisFriday(today: string): string {
  return addDays(today, (5 - weekdayOf(today) + 7) % 7);
}

export type DayDescription =
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "date"; weekday: number; month: number; day: number };

export function describeDay(date: string, today: string): DayDescription {
  const diff = daysBetween(today, date);
  if (diff === 0) return { kind: "today" };
  if (diff === 1) return { kind: "tomorrow" };
  const [, month, day] = date.split("-").map(Number);
  return { kind: "date", weekday: weekdayOf(date), month: month!, day: day! };
}

// ── Writes ───────────────────────────────────────────────────────────────

export type WhenChoice =
  | { kind: "today" }
  | { kind: "evening" }
  | { kind: "tomorrow" }
  | { kind: "nextMonday" }
  | { kind: "date"; date: string }
  | { kind: "anytime" }
  | { kind: "someday" };

/** What a change to a task is, in the contract's field names. */
export type TaskChanges = Partial<{
  title: string;
  status: NodeTask["status"];
  when_date: string | null;
  evening: boolean;
  someday: boolean;
  deadline: string | null;
  recur: string | null;
  recur_mode: "fixed" | "after";
  remind_at: string | null;
  time: string | null;
  until: string | null;
}>;

/** The fields a 何時做 choice sets. Each choice sets all three, so choosing
 *  one never leaves a stale flag from the previous choice behind. */
export function whenChanges(choice: WhenChoice, today: string): Pick<TaskChanges, "when_date" | "evening" | "someday"> {
  switch (choice.kind) {
    case "today": return { when_date: today, evening: false, someday: false };
    case "evening": return { when_date: today, evening: true, someday: false };
    case "tomorrow": return { when_date: addDays(today, 1), evening: false, someday: false };
    case "nextMonday": return { when_date: nextMonday(today), evening: false, someday: false };
    case "date": return { when_date: choice.date, evening: false, someday: false };
    case "anytime": return { when_date: null, evening: false, someday: false };
    case "someday": return { when_date: null, evening: false, someday: true };
  }
}

/** Which 何時做 pill is lit for a task. A date that is none of the shortcuts
 *  lights 選日期. */
export function whenChoiceOf(task: TaskItem, today: string): WhenChoice["kind"] {
  if (task.someday) return "someday";
  if (!task.whenDate) return "anytime";
  if (homeTab(task, today) === "today") return task.evening ? "evening" : "today";
  if (task.whenDate === addDays(today, 1)) return "tomorrow";
  if (task.whenDate === nextMonday(today)) return "nextMonday";
  return "date";
}

/** The repeat rule as pills: none, the three presets, or a custom `<n><unit>`. */
export function recurPreset(recur: string | null): "none" | "1d" | "1w" | "1m" | "custom" {
  if (!recur) return "none";
  return recur === "1d" || recur === "1w" || recur === "1m" ? recur : "custom";
}
