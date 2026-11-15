// What the RSS reader remembers about the person, kept per account so it is
// the same on every device (lib/accountPrefStore): the 「顯示未讀數字」 setting,
// each feed's own number choice, where they were in each view, and when the
// reader was last open. Each used to be a this-device-only pref (the PREFS
// entries marked Retired); the first sync moves an old value up once.

import { createAccountPref } from "../../lib/accountPrefStore";
import { PREFS } from "../../lib/prefs";

export type FeedCountChoice = "on" | "off";
/** "all" for All feeds, else the feed id. */
export type ReaderView = string;
export type ReadingPosition = { id: string; open: boolean };

/** The most feeds with their own number choice, and views with a remembered
 *  place (the newest). The server refuses more (services/actorPrefs.ts). */
const MAX_FEEDS = 500;
export const MAX_VIEWS = 50;

const json = (raw: string): unknown => { try { return JSON.parse(raw) as unknown; } catch { return null; } };
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64;

export function parseShowCounts(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function parseFeedCounts(value: unknown): Record<string, FeedCountChoice> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, FeedCountChoice> = {};
  for (const [feed, choice] of Object.entries(value)) {
    if (isId(feed) && (choice === "on" || choice === "off") && Object.keys(out).length < MAX_FEEDS) out[feed] = choice;
  }
  return out;
}

export function parseReadingPositions(value: unknown): Record<ReaderView, ReadingPosition> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<ReaderView, ReadingPosition> = {};
  for (const [view, pos] of Object.entries(value)) {
    const p = pos as Partial<ReadingPosition> | null;
    if (isId(view) && p && isId(p.id)) out[view] = { id: p.id, open: p.open === true };
  }
  const views = Object.keys(out);
  for (const view of views.slice(0, Math.max(0, views.length - MAX_VIEWS))) delete out[view];
  return out;
}

export function parseLastVisit(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : null;
}

export const rssShowCountsPref = createAccountPref<boolean>({
  serverKey: "rssShowCounts",
  follows: "account", // unread numbers on or off: a taste, same on every screen
  copy: PREFS.rssShowCountsCopy,
  parse: parseShowCounts,
  legacy: { pref: PREFS.rssShowCounts, parse: (raw) => (raw === "true" ? true : raw === "false" ? false : null) },
});

export const rssFeedCountsPref = createAccountPref<Record<string, FeedCountChoice>>({
  serverKey: "rssFeedCounts",
  follows: "account", // per-feed number choice: a taste, same on every screen
  copy: PREFS.rssFeedCountsCopy,
  parse: parseFeedCounts,
  legacy: { pref: PREFS.rssFeedCounts, parse: (raw) => parseFeedCounts(json(raw)) },
});

export const rssReadingPositionPref = createAccountPref<Record<ReaderView, ReadingPosition>>({
  serverKey: "rssReadingPosition",
  follows: "account", // where they stopped reading: should resume on any device
  copy: PREFS.rssReadingPositionCopy,
  parse: parseReadingPositions,
  legacy: { pref: PREFS.rssReadingPosition, parse: (raw) => parseReadingPositions(json(raw)) },
});

export const rssLastVisitPref = createAccountPref<string>({
  serverKey: "rssLastVisit",
  follows: "account", // when they last opened Reading: a moment in time, not a screen
  copy: PREFS.rssLastVisitCopy,
  parse: parseLastVisit,
  isNewer: (a, b) => Date.parse(a) > Date.parse(b),
  legacy: { pref: PREFS.rssLastVisit, parse: parseLastVisit },
});

/** Keep all four in sync with the account; every RSS surface that reads one calls this. */
export function useRssPrefsInSync(): void {
  rssShowCountsPref.useKeepInSync();
  rssFeedCountsPref.useKeepInSync();
  rssReadingPositionPref.useKeepInSync();
  rssLastVisitPref.useKeepInSync();
}

/** Tests: start from what the local copies hold, as a fresh page does. */
export function forgetRssPrefs(): void {
  for (const pref of [rssShowCountsPref, rssFeedCountsPref, rssReadingPositionPref, rssLastVisitPref]) pref.store.forget();
}
