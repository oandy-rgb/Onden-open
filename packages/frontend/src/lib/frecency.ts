// ⌘K frecency — recency-weighted open history for the command palette's
// default (no-query) list. "frecency" = frequency × recency: a note opened
// often AND recently ranks above one merely edited recently (the old
// updated_at sort). Local-only (a per-account habit signal kept in this
// browser, lib/prefs — the ids are the account's notes; not synced state),
// capped, and degrading gracefully — a workspace with no history falls back to
// the caller's input order (today's updated_at sort), so new users see no
// change.

import { PREFS, getPrefJson, setPrefJson } from "./prefs";

const MAX_ENTRIES = 300; // cap so a long-lived store can't grow unbounded

export type FrecencyEntry = { n: number; t: number }; // opens, last-open ms
export type FrecencyStore = Record<string, FrecencyEntry>;

export function getFrecency(): FrecencyStore {
  const store = getPrefJson(PREFS.frecency);
  return store && typeof store === "object" && !Array.isArray(store) ? (store as FrecencyStore) : {};
}

/** Record that a node was opened: bump its count + stamp now. Evicts the
 *  least-recently-opened entries once over the cap. `now` is injectable for
 *  tests. */
export function recordOpen(id: string, now: number = Date.now()): void {
  if (!id) return;
  // Storage blocked: frecency just stays empty.
  const store = getFrecency();
  const prev = store[id];
  store[id] = { n: (prev?.n ?? 0) + 1, t: now };
  const ids = Object.keys(store);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => store[a].t - store[b].t); // oldest first
    for (const stale of ids.slice(0, ids.length - MAX_ENTRIES)) delete store[stale];
  }
  setPrefJson(PREFS.frecency, store);
}

/** Recency multiplier by age bucket (Mozilla-style): a recent open is worth far
 *  more than an old one, so a single open today can outrank many last month. */
function recencyWeight(ageMs: number): number {
  const h = ageMs / 3_600_000;
  if (h < 1) return 100;
  if (h < 24) return 40;
  if (h < 24 * 7) return 20;
  if (h < 24 * 30) return 8;
  return 2;
}

/** Pure frecency score: open count × recency weight of the last open. */
export function scoreEntry(e: FrecencyEntry | undefined, now: number): number {
  if (!e || e.n <= 0) return 0;
  return e.n * recencyWeight(now - e.t);
}

/** Stable-sort `ids` by descending frecency score; ids with no history keep
 *  their input order (a 0 score), so the caller's fallback ordering survives. */
export function rankByFrecency(ids: string[], store: FrecencyStore, now: number = Date.now()): string[] {
  return ids
    .map((id, i) => ({ id, i, score: scoreEntry(store[id], now) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.id);
}
