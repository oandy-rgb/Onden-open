// Whether the next location write is a new history entry or rewrites the current one, when the caller knows
// better than the default (hooks/useUrlLocation's table). Lives in lib so the data layer's automatic moves
// (a deleted page's neighbour) can state it too; hooks/useUrlLocation reads it and re-exports `navigate`.
export type HistoryIntent = "push" | "replace";
let pendingIntent: HistoryIntent | null = null;
let intentTimer: ReturnType<typeof setTimeout> | undefined;

/** Run `go` (state changes) so the resulting location is written as `history`. The intent is for the next location
 *  write only, and lapses on its own if none follows. */
export function navigate(go: () => void, { history }: { history: HistoryIntent }): void {
  pendingIntent = history;
  clearTimeout(intentTimer);
  intentTimer = setTimeout(() => { pendingIntent = null; }, 500);
  go();
}

/** The intent stated for this location write, if any; it is used up. */
export function takeHistoryIntent(): HistoryIntent | null {
  const intent = pendingIntent;
  pendingIntent = null;
  return intent;
}

// A note shown because the history (Back, Forward, a tab tap, the link trail) went to a location: that location names
// the tab it was on, so the tab remembered for the note must not replace it. The mark is the note it is for and is
// used up by the next change of the focused note (hooks/useWorkspaceFocus); a mark that nothing used names another note then.
let arrivedAt: string | null = null;

/** The history arrived at `nodeId` with its tab (and lens) already shown. */
export function markHistoryArrival(nodeId: string | null): void {
  arrivedAt = nodeId;
}

/** Whether the focused note `nodeId` was arrived at from history; the mark is used up either way. */
export function takeHistoryArrival(nodeId: string | null): boolean {
  const arrived = arrivedAt !== null && arrivedAt === nodeId;
  arrivedAt = null;
  return arrived;
}
