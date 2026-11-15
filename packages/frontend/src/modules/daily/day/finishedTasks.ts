// Tasks finished on a day, as rows for the journal's 「這天發生的」: the journal looks
// back, so a day shows what got done on it, not what is still open.

import type { DayItem } from "@onden/markdown";
import type { NodeTask } from "../../../lib/api";
import { dateIdAt } from "../../../lib/localDate";
import { taskDay } from "../../../lib/tasks";

/** The tasks done on `date`: by the workspace day of `done_at`, else (no finish time
 *  recorded) by the day they were planned for. Earliest first; ones with no finish
 *  time last. `at` is the finish time, which the row shows. */
export function finishedTaskItems(tasks: readonly NodeTask[], date: string): DayItem[] {
  const items: DayItem[] = [];
  for (const task of tasks) {
    if (task.status !== "done") continue;
    const doneAt = task.done_at && !Number.isNaN(Date.parse(task.done_at)) ? task.done_at : null;
    const planned = task.when_date ?? task.due_date;
    const day = doneAt ? dateIdAt(new Date(doneAt)) : planned ? taskDay(planned) : undefined;
    if (day !== date) continue;
    items.push({ kind: "task", title: task.title, ...(doneAt ? { at: doneAt } : {}), ref: { type: "task", id: task.id }, past: true, done: true });
  }
  return items.sort((a, b) => (a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : a.at ? -1 : b.at ? 1 : 0));
}
