// The workspace-history screen's server calls (the 最近 14 天 view). Reads
// go through reads.history; undo and redo are writes, made by historyWriter
// (lib/data/noteHistoryWriter.ts). The 404 of an older backend is an answer, not a failure:
// isHistoryUnavailable lets the screen show its empty state instead.
import { ApiError } from "../api";
import { reads } from "../data";
import type { ActivityDay, DayNotes, DeletedNotesPage, DeletedNoteBody, Feed } from "@onden/contract";

export const DAY_NOTES_PAGE = 50;
/** noteIds the undo changed, the ones both sides edited (now in the inbox), and
 *  the ones the actor may not edit (left alone). */
export type RunUndoResult = { undone: string[]; conflicts: string[]; skipped: string[] };

export const HISTORY_DAYS = 14;
export const DELETED_DAYS = 30;

/** Which space a History read covers: a space id, or null for every space the caller can read. */
export type HistorySpace = string | null;

/** The `days` days ending `until` (default: today). */
export async function fetchActivity(days = HISTORY_DAYS, until?: string, space: HistorySpace = null): Promise<ActivityDay[]> {
  return (await reads.history.activity<{ days: ActivityDay[] }>(days, until, space ?? undefined)).days;
}

/** The days with changes among the `days` days ending `until`, newest first. */
export function fetchFeed(until: string, days = HISTORY_DAYS, space: HistorySpace = null): Promise<Feed> {
  return reads.history.feed<Feed>(until, days, space ?? undefined);
}

/** `limit` notes of `date` after the first `offset`, newest first. */
export function fetchDayNotes(date: string, offset: number, limit = DAY_NOTES_PAGE, space: HistorySpace = null): Promise<DayNotes> {
  return reads.history.dayNotes<DayNotes>(date, offset, limit, space ?? undefined);
}

/** The first page of 「最近刪除」 (the last `days` days), or with `before` (the previous page's `older_cursor`) the next, older one. */
export function fetchDeleted(days = DELETED_DAYS, space: HistorySpace = null, before?: string): Promise<DeletedNotesPage> {
  return reads.history.deleted<DeletedNotesPage>(days, space ?? undefined, before);
}

export function fetchDeletedBody(id: string): Promise<DeletedNoteBody> {
  return reads.history.deletedBody<DeletedNoteBody>(id);
}

/** An older backend without /api/history/*. */
export function isHistoryUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
