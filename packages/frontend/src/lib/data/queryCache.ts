// Minimal query layer: concurrent-dedupe + short-TTL cache for GET endpoints.
// Two panels requesting the same endpoint in the same tick share one fetch
// (the HistoryView / EventLogPanel double-fetch from the code review). This is
// deliberately tiny — if needs grow (per-key subscriptions, retries, garbage
// collection), swap the internals for TanStack Query behind these two calls.

import { api } from "../api";

type Entry = { promise: Promise<unknown>; at: number };

const inflight = new Map<string, Entry>();

/** GET `path`, deduping concurrent calls and reusing a response for ttlMs.
 *  ttlMs=0 (default) dedupes only while the request is in flight. */
export function dedupedGet<T>(path: string, opts: { ttlMs?: number } = {}): Promise<T> {
  const ttl = opts.ttlMs ?? 0;
  const hit = inflight.get(path);
  // ttl=0: the entry is deleted the moment the request settles (see below), so a
  // surviving entry is by-construction still in flight — always dedupe onto it.
  // The old `Date.now() - hit.at <= 0` only matched within the SAME millisecond,
  // so two reads a few ms apart but both in-flight each fired their own fetch.
  // ttl>0 keeps the time-window semantics for the short-lived response cache.
  if (hit && (ttl === 0 || Date.now() - hit.at <= ttl)) return hit.promise as Promise<T>;
  const entry: Entry = {
    at: Date.now(),
    promise: api<T>(path).then(
      (v) => {
        if (ttl === 0) inflight.delete(path);
        return v;
      },
      (e) => {
        inflight.delete(path); // never cache failures
        throw e;
      },
    ),
  };
  inflight.set(path, entry);
  return entry.promise as Promise<T>;
}

/** Drop cached entries whose path starts with `prefix` (e.g. on an SSE tick:
 *  invalidate("/api/events")). No prefix clears everything. */
export function invalidateQueries(prefix = ""): void {
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
}

/** For a list that is re-read when its question changes (another feed, another
 *  filter): only the newest request may show its answer. Each `begin()` retires
 *  the earlier ones; after awaiting, `if (!isCurrent()) return;` drops an answer
 *  (or a failure) that is no longer for the question being asked. Keep one per
 *  list, in a ref. Reads cannot be recalled, so the earlier request still runs;
 *  its result is just not used. */
export function latestOnly(): { begin(): () => boolean } {
  let newest = 0;
  return { begin() { const mine = ++newest; return () => mine === newest; } };
}
