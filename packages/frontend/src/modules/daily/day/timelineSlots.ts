// Where on the timeline a tap, a drop or a drawn stretch lands, as the clock
// times a task line starts and ends with (taskTime: `14:00–14:30`). Pure: the
// timeline gives it minutes (from its foldLayout) and the day's window (dayWindow, so a day
// that starts at 04:00 or crosses a daylight-saving change still lines up).

import type { DayWindow } from "@onden/markdown";
import { clockLabel } from "../../../lib/dayWindow";

/** Times are put on this grid. */
export const SNAP_MINUTES = 15;
/** A slot made by a tap or a drop is this long. */
export const DEFAULT_SLOT_MINUTES = 30;

/** A task's time on the line: `until` is null when it has no end. */
export type TimeSlot = { time: string; until: string | null };

/** A slot with the offsets it was made from (minutes after the window's start), for drawing it. */
export type PlacedSlot = TimeSlot & { startMinutes: number; endMinutes: number };

export const windowMinutes = (window: DayWindow) => Math.round((window.endMs - window.startMs) / 60_000);
const clockAt = (window: DayWindow, minutes: number) => clockLabel(new Date(window.startMs + minutes * 60_000).toISOString());

/** `minutes` on the grid, kept inside the day so that a slot of one grid step still fits. */
export function snapStart(window: DayWindow, minutes: number): number {
  const latest = Math.floor((windowMinutes(window) - SNAP_MINUTES) / SNAP_MINUTES) * SNAP_MINUTES;
  return Math.min(latest, Math.max(0, Math.round((Number.isFinite(minutes) ? minutes : 0) / SNAP_MINUTES) * SNAP_MINUTES));
}

/** The slot from `start` to `end` (minutes after the window's start, on the grid).
 *  The end is dropped when it would not be later than the start on the clock
 *  (the day runs past midnight: a line's times cannot cross it). */
export function slotBetween(window: DayWindow, start: number, end: number): PlacedSlot {
  const length = windowMinutes(window);
  const endMinutes = Math.min(length, Math.max(start + SNAP_MINUTES, end));
  const time = clockAt(window, start);
  const until = clockAt(window, endMinutes);
  // "24:00" cannot be written: the last stretch of a day that ends at midnight has no end time.
  return { time, until: until > time ? until : null, startMinutes: start, endMinutes };
}

/** A tap or a drop at `minutes`: starts there (on the grid), lasts the default. */
export function slotAt(window: DayWindow, minutes: number): PlacedSlot {
  const start = snapStart(window, minutes);
  return slotBetween(window, start, start + DEFAULT_SLOT_MINUTES);
}

/** A stretch drawn from one point to another (either way round). Drawn over less than a
 *  grid step it is a tap. */
export function slotDrawn(window: DayWindow, from: number, to: number): PlacedSlot {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  if (high - low < SNAP_MINUTES) return slotAt(window, low);
  const start = snapStart(window, Math.floor(low / SNAP_MINUTES) * SNAP_MINUTES);
  return slotBetween(window, start, Math.ceil(high / SNAP_MINUTES) * SNAP_MINUTES);
}
