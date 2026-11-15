import type { LiveEvent } from "../lib/liveEvent";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { t } from "../lib/i18n";
import { isLiveConnected } from "../lib/liveEvents";
import { register } from "../lib/liveInvalidation";
import { reads, writeErrors } from "../lib/data";

type LiveState = {
  events: LiveEvent[];
  loading: boolean;
  error: string | null;
  isLive: boolean; // true when polling is active (tab visible + no error backoff)
};

type Options = {
  /** Extra query params (event_type, target_type, target_id, actor_type, actor_id, limit). */
  query?: Record<string, string | undefined>;
  /** Poll interval in ms when SSE is DOWN (default 5000). While the shared SSE
   *  stream is connected, fetches are tick-driven and the periodic poll
   *  stretches to a slow ~60s fallback. */
  intervalMs?: number;
  /** Cap on stored events to prevent unbounded growth (default 500). */
  maxEvents?: number;
};

// While SSE is up the periodic poll is only a degradation safety net.
const SSE_FALLBACK_POLL_MS = 60_000;

/**
 * Read one filtered event history. Changing the query immediately hides its old
 * rows and retires its requests, cursor and polling. Only the current query may
 * publish results, even if a retired request ignores cancellation.
 *
 * `reload()` waits for a fresh snapshot and returns false on failure or if its
 * query was left. Same-query refresh failures keep the last readable rows;
 * this result describes the read, never whether a preceding write committed.
 * Snapshot and incremental reads run in order. Ticks during a read request a
 * follow-up, so an older snapshot cannot erase a newer delta.
 */
export function useLiveEventLog(opts: Options = {}): LiveState & { reload: () => Promise<boolean> } {
  const { query = {}, intervalMs = 5000, maxEvents = 500 } = opts;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, value);
  }
  if (!params.has("limit")) params.set("limit", "200");
  params.sort();
  const queryKey = params.toString();
  // Returning to A after visiting B creates a new selection, not a revival of A.
  const selection = useMemo(() => ({ queryKey }), [queryKey]);
  const [state, setState] = useState<LiveState & { selection: typeof selection }>({
    selection, events: [], loading: true, error: null, isLive: true,
  });
  const readerRef = useRef<{ selection: typeof selection; reload: () => Promise<boolean> } | null>(null);
  const reload = useCallback(() => {
    const reader = readerRef.current;
    return reader?.selection === selection ? reader.reload() : Promise.resolve(false);
  }, [selection]);

  useEffect(() => {
    const { queryKey } = selection;
    const controller = new AbortController();
    let disposed = false;
    // Read live: the tab's visibility and the shared stream's state
    // (lib/liveInvalidation.ts owns those signals).
    const isVisible = () => typeof document === "undefined" || !document.hidden;
    let backoffMs = intervalMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rows: LiveEvent[] = [];
    let cursor = 0;
    let loaded = false;
    let error: string | null = null;
    let reading = false;
    let pendingDelta = false;
    let pendingReloads: Array<(success: boolean) => void> = [];
    let activeReloads: Array<(success: boolean) => void> = [];
    // Match the server's page-size cap when deciding whether to drain further.
    const pageLimit = Math.min(Number(new URLSearchParams(queryKey).get("limit")) || 200, 500);

    const publish = (loading = false) => {
      if (!disposed) setState({ selection, events: rows, loading, error, isLive: isVisible() && !error });
    };
    const fetchPage = async (since?: number) => {
      const p = new URLSearchParams(queryKey);
      // Zero is a real forward cursor. Omitting it would request a DESC snapshot.
      if (since !== undefined) p.set("since", String(since));
      const result = await reads.events.page<LiveEvent>(p, controller.signal);
      // PostgreSQL serialises bigint IDs as strings.
      return result.events.map(e => ({ ...e, id: Number(e.id) }));
    };
    const readDelta = async () => {
      let nextCursor = cursor;
      const collected: LiveEvent[] = [];
      const hardCap = Math.max(maxEvents, pageLimit) + pageLimit;
      while (!disposed) {
        const page = await fetchPage(nextCursor); // ASC, oldest first
        if (page.length === 0) break;
        const latest = Math.max(...page.map(e => e.id));
        if (latest <= nextCursor) break;
        nextCursor = latest;
        collected.push(...page);
        if (page.length < pageLimit || collected.length >= hardCap) break;
      }
      return collected;
    };

    const schedulePoll = () => {
      clearTimeout(timer);
      if (disposed || !isVisible() || reading) return;
      const delay = error ? backoffMs : isLiveConnected() ? Math.max(intervalMs, SSE_FALLBACK_POLL_MS) : intervalMs;
      timer = setTimeout(requestDelta, delay);
    };

    // Each snapshot caller waits for the read that started AFTER its request.
    // Requests arriving during a read coalesce into the next read, not the one
    // whose response may have been computed before the caller's write committed.
    const run = async () => {
      if (disposed || reading) return;
      reading = true;
      clearTimeout(timer);
      while (!disposed && (pendingReloads.length > 0 || pendingDelta)) {
        activeReloads = pendingReloads;
        pendingReloads = [];
        const snapshot = activeReloads.length > 0 || !loaded;
        pendingDelta = false;
        let success = false;
        try {
          const fresh = snapshot ? await fetchPage() : await readDelta();
          if (!disposed) {
            const unique = new Map((snapshot ? fresh : [...rows, ...fresh]).map(e => [e.id, e]));
            rows = [...unique.values()].sort((a, b) => b.id - a.id).slice(0, maxEvents);
            cursor = rows[0]?.id ?? 0;
            loaded = true;
            error = null;
            backoffMs = intervalMs;
            success = true;
          }
        } catch (cause) {
          if (!disposed) {
            error = writeErrors.requestMessage(cause, t("Failed to load events"));
            backoffMs = Math.min(backoffMs * 2, 30_000);
          }
        }
        publish();
        for (const resolve of activeReloads) resolve(success);
        activeReloads = [];
      }
      reading = false;
      schedulePoll();
    };
    function requestDelta() {
      if (disposed || !isVisible()) return;
      pendingDelta = true;
      void run();
    }
    const reader = {
      selection,
      reload: () => {
        if (disposed) return Promise.resolve(false);
        return new Promise<boolean>(resolve => {
          pendingReloads.push(resolve);
          void run();
        });
      },
    };
    readerRef.current = reader;
    publish(true);
    void reader.reload();

    // A "changed" tick or a reopened stream reads the delta now; the tab
    // coming back resumes it (a hidden tab stops polling in schedulePoll).
    const unregisterChanged = register("changed", requestDelta);
    const unregisterVisible = register("visible", () => { publish(!loaded && reading); requestDelta(); });
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
      unregisterChanged();
      unregisterVisible();
      for (const resolve of [...activeReloads, ...pendingReloads]) resolve(false);
      if (readerRef.current === reader) readerRef.current = null;
    };
  }, [selection, intervalMs, maxEvents]);

  // Effects run after render; never expose another query's rows in that gap.
  return state.selection === selection
    ? { events: state.events, loading: state.loading, error: state.error, isLive: state.isLive, reload }
    : { events: [], loading: true, error: null, isLive: false, reload };
}
