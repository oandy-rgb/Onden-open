import { TASK_ATTR } from "@onden/markdown/contract";

// Display names for the built-in columns a view can list (the ids are what
// the view stores). Any other field is the user's own: its name is its label.
const BUILT_IN_FIELD_LABELS: Record<string, string> = {
  title: "Title", slug: "Slug", updated_at: "Updated at", created_at: "Created at", sort_order: "Manual order",
  // The same columns as an imported Obsidian base names them.
  "file.name": "Title", "file.ctime": "Created at", "file.mtime": "Updated at",
  // A task's own properties (a sync conflict names the one that clashed).
  [TASK_ATTR.status]: "Status", [TASK_ATTR.when]: "Planned day", [TASK_ATTR.evening]: "Evening", [TASK_ATTR.someday]: "Someday",
  [TASK_ATTR.deadline]: "Deadline", [TASK_ATTR.recur]: "Repeat", [TASK_ATTR.recurMode]: "How it repeats",
  [TASK_ATTR.remindAt]: "Reminder", [TASK_ATTR.time]: "Time", [TASK_ATTR.until]: "Ends at", [TASK_ATTR.doneAt]: "Finished at",
};

/** The text a column header or card badge shows for `field`. `t` is the
 *  caller's translate function. */
export function fieldDisplayName(field: string, t: (source: string) => string): string {
  const source = BUILT_IN_FIELD_LABELS[field];
  return source ? t(source) : field;
}
