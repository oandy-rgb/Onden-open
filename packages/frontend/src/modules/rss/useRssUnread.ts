import { useEffect, useSyncExternalStore } from "react";
import { reads } from "../../lib/data";
import { rssLastVisitPref, useRssPrefsInSync } from "./rssPrefs";

/** Where a saved article goes: tags used like folders and an optional parent
 *  note (backend modules/rss/destination.ts). */
export type RssDestination = { tagIds: string[]; parentId: string | null };

/** A feed's save default as the server resolved it for this reader:
 *  "source" its own, "module" the workspace default, "none" top level without
 *  tags. */
export type RssSaveDefault = { tag_ids: string[]; parent_id: string | null; parent_title: string | null; origin: "source" | "module" | "none" };

export type RssVoice = "person" | "media";
/** How a feed's articles look in the list: text (as ever), a large picture, or with a play button. */
export type RssDisplayMode = "text" | "image" | "video";

export type RssSource = {
  id: string;
  title: string;
  url: string | null;
  fetch_interval_minutes: number;
  last_fetched_at: string | null;
  last_error: string | null;
  auto_tag: string | null;
  embed: boolean;
  /** 總是載入全文: load the full article whenever one from this feed opens. */
  always_fulltext?: boolean;
  /** A personal writer's feed or a publication's (the reader's 「聲音」 tag shows the people). */
  voice?: RssVoice;
  display_mode?: RssDisplayMode;
  /** Where this feed's own articles live (@onden/markdown articlePrefix): a link there opens in the reader. */
  article_prefix?: string | null;
  unseen: number;
  /** When the newest unseen article arrived (server time), null when none. */
  latest_unseen_at?: string | null;
  created_at: string;
  save_default?: RssSaveDefault;
};

type ModuleDefault = { tag_ids: string[]; parent_id: string | null };

export type RssUnread = {
  sources: RssSource[] | null;
  totalUnseen: number;
  /** When the newest unseen article arrived, across every feed (server time). */
  latestUnseenAt: string | null;
  /** The RSS module's workspace default (Settings › Modules › RSS), null when unset. */
  moduleDefault: ModuleDefault | null;
  /** Articles arrived since the reader was last open (the nav dot). */
  hasNew: boolean;
};

// One poll for every subscriber: the nav dot (top bar, bottom bar, 更多),
// the home line and the reader all read the same state, so a page shows one
// request a minute however many marks it renders. The state is dropped when
// the last subscriber leaves, so the next one starts from a fresh fetch.
//
// "Unseen", not "unread" — the Readwise wording: it's a stream position, not
// a debt (the retention sweep ages it out on its own). GET /api/rss/sources
// read-policy-filters both the sources and the counts.

type Snapshot = Omit<RssUnread, "hasNew"> & { visitedThrough: string | null };

const EMPTY: Snapshot = { sources: null, totalUnseen: 0, latestUnseenAt: null, moduleDefault: null, visitedThrough: null };
const POLL_MS = 60_000;

let snapshot: Snapshot = EMPTY;
/** Test seam: the feed list a first subscriber starts from, so a component test
 *  sees its feeds on the first render instead of after the poll. */
let primedSources: RssSource[] | null = null;
export function primeRssSources(sources: RssSource[] | null): void {
  primedSources = sources;
}
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let stopLastVisit: (() => void) | null = null;

function emit(): void {
  for (const l of listeners) l();
}

/** Refetch the feed list and counts; keeps the last known state when offline. */
export async function refreshRssUnread(): Promise<void> {
  try {
    const r = await reads.modules.rss.sources<{ sources: RssSource[]; total_unseen: number; latest_unseen_at?: string | null; module_default?: ModuleDefault | null }>();
    if (listeners.size === 0) return;
    snapshot = { ...snapshot, sources: r.sources, totalUnseen: r.total_unseen, latestUnseenAt: r.latest_unseen_at ?? null, moduleDefault: r.module_default ?? null };
    emit();
  } catch {
    /* offline / not ready — keep the last known counts */
  }
}

/** The last visit changed (another device's arrived, or this one's was saved). */
function takeLastVisit(): void {
  const visitedThrough = rssLastVisitPref.store.get().value;
  if (visitedThrough === snapshot.visitedThrough) return;
  snapshot = { ...snapshot, visitedThrough };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    snapshot = { ...EMPTY, sources: primedSources, visitedThrough: rssLastVisitPref.store.get().value };
    stopLastVisit = rssLastVisitPref.store.subscribe(takeLastVisit);
    void refreshRssUnread();
    timer = setInterval(() => void refreshRssUnread(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      stopLastVisit?.();
      stopLastVisit = null;
      snapshot = EMPTY;
    }
  };
}

/** The reader is open: everything that has arrived so far is no longer
 *  "new" for the nav dot. Stored as the newest arrival the reader has seen
 *  (server time, so the device clock does not matter), per account: another
 *  device's visit counts here too (rssPrefs, and only ever moves forward). */
export function markRssVisited(): void {
  const latest = snapshot.latestUnseenAt;
  if (!latest) return;
  const through = snapshot.visitedThrough;
  if (through && Date.parse(through) >= Date.parse(latest)) return;
  rssLastVisitPref.store.save(latest);
  takeLastVisit();
}

/** Whether articles arrived after `visitedThrough`; with no visit yet, any
 *  unseen article counts as new. */
export function hasNewSince(latestUnseenAt: string | null, visitedThrough: string | null, totalUnseen: number): boolean {
  if (!latestUnseenAt) return false;
  if (!visitedThrough) return totalUnseen > 0;
  return Date.parse(latestUnseenAt) > Date.parse(visitedThrough);
}

const noSubscribe = () => () => {};

/** How many feeds the reader can see, from the same shared poll as the nav dot.
 *  `on` false (RSS removed) does not subscribe, so nothing is fetched. */
export function useRssSourceCount(on: boolean): number {
  useRssPrefsInSync();
  return useSyncExternalStore(on ? subscribe : noSubscribe, () => (on ? snapshot.sources?.length ?? 0 : 0));
}

/** The shared feed list, counts and nav-dot state. `intervalMs` below the
 *  shared minute adds a faster poll while this subscriber is mounted (the
 *  reader). */
export function useRssUnread(intervalMs = POLL_MS): RssUnread & { refresh: () => Promise<void> } {
  useRssPrefsInSync();
  const s = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => {
    if (intervalMs >= POLL_MS) return;
    const t = setInterval(() => void refreshRssUnread(), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return {
    sources: s.sources,
    totalUnseen: s.totalUnseen,
    latestUnseenAt: s.latestUnseenAt,
    moduleDefault: s.moduleDefault,
    hasNew: hasNewSince(s.latestUnseenAt, s.visitedThrough, s.totalUnseen),
    refresh: refreshRssUnread,
  };
}
