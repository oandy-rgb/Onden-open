// What other modules borrow from tasks: writing one task (quick capture, the journal) and the day's task list
// (the journal). Modules do not import each other, they meet in modules/*.ts. Kept out of modules/index on
// purpose: that file is also loaded as a whole by lib/offlineWarmup, which would keep the task screens in the
// boot JS for every re-export added there.
export { createQuickTask, quickTaskFromReading, QuickAddPanel } from "./tasks";
