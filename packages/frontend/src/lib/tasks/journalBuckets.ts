// What the journal's today shows (pure, unit-tested). The journal starts every
// day clean: its 「今天」 lists only tasks whose when-date IS today; earlier
// ones go to the suggestions, to be decided one by one. This differs on
// purpose from the Tasks page, where an overdue when-date counts as today.
//
// The row shape is the task contract (when_date / evening / someday). The day
// rule is @onden/markdown taskBucket, the one the Tasks page and the agenda use:
// the journal reads its `today` and `overdue` buckets apart, where the page
// folds overdue into today (taskHome).

import { taskBucket } from "@onden/markdown";
import type { NodeTask } from "../api";
import { dateIdAt } from "../localDate";

export type JournalTask = {
  id: string;
  title: string;
  status: NodeTask["status"];
  /** YYYY-MM-DD, or null (anytime). */
  when_date: string | null;
  evening: boolean;
  someday: boolean;
  recur: string | null;
  /** ISO time of the last change; dates a task finished today. */
  updated_at: string | null;
};

type TaskFields = Partial<{ when_date: string | null; evening: boolean; someday: boolean }>;

/** The calendar day of a task's stored date (a date, or a date with a clock time after it). */
export const taskDay = (stored: string): string => stored.slice(0, 10);

export function fromNodeTask(task: NodeTask & TaskFields): JournalTask {
  return {
    id: task.id, title: task.title, status: task.status,
    when_date: task.when_date ? taskDay(task.when_date) : null,
    evening: task.evening ?? false, someday: task.someday ?? false,
    recur: task.recur ?? null, updated_at: task.updated_at ?? null,
  };
}

const isOpen = (task: JournalTask) => task.status === "todo" || task.status === "doing";

export type JournalBuckets = {
  /** Open tasks to do today, tonight's last. */
  today: JournalTask[];
  /** Finished today (when-date today, or ticked off today). */
  doneToday: JournalTask[];
  /** Open, when-date already past: offered, never piled into today. Oldest first. */
  suggestions: JournalTask[];
};

/** `today` is the workspace-zone date id; `timeZone` dates `updated_at`. */
export function journalBuckets(tasks: readonly JournalTask[], today: string, timeZone?: string): JournalBuckets {
  const bucketOf = (task: JournalTask) => taskBucket({ status: task.status, when: task.when_date, someday: task.someday }, today);
  const open = tasks.filter(isOpen);
  const todayOpen = open.filter((task) => bucketOf(task) === "today");
  return {
    today: [...todayOpen.filter((task) => !task.evening), ...todayOpen.filter((task) => task.evening)],
    doneToday: tasks.filter((task) => task.status === "done" && !task.someday && (
      task.when_date === today || (!!task.updated_at && dateIdAt(new Date(task.updated_at), timeZone) === today))),
    suggestions: open.filter((task) => bucketOf(task) === "overdue")
      .sort((a, b) => a.when_date!.localeCompare(b.when_date!)),
  };
}
