// Quick-add in a timeline slot: which existing tasks can be put into the slot instead of making a
// new one. Read from the store's tasks (no request): the open ones — overdue, today, coming up,
// anytime, someday — whose title holds what was typed; with nothing typed, the ones with no time yet.

import { taskBucket } from "@onden/markdown";
import type { NodeTask } from "../../lib/api";

export type SlotTaskBucket = ReturnType<typeof taskBucket>;
export type SlotTaskChoice = { task: NodeTask; bucket: SlotTaskBucket };

const RANK: Partial<Record<SlotTaskBucket, number>> = { overdue: 1, today: 2, unscheduled: 3, upcoming: 4, scheduled: 5, later: 6 };

export function tasksForSlot(tasks: readonly NodeTask[], query: string, date: string, today: string, limit = 5): SlotTaskChoice[] {
  const needle = query.trim().toLowerCase();
  const rows: Array<SlotTaskChoice & { rank: number }> = [];
  for (const task of tasks) {
    const bucket = taskBucket({ when: task.when_date ?? task.due_date, someday: task.someday, status: task.status }, today);
    if (bucket === "done" || bucket === "waiting") continue;
    const title = task.title.toLowerCase();
    if (needle ? !title.includes(needle) : !!task.time) continue;
    const sameDay = (task.when_date ?? task.due_date) === date && !task.someday;
    // the slot's own day first, then what is late, then the rest by how soon; a title that starts with the words first
    rows.push({ task, bucket, rank: (sameDay ? 0 : RANK[bucket] ?? 7) * 2 + (needle && title.startsWith(needle) ? 0 : 1) });
  }
  return rows.sort((a, b) => a.rank - b.rank || a.task.title.localeCompare(b.task.title)).slice(0, limit).map(({ task, bucket }) => ({ task, bucket }));
}
