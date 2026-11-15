// The journal's part of a day on the 日子 page: the quick captures filed under
// that day's note, each at the minute it was written (journal.ts decides what
// counts as a capture; the day's own text is the left column, not an item).

import { plainExcerpt, type DayItem } from "@onden/markdown";
import type { DayItemsContext } from "../types";
import { dayChildren, dayNotesByDate } from "./journal";
import { personalSpaceId } from "../../lib/spaces";
import { displayTitle } from "../../lib/noteLabel";

export function captureDayItems({ date, nodes, nowMs }: DayItemsContext): DayItem[] {
  const day = dayNotesByDate(nodes, personalSpaceId()).get(date);
  if (!day) return [];
  return dayChildren(nodes, day.id).flatMap((note) => {
    const at = note.created_at ? new Date(note.created_at) : null;
    if (!at || Number.isNaN(at.getTime())) return [];
    const detail = note.markdown?.trim();
    return [{
      at: at.toISOString(), kind: "capture" as const, title: displayTitle(note.title),
      ...(detail && detail !== note.title.trim() ? { detail: plainExcerpt(detail.split("\n")[0]!, 80) } : {}),
      ref: { type: "note" as const, id: note.id }, past: at.getTime() < nowMs,
    }];
  });
}
