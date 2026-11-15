// Quick-add task: how a reading of the typed text is shown.
//
// Opening is openQuickAddTask.ts. The chips and the "added to …" sentence are derived here from
// parseTaskInput's result so the component only renders them.

import type { Daypart, ParsedTask, TaskSpanKind } from "@onden/markdown/task-parse";
import { t, tn } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import { formatLineTime, parseRecur, reminderMoment, weekdayOf } from "@onden/markdown";
import { addDays } from "../../lib/localDate";
import { workspaceDayStartHour } from "../../lib/localDate";
import type { QuickTaskFields } from "./createQuickTask";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Today", "Tomorrow", or "10/30 (Fri)" for a YYYY-MM-DD, seen from `today`. */
export function dayLabel(date: string, today: string): string {
  if (date === today) return t("Today");
  if (date === addDays(today, 1)) return t("Tomorrow");
  if (date === addDays(today, 2)) return t("The day after tomorrow");
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  const weekday = t(WEEKDAYS[weekdayOf(date)]!);
  return t("{month}/{day} ({weekday})", { month: m, day: d, weekday });
}

/** The repeat token as a phrase: "1d" → Every day, "2w" → Every 2 weeks. */
export function recurLabel(recur: string): string {
  const rule = parseRecur(recur);
  if (!rule) return recur;
  const { n } = rule;
  if (rule.unit === "d") return tn("Every day", "Every {n} days", n);
  if (rule.unit === "w") return tn("Every week", "Every {n} weeks", n);
  if (n % 12 === 0) return n === 12 ? t("Every year") : t("Every {n} years", { n: n / 12 });
  return tn("Every month", "Every {n} months", n);
}

const DAYPART_LABEL: Record<Daypart, () => string> = {
  morning: () => t("Morning"), noon: () => t("Noon"), afternoon: () => t("Afternoon"), evening: () => t("Evening"),
};

/** "30 min", "1 hr", "1 hr 30 min". */
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return t("{n} min", { n: rest });
  return rest === 0 ? t("{n} hr", { n: hours }) : t("{h} hr {m} min", { h: hours, m: rest });
}

/** One thing the parser understood, shown as a chip the person can take back. */
export type ReadingChip = {
  key: string;
  label: string;
  /** What to ignore to take it back; null for an implied default that has no words. */
  ignore: { kind: TaskSpanKind; text: string } | null;
};

export function readingChips(parsed: ParsedTask, text: string, today: string, { inSlot = false }: { inSlot?: boolean } = {}): ReadingChip[] {
  const chips: ReadingChip[] = [];
  const spanText = (s: { start: number; end: number }) => text.slice(s.start, s.end);
  const hasDaySpan = parsed.spans.some((s) => s.kind === "date" || s.kind === "evening" || s.kind === "time");
  if (parsed.when_date && !hasDaySpan) {
    chips.push({ key: "implied-day", label: dayLabel(parsed.when_date, today), ignore: null });
  }
  for (const s of parsed.spans) {
    const piece = spanText(s);
    const ignore = { kind: s.kind, text: piece };
    const key = `${s.kind}:${s.start}`;
    switch (s.kind) {
      case "date":
        chips.push({ key, ignore, label: parsed.when_date ? dayLabel(parsed.when_date, today) : piece });
        break;
      case "evening":
        chips.push({ key, ignore, label: t("{day} evening", { day: parsed.when_date ? dayLabel(parsed.when_date, today) : "" }).trim() });
        break;
      case "time":
        chips.push({ key, ignore, label: timeChip(parsed, piece, today) });
        break;
      case "deadline":
        chips.push({ key, ignore, label: t("Due {day}", { day: parsed.deadline ? dayLabel(parsed.deadline, today) : piece }) });
        break;
      case "recur":
        chips.push({ key, ignore, label: parsed.recur ? recurLabel(parsed.recur) : piece });
        break;
      case "recur_mode":
        chips.push({ key, ignore, label: t("Repeat after it is done") });
        break;
      case "remind":
        chips.push({ key, ignore, label: t("Remind me") });
        break;
      case "someday":
        chips.push({ key, ignore, label: t("Someday") });
        break;
      case "anytime":
        chips.push({ key, ignore, label: t("Anytime") });
        break;
      case "daypart":
        chips.push({ key, ignore, label: parsed.daypart ? DAYPART_LABEL[parsed.daypart]() : piece });
        break;
      case "duration":
        // A length with no clock time to start from has nowhere to be kept, except in a timeline slot.
        chips.push({ key, ignore, label: !parsed.duration ? piece : parsed.time || inSlot ? durationLabel(parsed.duration) : t("{length} · no start time, not kept", { length: durationLabel(parsed.duration) }) });
        break;
      case "tag":
        chips.push({ key, ignore, label: piece });
        break;
    }
  }
  if (parsed.anytime && !parsed.spans.some((s) => s.kind === "anytime")) {
    chips.push({ key: "anytime-default", label: t("Anytime"), ignore: null });
  }
  return chips;
}

function timeChip(parsed: ParsedTask, piece: string, today: string): string {
  if (!parsed.time) return piece;
  const clock = formatLineTime(parsed.time, parsed.until);
  return parsed.when_date && !parsed.spans.some((o) => o.kind === "date") ? `${dayLabel(parsed.when_date, today)} ${clock}` : clock;
}

/** Where the new task shows up, for the "Added to …" line under the box. */
export function placementLabel(parsed: ParsedTask, today: string, noteTitle?: string): string {
  const list = listLabel(parsed, today);
  return noteTitle === undefined ? list : t("{list} · written in {note}", { list, note: displayTitle(noteTitle) });
}

function listLabel(parsed: ParsedTask, today: string): string {
  if (parsed.someday) return t("Someday list");
  if (!parsed.when_date) return t("Anytime list");
  // Today and anything already due sit on the Today tab, later days on Up next.
  if (parsed.when_date.slice(0, 10) <= today) return parsed.evening ? t("Today list · tonight") : t("Today list");
  const day = dayLabel(parsed.when_date, today);
  return t("Up next · {day}", { day: parsed.evening ? t("{day} evening", { day }) : day });
}

/** Minutes → "HH:MM" after `time`, or null when that would pass midnight (a line's times cannot cross it). */
export function clockPlus(time: string, minutes: number): string | null {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const end = h * 60 + m + minutes;
  return end > 0 && end < 24 * 60 ? `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}` : null;
}

/** A timeline slot the task starts with; the typed words may replace parts of it. */
export type SlotStart = { date: string; time: string; until: string | null };

/** What the day and time of a task made in a timeline slot are: the slot's, except where the typed
 *  words say otherwise — a day ("明天") replaces the slot's day, a time ("3點到5點") replaces its
 *  time and end, and a length alone ("30分鐘") replaces the end. */
export function slotWithReading(parsed: ParsedTask, slot: SlotStart): SlotStart {
  const date = parsed.when_stated ? parsed.when_date ?? slot.date : slot.date;
  if (parsed.time) return { date, time: parsed.time, until: parsed.until };
  return { date, time: slot.time, until: parsed.duration ? clockPlus(slot.time, parsed.duration) : slot.until };
}

/** `@name` in the typed text: the note to write the task into, and the text
 *  without it. A name has no spaces (the token ends at the next space). An
 *  `@` inside a word (an email address) is not one. */
export function readMention(text: string): { name: string; rest: string } | null {
  const found = /(^|\s)@([^\s@]+)/.exec(text);
  if (!found) return null;
  const before = text.slice(0, found.index).trimEnd();
  const after = text.slice(found.index + found[0].length).trimStart();
  return { name: found[2]!, rest: before && after ? `${before} ${after}` : `${before}${after}` };
}

/** The wall-clock moment (YYYY-MM-DDTHH:MM, the workspace's zone) a reminder fires: the task's time, else a default
 *  for the day part. Written like every other reminder, so it moves with the task (reminderAfterMove); the calendar
 *  day of a time before the day's start hour is the next one (reminderMoment). */
function remindAt(date: string, time: string | null, evening: boolean): string | null {
  return reminderMoment({ due_date: date, time: time ?? (evening ? "20:00" : "09:00") }, workspaceDayStartHour())?.text ?? null;
}

/** What quick-add and quick capture save for a reading of the typed text
 *  (parseTaskInput): one mapping, so the two make the same task from the same words. */
export function quickTaskFromReading(parsed: ParsedTask, note: QuickTaskFields["note"] = null): QuickTaskFields {
  return {
    title: parsed.title,
    when_date: parsed.when_date,
    time: parsed.time,
    until: parsed.until,
    evening: parsed.evening,
    someday: parsed.someday,
    deadline: parsed.deadline,
    recur: parsed.recur,
    recur_mode: parsed.recur_mode,
    remind_at: parsed.remind && parsed.when_date ? remindAt(parsed.when_date, parsed.time, parsed.evening) : null,
    note,
  };
}

/** The fields of a task made in a timeline slot: the reading, placed at `slotWithReading`'s day and time. */
export function quickTaskInSlot(parsed: ParsedTask, slot: SlotStart, note: QuickTaskFields["note"] = null): QuickTaskFields {
  const placed = slotWithReading(parsed, slot);
  const timed: ParsedTask = { ...parsed, when_date: placed.date, time: placed.time, until: placed.until, evening: false, someday: false, anytime: false };
  return quickTaskFromReading(timed, note);
}

/** Where the pieces that were not understood sit in the title (half-open ranges, sorted), for marking them. */
export function doubtfulRanges(title: string, doubtful: ReadonlyArray<{ text: string }>): Array<[number, number]> {
  const marks: Array<[number, number]> = [];
  for (const { text } of doubtful) {
    const at = title.indexOf(text);
    if (at >= 0 && !marks.some(([s, e]) => at < e && at + text.length > s)) marks.push([at, at + text.length]);
  }
  return marks.sort((a, b) => a[0] - b[0]);
}
