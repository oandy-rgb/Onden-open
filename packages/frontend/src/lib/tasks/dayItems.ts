// A day's tasks as the 日子 page's timeline items (the tasks module's part of
// FrontendModule.dayItems). A task whose when-date is the day is listed; one
// with a start time (`time`, HH:MM on the workspace clock) sits on the timeline,
// the rest are 「不限時間」. The time fields are optional: a task row that has
// none (every row today) is simply untimed, and the day works the same.

import { dayNoteDate, type DayItem } from "@onden/markdown";
import { clockInstant } from "../dayWindow";
import { t } from "../i18n";
import { nearDayLabel } from "../timeLabels";
import { displayTitle } from "../noteLabel";
import type { ContentNode, NodeTask, Tag } from "../api";
import { fromNodeTask, type JournalTask } from "./journalBuckets";

/** The optional time of day a task may carry once the tasks module stores one. */
export type TaskTimes = { time?: string | null; until?: string | null };

type Context = { date: string; today: string; nodes: readonly ContentNode[]; tasks: readonly NodeTask[]; tags: readonly Tag[] };

/** Where a task was written, as the line under it: 「來自 11/5 日記」 (a journal of another day;
 *  the year only when it is not this one) or 「來自 {title}」 (any other note). `undefined`: say
 *  nothing: a standalone task, or one sitting in the journal page of `date` itself, where the page
 *  already says where it is. The ONE wording of a task's source, for every list that shows tasks. */
export function hostNoteLabel(hostTitle: string | null | undefined, date: string, today: string): string | undefined {
  if (!hostTitle) return undefined;
  const written = dayNoteDate({ title: hostTitle });
  if (written === date) return undefined;
  if (!written) return t("From {title}", { title: displayTitle(hostTitle) });
  return t("From the {date} journal", { date: nearDayLabel(written, today) });
}

/** One task as it is listed: the note it belongs to is its second line. */
function taskItem(task: JournalTask, times: TaskTimes, hostTitle: string | undefined, { date, today }: Pick<Context, "date" | "today">): DayItem | null {
  if (task.status === "cancelled" || task.someday || task.when_date !== date) return null;
  const at = times.time ? clockInstant(date, times.time) : null;
  const until = at && times.until ? clockInstant(date, times.until) : null;
  const finished = task.status === "done";
  const host = hostNoteLabel(hostTitle, date, today);
  return {
    ...(at ? { at, ...(until && until > at ? { until } : {}) } : {}),
    kind: "task",
    title: task.title,
    ...(host ? { detail: host } : {}),
    ref: { type: "task", id: task.id },
    done: finished,
    past: finished || date < today,
  };
}

/** Every task of `date`. */
export function taskDayItems(context: Context): DayItem[] {
  const titleOf = new Map(context.nodes.map((n) => [n.id, n.title]));
  const items: DayItem[] = [];
  for (const task of context.tasks) {
    const item = taskItem(fromNodeTask(task), task as NodeTask & TaskTimes, task.node_id ? titleOf.get(task.node_id) : undefined, context);
    if (item) items.push(item);
  }
  return items;
}
