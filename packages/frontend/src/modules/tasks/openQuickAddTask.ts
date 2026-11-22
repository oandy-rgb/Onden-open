// Opening the quick-add task sheet goes through a window event, like quick capture
// (onden-open-quick-capture): the palette, the tasks page and shortcuts only call
// openQuickAddTask(). Kept apart from the sheet so callers do not pull its code in.

import { emitWindowEvent } from "../../lib/globalEvents";

export const OPEN_QUICK_ADD_TASK_EVENT = "onden-open-quick-add-task";

/** The note a task typed in the sheet goes into when no `@note` names another. */
export type QuickAddTarget = { id: string; title: string; spaceId?: string | null };

/** Open the quick-add task sheet (focused, ready to type). `into`: the note the
 *  tasks are written into (the info panel's 「＋ 任務」); left out, today's diary. */
export function openQuickAddTask(into?: QuickAddTarget): void {
  emitWindowEvent(OPEN_QUICK_ADD_TASK_EVENT, { into: into ?? null });
}
