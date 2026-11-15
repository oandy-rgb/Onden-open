// 3 天／週: moving a planned task's card to another day. Apart from dayTaskWrites (which the first screen
// imports) because only the week board needs it.

import { addToast, getAppState } from "../../../lib/appStore";
import { t } from "../../../lib/i18n";
import { dayIdLabel } from "../../../lib/timeLabels";
import { writeTaskFields } from "./dayTaskWrites";

/** Moves a planned task to another day (3 天／週): the time of day stays, only the date changes. The line
 *  stays in whatever note it is in. Tells it with a 「復原」 that puts the old day back; false when the task is
 *  done, gone, already there, or the write was refused. */
export async function moveTaskToDay(id: string, date: string): Promise<boolean> {
  const task = getAppState().data.tasks.find((row) => row.id === id);
  if (!task || task.status === "done" || (task.when_date === date && !task.someday)) return false;
  const before = { when_date: task.when_date ?? null, someday: task.someday ? true : null };
  if (!(await writeTaskFields(id, { when_date: date, someday: null }))) return false;
  addToast(t("Moved to {date}", { date: dayIdLabel(date, "medium") }), "success", { label: t("Undo"), onClick: () => { void writeTaskFields(id, before); } });
  return true;
}
