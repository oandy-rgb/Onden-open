// A date typed or written by a person → the calendar day it names. The one
// reading of "which day does this text mean" for a whole piece of text: the
// date picker's text box, an imported cell, anything that holds a single date.
// Three grammars meet here and nowhere else:
//
//   * a written absolute date ("2026-10-16", "Oct 16, 2026", "10/16/2026"),
//     attributeValue.toCalendarDate — how imports already read other apps' dates;
//   * everything a sentence can say about a day ("明天", "下週三", "11/3",
//     "in 3 days", "每週五"), taskParse.parseTaskInput — the quick-add grammar,
//     which the capture box and the task sheet also run on whole sentences;
//   * `today`, the workspace's day (frontend lib/localDate todayId, backend
//     localDay.localDayId). Nothing here reads the device clock.
//
// Where the two readers could disagree ("10/16" written without a year is
// month/day in both; a full "2026/10/14" is the same day in both) the written
// absolute date is tried first, so a date with a year never depends on today.
// The quick-add grammar is the only one that knows relative and weekday words.

import { toCalendarDate } from "./attributeValue.js";
import { parseTaskInput } from "./taskParse.js";

export type ParsedDate = {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24-hour, when the text named a clock time too. */
  time: string | null;
  /** `<n><d|w|m>` when the text said "every …". */
  recur: string | null;
};

export type DateParseOptions = {
  /** The workspace's day, YYYY-MM-DD: what "tomorrow" is counted from. */
  today: string;
  /** "zh…" keeps bare English weekday abbreviations ("mon") from being read as days. */
  locale?: string;
};

/** The day `text` names as a whole, or null when it is not only a date: a
 *  sentence with a title left over ("明天 交報告") is parseTaskInput's, not a date. */
export function parseDateText(text: string, { today, locale }: DateParseOptions): ParsedDate | null {
  const t = text.trim();
  if (!t) return null;
  const written = toCalendarDate(t);
  if (written) return { date: written, time: null, recur: null };
  const parsed = parseTaskInput(t, { today, locale });
  if (parsed.title !== "") return null;
  const named = parsed.spans.some((s) => s.kind === "date" || s.kind === "evening" || s.kind === "deadline" || s.kind === "recur");
  const date = parsed.when_date ?? parsed.deadline;
  return named && date ? { date, time: parsed.time, recur: parsed.recur } : null;
}
