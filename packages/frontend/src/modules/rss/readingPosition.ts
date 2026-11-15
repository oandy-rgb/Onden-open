// Where you are in each view of the reader, instead of a read/unread state
// per article: the article you were on in All feeds and in each feed, and
// whether it was open. Opening the view again resumes there, on any device.
// Articles you moved past are "seen" through the existing seen mark (POST
// /api/rss/items/:id/seen, sent when an article is left), so no new table:
// this only remembers the place, per account (rssPrefs; the latest MAX_VIEWS views).
//
// The place changes with every article opened, so the local copy updates at
// once but the server is told only after SEND_AFTER_MS without a change, and
// when the page is hidden or closed.

import { rssReadingPositionPref, MAX_VIEWS, type ReaderView, type ReadingPosition } from "./rssPrefs";
import { onPageHide } from "../../lib/pageHide";
import { hasDocument } from "../../lib/documentAccess";

export type { ReaderView, ReadingPosition };

const SEND_AFTER_MS = 2000;
const positions = rssReadingPositionPref.store;
let sendTimer: ReturnType<typeof setTimeout> | null = null;
let leaving = false;

function sendNow(): void {
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = null;
  if (rssReadingPositionPref.bound() && positions.get().dirty) void positions.sync();
}

function sendOnLeave(): void {
  if (leaving || !hasDocument()) return;
  leaving = true;
  onPageHide(sendNow);
}

export function viewKey(sourceId: string | null): ReaderView {
  return sourceId ?? "all";
}

/** The place remembered for a view, null when there is none. */
export function readingPosition(view: ReaderView): ReadingPosition | null {
  return positions.get().value?.[view] ?? null;
}

/** Remember the place in a view; only the latest MAX_VIEWS views are kept. */
export function rememberPosition(view: ReaderView, pos: ReadingPosition): void {
  const all = { ...(positions.get().value ?? {}) };
  delete all[view];
  all[view] = pos;
  const views = Object.keys(all);
  for (const old of views.slice(0, Math.max(0, views.length - MAX_VIEWS))) delete all[old];
  positions.stage(all);
  sendOnLeave();
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = setTimeout(sendNow, SEND_AFTER_MS);
}

/** A touch gesture's start and end, in client pixels and ms. */
export type TouchPoint = { x: number; y: number; t: number };

/** The least horizontal travel, in px, that counts as a swipe. */
export const SWIPE_MIN_DX = 60;

/** What a finished touch means in the article: "next" (swipe left),
 *  "prev" (swipe right), or null. Only a clearly horizontal, quick flick
 *  counts — at least SWIPE_MIN_DX across, more than twice as far across as
 *  down, within 800 ms — so scrolling (mostly vertical) and a long-press or
 *  drag that selects text are never taken for a swipe. A gesture that left a
 *  text selection behind is a selection, not a swipe. */
export function swipeIntent(start: TouchPoint, end: TouchPoint, opts: { selecting?: boolean } = {}): "next" | "prev" | null {
  if (opts.selecting) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < SWIPE_MIN_DX) return null;
  if (Math.abs(dx) <= 2 * Math.abs(dy)) return null;
  if (end.t - start.t > 800) return null;
  return dx < 0 ? "next" : "prev";
}
