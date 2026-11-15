// Collapse a burst of edits to one note into one history row. The feed is
// newest-first (descending id), as GET /api/events returns it.
import type { LiveEvent } from "../liveEvent";
import { isMoveEvent } from "./eventSentence";

/** Edits by one actor closer together than this (measured from the group's
 *  newest edit back to the older one, boundary inclusive) share a row. */
export const EDIT_GROUP_WINDOW_MS = 10 * 60_000;

export type HistoryRow =
  | { kind: "event"; event: LiveEvent }
  /** `events` newest-first, at least two. */
  | { kind: "edits"; events: LiveEvent[] };

/** A plain body/title edit of a note: the only kind that groups. */
function isNoteEdit(e: LiveEvent): boolean {
  return e.event_type === "NODE_UPDATED" && e.target_type === "node" && !isMoveEvent(e);
}

function sameActor(a: LiveEvent, b: LiveEvent): boolean {
  return a.actor_type === b.actor_type && a.actor_id === b.actor_id;
}

/**
 * Rows for the feed. Consecutive edits join when they are the same note, the
 * same actor, within the window of the group's newest edit, and no other event
 * for that note sits between them. Events about other notes between two edits
 * do not interrupt a group; any event on the same note (a tag, a move, an edit
 * by someone else) does.
 */
export function groupEvents(events: LiveEvent[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  // Index in `rows` of each note's open group; any other event on the note
  // closes it.
  const open = new Map<string, number>();
  for (const e of events) {
    const note = e.target_type === "node" ? e.target_id : null;
    if (note !== null && isNoteEdit(e)) {
      const at = open.get(note);
      const row = at === undefined ? undefined : rows[at];
      const newest = row ? (row.kind === "edits" ? row.events[0]! : row.event) : undefined;
      if (row && at !== undefined && newest && sameActor(newest, e)
        && Date.parse(newest.created_at) - Date.parse(e.created_at) <= EDIT_GROUP_WINDOW_MS) {
        if (row.kind === "edits") row.events.push(e);
        else rows[at] = { kind: "edits", events: [row.event, e] };
        continue;
      }
      open.set(note, rows.length);
    } else if (note !== null) {
      open.delete(note);
    }
    rows.push({ kind: "event", event: e });
  }
  return rows;
}
