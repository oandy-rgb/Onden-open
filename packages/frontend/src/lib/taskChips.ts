// How a task reads in a link menu or an embedded row: when it is to be done,
// its deadline, how it repeats, which note it is a line of. Plain words, no
// ids (AGENTS.md: UI text).

import { parseRecur } from "@onden/markdown";
import type { TaskFacts } from "./taskRefs";
import { t, tn } from "./i18n";
import { todayId } from "./localDate";
import { dateLabel } from "./timeLabels";

function dayText(date: string, today: string): string {
  if (date === today) return t("Today");
  // Noon UTC: the same calendar day in any zone the label may be read in.
  return dateLabel(`${date.slice(0, 10)}T12:00:00Z`, "short", "UTC");
}

/** "Today", "Oct 5", "Evening" or "Anytime": when the task is to be done. */
export function whenText(task: TaskFacts, today: string = todayId()): string {
  if (task.when && !task.someday) return task.evening && task.when.slice(0, 10) === today ? t("This evening") : dayText(task.when, today);
  return t("Anytime");
}

function recurText(recur: string): string | null {
  const rule = parseRecur(recur);
  if (!rule) return null;
  const { n } = rule;
  if (rule.unit === "d") return tn("Every day", "Every {n} days", n);
  if (rule.unit === "w") return tn("Every week", "Every {n} weeks", n);
  return tn("Every month", "Every {n} months", n);
}

/** The chips of an embedded row: when, deadline, repeat. Empty strings never appear. */
export function taskChips(task: TaskFacts, today: string = todayId()): string[] {
  const chips: string[] = [];
  if (!task.done) chips.push(whenText(task, today));
  if (task.deadline) chips.push(t("Due {date}", { date: dayText(task.deadline, today) }));
  const repeat = task.recur ? recurText(task.recur) : null;
  if (repeat) chips.push(repeat);
  return chips;
}

/** The small print under a task in the `[[` menu, enough to tell same-named tasks apart. */
export function taskHint(task: TaskFacts, today: string = todayId()): string {
  const parts = [task.done ? t("Done") : whenText(task, today)];
  if (task.hostTitle) parts.push(t("In “{note}”", { note: task.hostTitle }));
  return parts.join(" · ");
}
