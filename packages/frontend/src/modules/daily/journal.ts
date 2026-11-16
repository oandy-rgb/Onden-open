// The journal page's data (pure, unit-tested): the person's day notes by
// date and what each day shows under its body (its children: captures, never
// its hidden task nodes).

import { compareChildren } from "@onden/markdown";
import type { ContentNode } from "../../lib/api";
import { dayNoteDate } from "@onden/markdown";
import { isNote } from "@onden/markdown/contract";
import { isShownNote } from "../../lib/nodeTags";

type Row = Pick<ContentNode, "id" | "title" | "slug" | "hidden" | "node_type" | "parent_id" | "space_id" | "order_key" | "order_stamp" | "created_at"> & { deleted_at?: string | null };

/** The person's day notes, by date: live, visible notes titled with a date in
 *  their personal space (the findDayNode rule, for every date). The first one
 *  found wins a date, as findDayNode does. */
export function dayNotesByDate<T extends Row>(nodes: readonly T[], spaceId: string | null): Map<string, T> {
  const byDate = new Map<string, T>();
  for (const n of nodes) {
    if (n.deleted_at || !isNote(n)) continue;
    if (spaceId && n.space_id && n.space_id !== spaceId) continue;
    const date = dayNoteDate(n);
    if (date && !byDate.has(date)) byDate.set(date, n);
  }
  return byDate;
}

const isCapture = (n: Row) => isShownNote(n) && isNote(n);

/** The ids of day notes that have at least one capture beneath them. */
export function parentsWithCaptures(nodes: readonly Row[]): Set<string> {
  const ids = new Set<string>();
  for (const n of nodes) if (n.parent_id && isCapture(n)) ids.add(n.parent_id);
  return ids;
}

/** What a day shows under its body: its visible content children, in the
 *  sidebar's order (order_key, order_stamp, id). */
export function dayChildren<T extends Row>(nodes: readonly T[], dayId: string): T[] {
  return nodes
    .filter((n) => n.parent_id === dayId && isCapture(n))
    .sort(compareChildren);
}
