// The 日子 page's task writes: one task, one change, through taskWriter. A failure
// is told in plain words (writeErrors) and the page keeps what it showed.

import { formatLineTime, type DayItem } from "@onden/markdown";
import { addToast, getAppState, useTaskRows } from "../../../lib/appStore";
import { t } from "../../../lib/i18n";
import type { TimeSlot } from "./timelineSlots";
import { taskWriter, writeErrors, type TaskPatch } from "../../../lib/data";

/** Applies `changes` to the task; true when the write was accepted or queued. */
export async function writeTaskFields(id: string, changes: TaskPatch): Promise<boolean> {
  try {
    await taskWriter.patch(id, changes);
    return true;
  } catch (error) {
    writeErrors.report(error, addToast);
    return false;
  }
}

/** Plans the task for `date`; a parked task ("someday") comes back from the shelf. */
export const planTaskOn = (id: string, date: string) => writeTaskFields(id, { when_date: date, someday: null });

/** The note a day's item opens: for a task the note it sits in (else itself), otherwise the item's own. */
export function dayItemNoteId(tasks: readonly { id: string; node_id: string | null }[], item: DayItem): string | null {
  if (!item.ref) return null;
  return item.ref.type === "task" ? tasks.find((task) => task.id === item.ref!.id)?.node_id ?? item.ref.id : item.ref.id;
}

/** What a tap does on a day's item: open its note (a task opens the note it sits in, or itself),
 *  and tick or untick a task. */
export function useDayItemActions(onOpenNode: (id: string) => void) {
  const tasks = useTaskRows();
  const open = (item: DayItem) => {
    const noteId = dayItemNoteId(tasks, item);
    if (noteId) onOpenNode(noteId);
  };
  const toggle = (item: DayItem) => {
    if (item.ref?.type === "task") void writeTaskFields(item.ref.id, { status: item.done ? "todo" : "done" });
  };
  return { open, toggle };
}

/** What a task's day and time were, to put back. */
type Placement = { when_date: string | null; someday: boolean | null; time: string | null; until: string | null };

/** Gives the task the clock time `slot` on `date` (the day too, if it was on another or none), then
 *  tells it with a 「復原」 that puts back what it had. The line in its note is rewritten by the
 *  server (syncTaskLine). False when the task is done, gone, or the write was refused. */
export async function scheduleTaskAt(id: string, date: string, slot: TimeSlot): Promise<boolean> {
  const task = getAppState().data.tasks.find((row) => row.id === id);
  if (!task || task.status === "done") return false;
  const before: Placement = { when_date: task.when_date ?? null, someday: task.someday ? true : null, time: task.time ?? null, until: task.until ?? null };
  const moved = await writeTaskFields(id, { time: slot.time, until: slot.until, ...(before.when_date !== date || before.someday ? { when_date: date, someday: null } : {}) });
  if (!moved) return false;
  addToast(t("Planned for {time}", { time: formatLineTime(slot.time, slot.until) }), "success", {
    label: t("Undo"),
    onClick: () => { void writeTaskFields(id, before); },
  });
  return true;
}
