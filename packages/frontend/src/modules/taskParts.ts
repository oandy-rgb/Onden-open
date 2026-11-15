// What other modules borrow from tasks: writing one task (quick capture, the journal) and the day's task list
// (the journal). Modules do not import each other, they meet in modules/*.ts. Kept out of modules/index on
// purpose: that file is also loaded as a whole by lib/offlineWarmup, which would keep the task screens in the
// boot JS for every re-export added there.
export { createQuickTask, quickTaskFromReading, QuickAddPanel, JournalTasksRow } from "./tasks";

// The 今天 page's parts of the Tasks page: the board hook (the list and what a row's buttons do), the row, the
// settings sheet, the agenda, the focus bar and the quick-add opener.
export { useTaskBoard, UpcomingAgenda, TAB_EMPTY, TAB_LABEL, TaskSection, agendaTasksOf, FocusPageBar, TaskRow, TaskSheet, openQuickAddTask } from "./tasks";
export type { TaskBoard } from "./tasks";
