// The dots under the days of the week row and the month (DayStrip): solid = a day with writing (a note whose
// body is still loading counts until it says otherwise), hollow = a day with a task scheduled on it.
// The Journal page draws them from this.

import { useMemo } from "react";
import { nodeNeedsBody } from "../../lib/api";
import { useAllNodes, useTaskRows } from "../../lib/appStore";
import { personalSpaceId } from "../../lib/spaces";
import { fromNodeTask } from "../../lib/tasks";
import { dayNotesByDate, parentsWithCaptures } from "./journal";

export function useDayMarks(tasksOn: boolean) {
  const nodes = useAllNodes();
  const tasks = useTaskRows();
  const spaceId = personalSpaceId();
  const byDate = useMemo(() => dayNotesByDate(nodes, spaceId), [nodes, spaceId]);
  const captured = useMemo(() => parentsWithCaptures(nodes), [nodes]);
  const written = useMemo(() => {
    const set = new Set<string>();
    for (const [date, day] of byDate) if (nodeNeedsBody(day) || !!day.markdown?.trim() || captured.has(day.id)) set.add(date);
    return set;
  }, [byDate, captured]);
  const planned = useMemo(() => {
    const set = new Set<string>();
    if (!tasksOn) return set;
    for (const task of tasks) {
      const date = fromNodeTask(task).when_date;
      if (date && task.status !== "cancelled") set.add(date);
    }
    return set;
  }, [tasks, tasksOn]);
  return { byDate, written, planned };
}
