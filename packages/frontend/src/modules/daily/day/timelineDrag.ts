// Moving a planned block and stretching its lower edge, as the slot the task line
// would carry afterwards. Pure, built on timelineSlots (the same 15-minute grid,
// the same day window — a day starting at 04:00 or a daylight-saving day still
// lines up — and the same rule that a line's times cannot cross midnight).
// Nothing is written here: the pointer and the keyboard only ever ask "what would
// this be", draw it, and the caller writes once when the gesture is done.

import type { DayItem, DayWindow } from "@onden/markdown";
import { SNAP_MINUTES, slotBetween, snapStart, windowMinutes, type PlacedSlot } from "./timelineSlots";

/** Where a block sits, in minutes after the window's start. `endMinutes` null: the task has no end time. */
export type BlockSpan = { startMinutes: number; endMinutes: number | null };

/** The block of a timed task item, or null when it cannot be moved on this day's timeline
 *  (no time, starts before the day or runs past its end, so the line's times would not describe it). */
export function itemSpan(window: DayWindow, item: Pick<DayItem, "at" | "until">): BlockSpan | null {
  if (!item.at) return null;
  const length = windowMinutes(window);
  const start = Math.round((Date.parse(item.at) - window.startMs) / 60_000);
  if (!(start >= 0 && start < length)) return null;
  if (!item.until) return { startMinutes: start, endMinutes: null };
  const end = Math.round((Date.parse(item.until) - window.startMs) / 60_000);
  if (end > length) return null;
  return { startMinutes: start, endMinutes: end > start ? end : null };
}

/** A slot read back as a block, so a second step (a key pressed again) builds on the first. */
export const slotSpan = (slot: PlacedSlot): BlockSpan => ({ startMinutes: slot.startMinutes, endMinutes: slot.until ? slot.endMinutes : null });

/** Slot from `start`, with `end` pulled back a step at a time while the clock would wrap past midnight. */
function withinTheDay(window: DayWindow, start: number, end: number, keepEnd: boolean): PlacedSlot {
  let slot = slotBetween(window, start, end);
  while (keepEnd && slot.until === null && slot.endMinutes - slot.startMinutes > SNAP_MINUTES) {
    slot = slotBetween(window, start, slot.endMinutes - SNAP_MINUTES);
  }
  return slot;
}

/** The block moved by `deltaMinutes`: starts on the grid, keeps its length, stays inside the day.
 *  A block with an end is stopped at midnight rather than losing its end. Null: nothing changes. */
export function moveSpan(window: DayWindow, span: BlockSpan, deltaMinutes: number): PlacedSlot | null {
  const keepEnd = span.endMinutes !== null;
  const duration = keepEnd ? Math.max(span.endMinutes! - span.startMinutes, SNAP_MINUTES) : SNAP_MINUTES;
  const latest = Math.floor((windowMinutes(window) - duration) / SNAP_MINUTES) * SNAP_MINUTES;
  let start = Math.min(latest, snapStart(window, span.startMinutes + deltaMinutes));
  let slot = slotBetween(window, start, start + duration);
  // Its end would wrap past midnight: slide the block earlier instead of cutting its length.
  while (keepEnd && slot.until === null && start > 0) {
    start -= SNAP_MINUTES;
    slot = slotBetween(window, start, start + duration);
  }
  if (slot.startMinutes === span.startMinutes) return null;
  return keepEnd ? slot : { ...slot, until: null, endMinutes: slot.startMinutes + SNAP_MINUTES };
}

/** The lower edge moved by `deltaMinutes`: the end lands on the grid, at least one step after the
 *  start, at most the end of the day. A task with no end gets one. The start never moves.
 *  Null: nothing changes (or no end can be written there). */
export function resizeSpan(window: DayWindow, span: BlockSpan, deltaMinutes: number): PlacedSlot | null {
  const base = span.endMinutes ?? span.startMinutes;
  const end = Math.round((base + deltaMinutes) / SNAP_MINUTES) * SNAP_MINUTES;
  if (span.endMinutes === null && end <= span.startMinutes) return null;
  const slot = withinTheDay(window, span.startMinutes, end, true);
  if (slot.until === null) return null; // e.g. a block starting at 23:45: no later end fits before midnight
  if (slot.endMinutes === span.endMinutes) return null;
  return slot;
}
