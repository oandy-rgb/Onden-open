// Daily-journal delighters — mood capture + streak tracking. Pure logic so it
// is unit-testable and host-agnostic. Reuses the existing day-node convention
// (lib/dayNode) and stores mood as an ordinary node_attribute (no schema
// migration) so the inspector, Bases evaluator and collections all see it for
// free. The "don't break the chain" streak is COMPUTED from which calendar days
// already have a (non-hidden) day node — there is nothing to persist.

import { dayNoteDate } from "@onden/markdown";
import { addDays, todayId } from "./localDate";

/** The mood scale stored under the `mood` attribute key. Plain emoji values so
 *  they read as ordinary metadata (per surface-no-programmer-ui) and survive a
 *  round-trip through node_attributes as a text value. Ordered worst→best so a
 *  scale can render left→right. */
export const MOODS = [
  { value: "😖", label: "Rough" },
  { value: "😕", label: "Low" },
  { value: "😐", label: "Okay" },
  { value: "🙂", label: "Good" },
  { value: "😄", label: "Great" },
] as const;

export type MoodValue = (typeof MOODS)[number]["value"];

/** The node_attribute key a day note's mood is stored under. One stable key so
 *  collections / the inspector can filter and group by it. */
export const MOOD_ATTR_KEY = "mood";

/** True iff `value` is one of the known mood emojis (defends the attribute set
 *  against arbitrary input and lets the UI highlight the active choice). */
export function isMoodValue(value: string | null | undefined): value is MoodValue {
  return !!value && MOODS.some((m) => m.value === value);
}

type DayLike = { title?: string; slug?: string; hidden?: boolean };

/** Add `days` calendar days to a YYYY-MM-DD id (pure calendar arithmetic;
 *  lib/localDate.addDays). Building a browser-local Date and formatting it in
 *  the workspace zone skipped days when the two zones differ. */
export const shiftDateId = addDays;

/** "Don't break the chain": the count of CONSECUTIVE day notes ending today (or
 *  yesterday). Counting back from today, each day that has a day node extends
 *  the streak; the first gap ends it. A streak that ran up to *yesterday* is
 *  still alive (today isn't over) — so we anchor on today when today has a note,
 *  else on yesterday, else the streak is 0.
 *
 *  Pure: pass `nodes` (the bootstrap snapshot) and an injectable `now`. */
export function computeDayStreak(
  nodes: DayLike[],
  now: Date = new Date(),
): number {
  // Set of ISO dates that have a (non-hidden) day node. dayNoteDate already
  // rejects hidden nodes and non-calendar date-shaped titles.
  const present = new Set<string>();
  for (const n of nodes) {
    const date = dayNoteDate(n);
    if (date) present.add(date);
  }
  if (present.size === 0) return 0;

  const today = todayId(now);
  const yesterday = shiftDateId(today, -1);
  // Anchor: today if it has a note, else yesterday (the chain survives the gap
  // of "today not yet written"), else broken.
  let cursor: string;
  if (present.has(today)) cursor = today;
  else if (present.has(yesterday)) cursor = yesterday;
  else return 0;

  let streak = 0;
  while (present.has(cursor)) {
    streak += 1;
    cursor = shiftDateId(cursor, -1);
  }
  return streak;
}
