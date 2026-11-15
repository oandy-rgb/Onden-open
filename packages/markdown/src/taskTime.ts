// The clock time written at the start of a task line (docs/architecture/day-timeline.md):
//
//   - [ ] 15:00–16:00 跟組員討論 {task}     start 15:00, until 16:00
//   - [ ] 15:00 交報告 {task}               start only
//
// The line's text is the source of truth; the task's `_task_time` / `_task_until`
// attributes follow it, and a time changed elsewhere is written back to the line.
// Pure, like taskParse: the clock pattern below is the one quick-add reads too.

/** One 24-hour clock time as a regular-expression source: hour (1–2 digits) and minute. */
export const CLOCK_24H_SOURCE = "(2[0-3]|[01]?\\d):([0-5]\\d)";

const pad = (n: number): string => String(n).padStart(2, "0");

/** `HH:MM` exactly (24-hour, zero-padded): the stored form of a task's time. */
export const isClockTime = (value: unknown): value is string =>
  typeof value === "string" && /^(2[0-3]|[01]\d):[0-5]\d$/.test(value);

const LEADING = new RegExp(
  `^([ \\t]*)${CLOCK_24H_SOURCE}(?![\\d:])(?:[ \\t]*[–—-][ \\t]*${CLOCK_24H_SOURCE}(?![\\d:]))?(?:[ \\t]+|$)`,
);

export type LineTime = {
  /** HH:MM, or null when the text starts with no time. */
  time: string | null;
  /** HH:MM later than `time`, or null. */
  until: string | null;
  /** The text after the time (all of it when there is none). */
  rest: string;
};

/** The time a task line's text starts with, and the text after it. An end that
 *  is not later than the start is not an end: it stays in `rest`. */
export function parseLineTime(text: string): LineTime {
  const m = LEADING.exec(text);
  if (!m) return { time: null, until: null, rest: text };
  const time = `${pad(Number(m[2]))}:${m[3]}`;
  const end = m[4] === undefined ? null : `${pad(Number(m[4]))}:${m[5]}`;
  if (end !== null && end <= time) {
    // "15:00–14:00": only the start is a time; keep the dash and the rest.
    const startOnly = new RegExp(`^([ \\t]*)${CLOCK_24H_SOURCE}(?![\\d:])`).exec(text)!;
    return { time, until: null, rest: text.slice(startOnly[0].length).replace(/^[ \t]+/, "") };
  }
  return { time, until: end, rest: text.slice(m[0].length) };
}

/** `15:00–16:00`, or `15:00` without an end. */
export const formatLineTime = (time: string, until: string | null): string => until ? `${time}–${until}` : time;

/** `text` (a task line's text after its box) with its leading time replaced:
 *  by `time`/`until`, or removed when `time` is null. */
export function withLineTime(text: string, time: string | null, until: string | null): string {
  const rest = parseLineTime(text).rest;
  return time === null ? rest : rest === "" ? formatLineTime(time, until) : `${formatLineTime(time, until)} ${rest}`;
}
