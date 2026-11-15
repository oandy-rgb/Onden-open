// Opening a task's settings sheet from outside the tasks pages (a task link or embed in a note
// whose task is no note's line) goes through a window event, like openQuickAddTask: callers only
// call openTaskSheet(); the host (TaskSheetHost) the shell mounts draws the same TaskSheet the
// Tasks page uses.

import { emitWindowEvent } from "../../lib/globalEvents";

export const OPEN_TASK_SHEET_EVENT = "onden-open-task-sheet";

export function openTaskSheet(taskId: string): void {
  emitWindowEvent(OPEN_TASK_SHEET_EVENT, { taskId });
}
