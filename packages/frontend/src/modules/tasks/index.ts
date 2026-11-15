// Tasks module (任務, frontend) — the module library's switch for tasks
// (docs/architecture/tasks-module.md). Its module tag is #task, which task
// nodes carry. The Tasks page lives here (TasksMode, a core mode reached
// by ?view=tasks and the sidebar places) rather than a module screen, so the
// module supplies the "tasks" shell feature (lib/shellFeatures): the nav entry,
// the palette's 「新增任務」/「前往任務」, quick-add and the journal's task
// list ask `useTasksEnabled()`, and the page itself points at the module
// library while the module is off. Turning it off keeps every task and its tag,
// and a checkbox in a note still ticks. On by default like every built-in function.

import { ListChecks } from "lucide-react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import type { FrontendModule } from "../types";
import { taskDayItems } from "../../lib/tasks";

// The Tasks page, the shared row, the settings sheet, the quick-add sheet, the
// journal's task list and their words: everything outside this directory
// reaches the task UI through here (eslint onden/module-entry).
export { default as TaskRow } from "./TaskRow";
export { default as TaskSheet } from "./TaskSheet";
export type { NoteChoice, TaskActions } from "./TaskSheet";
export { default as ReminderToggle } from "./ReminderToggle";
export { dayLabel } from "./taskLabels";
export { default as QuickAddTask } from "./QuickAddTaskHost";
/** The quick-add sheet's file, for the offline warm-up (modules/index loadOfflineModuleScreens). */
export const loadQuickAddSheet = () => import("./QuickAddSheet");
export { openQuickAddTask } from "./openQuickAddTask";
/** Opens a task's sheet from a link or embed whose task is no note's line; the shell mounts the host. */
export { default as TaskSheetHost } from "./TaskSheetHost";
export { openTaskSheet } from "./openTaskSheet";
/** The sheet's content, for the 日子 timeline's slot (given a `slot`, it plans a time too). Loaded when first drawn. */
export const QuickAddPanel = lazyWithReload(() => import("./QuickAddPanel"));
export { quickTaskFromReading } from "./quickAddTask";
export { createQuickTask } from "./createQuickTask";
export type { QuickTaskResult, QuickTaskSaved } from "./createQuickTask";
export { default as JournalTasksRow } from "./JournalTasksRow";
// For the 今天 page (reached through taskParts, so none of it is in the boot JS): the board hook, the agenda, the focus bar.
export { useTaskBoard } from "./useTaskBoard";
export type { TaskBoard } from "./useTaskBoard";
export { default as UpcomingAgenda } from "./UpcomingAgenda";
export { TAB_EMPTY, TAB_LABEL, TaskSection, agendaTasksOf } from "./taskTabs";
export { default as FocusPageBar } from "./focus/FocusPageBar";
// The focus timer: its bar, sheets and full screen (the shell mounts these two).
export { default as FocusHost, FocusTopMark } from "./focus/FocusHost";

/** The page's file, loaded on demand. One loader for the lazy component and
 *  the offline warm-up (lib/offlineWarmup), so the warmed chunk is the one used. */
export const loadTasksMode = () => import("./TasksMode");
export const TasksMode = lazyWithReload(loadTasksMode);

export const tasksModule: FrontendModule = {
  id: "tasks",
  shellFeature: "tasks",
  dayItems: taskDayItems,
  noteFunctionRows: () => import("./noteFunctionRows"),
  library: {
    title: "Tasks",
    description: "Things to do: on their own or as checkbox lines in notes, with a day to do them, a deadline, repeats and reminders.",
    Icon: ListChecks,
    group: { id: "time", order: 2 },
    blurb: "Things to do, with deadlines and reminders",
    lineWord: "task",
    paragraphAction: { id: "tasks_line", label: "Make this block a task", Icon: ListChecks },
    manifest: {
      adds: [
        { kind: "page", text: "The Tasks page, with a day to do each task, a deadline, repeats and reminders." },
        { kind: "command", text: "Checkbox lines ending in {task} in your notes become tasks." },
      ],
      notes: "Tasks you add, and the checkbox lines you mark as tasks in your notes.",
      network: null,
    },
  },
};
