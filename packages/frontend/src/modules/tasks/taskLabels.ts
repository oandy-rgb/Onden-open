// Words for the task page's dates and rules. Pure, given the translator.

import { parseRecur, weekdayOf } from "@onden/markdown";
import { daysBetween } from "../../lib/localDate";
import { describeDay, type DayDescription, type LeftOverAge, type TaskItem } from "../../lib/tasks";

export type TFn = (text: string, vars?: Record<string, string | number>) => string;

const WEEKDAYS = ["Sun.", "Mon.", "Tue.", "Wed.", "Thu.", "Fri.", "Sat."] as const;

/** 今天 / 明天 / 週一 10/27. */
export function dayLabel(day: DayDescription, t: TFn): string {
  if (day.kind === "today") return t("Today");
  if (day.kind === "tomorrow") return t("Tomorrow");
  return t("{weekday} {month}/{day}", { weekday: t(WEEKDAYS[day.weekday]!), month: day.month, day: day.day });
}

/** 週三 11/11: a day by its weekday and date, whatever day today is. */
export function plainDayLabel(date: string, t: TFn): string {
  const [, month, day] = date.split("-").map(Number);
  return t("{weekday} {month}/{day}", { weekday: t(WEEKDAYS[weekdayOf(date)]!), month, day });
}

/** 今天 11/9 週一 / 明天 11/10 週二 / 週三 11/11: a heading of the agenda. */
export function agendaDayTitle(date: string, today: string, t: TFn): string {
  const diff = daysBetween(today, date);
  if (diff !== 0 && diff !== 1) return plainDayLabel(date, t);
  const [, month, day] = date.split("-").map(Number);
  return t(diff === 0 ? "Today {month}/{day} {weekday}" : "Tomorrow {month}/{day} {weekday}", { month, day, weekday: t(WEEKDAYS[weekdayOf(date)]!) });
}

/** 週五截止 / 明天截止 / 今天截止. A deadline already past reads as a plain
 *  date ("10/20 截止"): a deadline is not called overdue; a past when-date is
 *  (TaskRow's 逾期 chip). */
export function deadlineLabel(deadline: string, today: string, t: TFn): string {
  if (daysBetween(today, deadline) < 0) {
    const [, month, day] = deadline.split("-").map(Number);
    return t("Due {date}", { date: `${month}/${day}` });
  }
  const day = describeDay(deadline, today);
  if (day.kind === "date") return t("Due {date}", { date: t(WEEKDAYS[day.weekday]!) });
  return t("Due {date}", { date: dayLabel(day, t) });
}

/** "每週", "每 3 天" from a `<n><d|w|m>` token. */
export function recurRuleText(recur: string, t: TFn): string {
  const rule = parseRecur(recur);
  if (!rule) return recur;
  const { n } = rule;
  const unit = rule.unit === "d" ? t("day") : rule.unit === "w" ? t("week") : t("month");
  return n === 1 ? t("every {unit}", { unit }) : t("every {n} {unit}", { n, unit });
}

/** The chip on a repeating task: 每週（完成後起算）. */
export function recurChipText(task: Pick<TaskItem, "recur" | "recurMode">, t: TFn): string {
  const rule = recurRuleText(task.recur!, t);
  return task.recurMode === "after" ? t("{rule} (from completion)", { rule }) : rule;
}

/** 昨天留下的 / 週一留下的 / 9 天前留下的: which day a late task was left over from. */
export function leftOverLabel(age: LeftOverAge, t: TFn): string {
  if (age.kind === "yesterday") return t("Left over from yesterday");
  if (age.kind === "weekday") return t("Left over from {weekday}", { weekday: t(WEEKDAYS[age.weekday]!) });
  return t("Left over from {n} days ago", { n: age.n });
}
