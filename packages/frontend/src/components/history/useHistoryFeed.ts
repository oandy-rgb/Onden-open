// The workspace History feed: the days with changes, newest first, a page of
// HISTORY_DAYS days at a time. The server says where the next page ends
// (`earlier_day`), so a stretch of quiet days is skipped in one step and the
// end of history is known rather than guessed. Pages are loaded only to reach a day
// (`loadThrough`); `covers(date)` says whether that day's page has been read.
import { useCallback, useEffect, useRef, useState } from "react";
import { addDays } from "../../lib/localDate";
import { DAY_NOTES_PAGE, HISTORY_DAYS, fetchDayNotes, fetchFeed, isHistoryUnavailable, type HistorySpace } from "../../lib/history";
import type { FeedDay } from "@onden/contract";

type Status = "loading" | "ready" | "error";

export function useHistoryFeed(today: string, space: HistorySpace = null) {
  const [days, setDays] = useState<FeedDay[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [unavailable, setUnavailable] = useState(false);
  const [moreStatus, setMoreStatus] = useState<"idle" | "loading" | "error">("idle");
  const [hasMore, setHasMore] = useState(false);
  // Mirrors cursor.reached for rendering: the oldest day the loaded pages reach.
  const [reached, setReached] = useState(today);
  // Read by loadThrough's loop between renders, so it lives in a ref.
  const cursor = useRef({ earlier: null as string | null, reached: today, busy: false, generation: 0 });
  const loadedSpace = useRef(space);
  const daysRef = useRef(days);
  daysRef.current = days;

  const reload = useCallback(() => {
    const generation = ++cursor.current.generation;
    cursor.current.busy = false;
    setStatus("loading");
    setMoreStatus("idle");
    // Another space: the days on screen belong to the old one, drop them instead of showing them under the new choice.
    if (loadedSpace.current !== space) {
      loadedSpace.current = space;
      setDays([]);
      setHasMore(false);
    }
    fetchFeed(today, HISTORY_DAYS, space).then(
      (feed) => {
        if (generation !== cursor.current.generation) return;
        cursor.current.earlier = feed.earlier_day;
        cursor.current.reached = addDays(today, -(HISTORY_DAYS - 1));
        setReached(cursor.current.reached);
        setDays(feed.days);
        setHasMore(feed.earlier_day !== null);
        setUnavailable(false);
        setStatus("ready");
      },
      (error) => {
        if (generation !== cursor.current.generation) return;
        setDays([]);
        setHasMore(false);
        setUnavailable(isHistoryUnavailable(error));
        setStatus("error");
      },
    );
  }, [today, space]);
  useEffect(reload, [reload]);

  /** The next older page. False when there is none or it failed. */
  const loadNext = useCallback(async (): Promise<boolean> => {
    const c = cursor.current;
    if (c.busy || c.earlier === null) return false;
    const { generation, earlier } = c;
    c.busy = true;
    setMoreStatus("loading");
    try {
      const feed = await fetchFeed(earlier, HISTORY_DAYS, space);
      if (generation !== cursor.current.generation) return false;
      c.reached = addDays(earlier, -(HISTORY_DAYS - 1));
      setReached(c.reached);
      c.earlier = feed.earlier_day;
      setDays((prev) => [...prev, ...feed.days]);
      setHasMore(feed.earlier_day !== null);
      setMoreStatus("idle");
      return true;
    } catch {
      if (generation === cursor.current.generation) setMoreStatus("error");
      return false;
    } finally {
      if (generation === cursor.current.generation) c.busy = false;
    }
  }, [space]);

  /** Load older pages until `date` is covered (or history ends / a page fails). */
  const loadThrough = useCallback(async (date: string): Promise<void> => {
    while (cursor.current.reached > date && cursor.current.earlier !== null) {
      if (!(await loadNext())) return;
    }
  }, [loadNext]);

  /** The next page of `date`'s notes, appended to the ones shown. False when it failed. */
  const loadMoreNotes = useCallback(async (date: string): Promise<boolean> => {
    const generation = cursor.current.generation;
    const shown = daysRef.current.find((d) => d.date === date)?.notes.length;
    if (shown === undefined) return false;
    try {
      const page = await fetchDayNotes(date, shown, DAY_NOTES_PAGE, space);
      if (generation !== cursor.current.generation) return false;
      setDays((prev) => prev.map((d) => {
        if (d.date !== date || d.notes.length !== shown) return d;
        const have = new Set(d.notes.map((n) => n.id));
        return { ...d, notes: [...d.notes, ...page.notes.filter((n) => !have.has(n.id))], notes_total: page.notes_total, edits_total: page.edits_total };
      }));
      return true;
    } catch {
      return false;
    }
  }, [space]);

  /** True when `date` is inside the loaded pages, or no older page exists to hold it. */
  const covers = (date: string) => reached <= date || !hasMore;

  return { days, status, unavailable, hasMore, moreStatus, reload, loadThrough, loadMoreNotes, covers };
}
