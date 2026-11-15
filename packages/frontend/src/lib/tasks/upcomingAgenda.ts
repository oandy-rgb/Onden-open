// The 接下來 tab as an agenda: one entry per day for the next two weeks, the days with nothing
// folded into one grey line, and what is planned further off in one 「之後」 list. Pure; `today`
// is the workspace's, never the device's.

import { addDays, daysBetween } from "../localDate";
import type { TaskItem } from "./taskModel";

/** Days listed one by one, today first; a task planned after these is 「之後」. */
export const AGENDA_DAYS = 14;

export type AgendaSegment =
  | { kind: "day"; date: string; items: TaskItem[] }
  /** Days in a row with nothing planned (one day: from = to). */
  | { kind: "quiet"; from: string; to: string }
  /** Planned after the last listed day, by date. */
  | { kind: "later"; items: TaskItem[] };

const byTime = (a: TaskItem, b: TaskItem) => (a.time === b.time ? 0 : a.time === null ? 1 : b.time === null ? -1 : a.time < b.time ? -1 : 1);

/** `tasks` are the open ones planned for today or later; others are ignored. */
export function upcomingAgenda(tasks: readonly TaskItem[], today: string): AgendaSegment[] {
  const planned = tasks.filter((task) => task.whenDate !== null && daysBetween(today, task.whenDate) >= 0);
  if (planned.length === 0) return [];
  const lastListed = addDays(today, AGENDA_DAYS - 1);
  const segments: AgendaSegment[] = [];
  for (let i = 0; i < AGENDA_DAYS; i += 1) {
    const date = addDays(today, i);
    const items = planned.filter((task) => task.whenDate === date).sort(byTime);
    const last = segments[segments.length - 1];
    if (items.length > 0) segments.push({ kind: "day", date, items });
    else if (last?.kind === "quiet") last.to = date;
    else segments.push({ kind: "quiet", from: date, to: date });
  }
  const later = planned.filter((task) => daysBetween(lastListed, task.whenDate!) > 0).sort((a, b) => (a.whenDate! < b.whenDate! ? -1 : a.whenDate! > b.whenDate! ? 1 : byTime(a, b)));
  if (later.length > 0) segments.push({ kind: "later", items: later });
  return segments;
}

/** The days the week row at the top shows: today and the six after it. */
export const agendaWeek = (today: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(today, i));
