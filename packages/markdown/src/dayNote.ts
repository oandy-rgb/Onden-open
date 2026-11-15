// "Is this note a day note" — the one rule. A day note is a visible note whose
// title or slug IS a real calendar day (YYYY-MM-DD); the Today button, the
// journal, the day lens and the landing note all find days by it. The backend's
// day lens leaves the day note out of its own list with the SQL spelling of the
// same rule (services/dayLens.ts NOT_THE_DAY_NODE).

import { isCalendarDay } from "./attributeValue.js";

/** The day a note stands for iff it is a day note, else null. */
export function dayNoteDate(node: { title?: string; slug?: string; hidden?: boolean } | null | undefined): string | null {
  if (!node || node.hidden) return null;
  for (const candidate of [node.title, node.slug]) {
    if (candidate && isCalendarDay(candidate)) return candidate;
  }
  return null;
}

