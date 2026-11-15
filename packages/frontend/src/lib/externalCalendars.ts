// Events from the calendars a person subscribed to (modules/external_calendars).
//
// They are not notes: the server keeps them as rows, answers the ones that touch a
// range of workspace days, and this file hands them to the timeline. Read-only.
// The last answer is kept on this device so the timeline still shows them when the
// server cannot be reached (offline, or the server is down).

import { isCalendarDay } from "@onden/markdown";
import { getPrefJson, setPrefJson, type Pref } from "./prefs";
import { nameBasedUUID } from "./uuid";

export type ExternalCalendar = {
  id: string; name: string; color: string;
  /** The address's host only; the address itself never leaves the server. */
  host: string;
  enabled: boolean;
  last_fetched_at: string | null;
  last_error: "unreachable" | "not_calendar" | "too_large" | "blocked" | null;
};

export type ExternalEvent = {
  id: string; calendar_id: string; calendar_name: string; color: string;
  title: string; location: string; description: string; all_day: boolean;
  starts_at: string; ends_at: string;
  /** First and last workspace day the event touches (inclusive). */
  start_day: string; end_day: string;
};

/** The last events the server sent, kept per account on this device (not in PREFS: it is only read by the day pane, loaded on use). */
const CACHE: Pref = { key: "onden.externalEvents", scope: "account" };

export type CachedExternalEvents = { from: string; to: string; events: ExternalEvent[] };

/** The last answer the server gave (kept on this device), or null. */
export function readCachedExternalEvents(): CachedExternalEvents | null {
  const raw = getPrefJson(CACHE) as Partial<CachedExternalEvents> | null;
  if (!raw || !isCalendarDay(raw.from ?? "") || !isCalendarDay(raw.to ?? "") || !Array.isArray(raw.events)) return null;
  return raw as CachedExternalEvents;
}

/** The events of one workspace day, all-day ones first, then by start. */
export function eventsOnDay(events: readonly ExternalEvent[], date: string): ExternalEvent[] {
  return events
    .filter((e) => e.start_day <= date && date <= e.end_day)
    .sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.starts_at.localeCompare(b.starts_at) || a.title.localeCompare(b.title));
}

const NOTE_NAMESPACE = "7c1f2a9e-5b3d-4e8a-9c46-2d0b1a8f6e53";

/** The id of the note made from this event: the same everywhere, so opening the event again finds that note. */
export function eventNoteId(event: Pick<ExternalEvent, "id">): string {
  return nameBasedUUID(NOTE_NAMESPACE, `external-event:${event.id}`);
}

export function keepExternalEvents(answer: CachedExternalEvents): void {
  setPrefJson(CACHE, answer);
}
