// 「接下來」: the next thing today that has a time, for the top bar's small tag.

import type { DayItem } from "@onden/markdown";

export type NextUp = { item: DayItem; minutes: number };

/** The first task (open, timed) that starts after `nowMs`, with whole minutes until it.
 *  Only tasks count: an edit or a capture is never "coming up". */
export function nextUp(items: readonly DayItem[], nowMs: number): NextUp | null {
  let best: { item: DayItem; at: number } | null = null;
  for (const item of items) {
    if (item.kind !== "task" || item.done || !item.at) continue;
    const at = Date.parse(item.at);
    if (at > nowMs && (!best || at < best.at)) best = { item, at };
  }
  return best ? { item: best.item, minutes: Math.max(1, Math.ceil((best.at - nowMs) / 60_000)) } : null;
}
