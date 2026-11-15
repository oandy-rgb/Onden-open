// M3.3 — Calendar layout helpers (pure, unit-testable).
//
// Given the executed query rows, pick a date field and bucket rows by calendar
// day (the grid itself is @onden/markdown's buildMonthGrid). Kept free of React so the
// date math can be unit-tested in isolation from rendering.

import { calendarDayOf } from "@onden/markdown";
import { workspaceTimeZone } from "../../lib/localDate";
import type { ExecRow } from "@onden/contract";

/** The field a calendar view places its rows by: the `date_field` the view declares (the calendar's one setting,
 *  asked for when the view is added, and filled in for older views by migration 188); a view without one uses the
 *  built-in last-edited date. A field's name is never guessed at. */
export function calendarDateField(configured?: unknown): string {
  return typeof configured === "string" && configured ? configured : "updated_at";
}

/** Read the raw date string for a row + field, covering built-ins. */
export function rowDateValue(row: ExecRow, field: string): string | null {
  if (field === "updated_at") return row.updated_at;
  if (field === "created_at") return row.created_at;
  return row.attributes[field] ?? null;
}

/** Bucket rows into a Map keyed by the calendar day (YYYY-MM-DD) their date
 *  field falls on, read by calendarDayOf: a date or wall-clock time names its
 *  own day, a zoned instant lands on its day in `timeZone` (the workspace's).
 *  Rows with no such day (empty, "10", "Draft 2") are left out, so the
 *  caller counts them as undated. */
export function bucketRowsByDay(
  rows: ExecRow[],
  field: string,
  timeZone: string | undefined = workspaceTimeZone(),
): Map<string, ExecRow[]> {
  const buckets = new Map<string, ExecRow[]>();
  for (const row of rows) {
    const key = calendarDayOf(rowDateValue(row, field), timeZone);
    if (key === null) continue;
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }
  return buckets;
}

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// The month title is the app's time formatter's (lib/timeLabels).
export { monthLabel } from "../../lib/timeLabels";
