// Reads a calendar's iCal text into plain event instances, repeats expanded.
//
// Pure: no network, no database. The parser is node-ical (Apache-2.0); this file
// is the only place that imports it, so what the rest of the module knows is
// `CalendarInstance`, not the library's types.
//
//   • Repeats (RRULE), skipped dates (EXDATE) and single-occurrence changes
//     (RECURRENCE-ID) come out as one instance each, inside [from, to].
//   • Time zones (VTIMEZONE, Windows zone names, UTC) are resolved by the parser
//     to an instant. An all-day event is NOT an instant: it is a run of calendar
//     dates (`startDate`..`endDate`, end exclusive) that means the same days in
//     every zone, so it is kept as dates and never shifted.
//   • A time with no zone at all ("floating": DTSTART:20260110T090000, no TZID, no Z) means the wall
//     clock wherever the owner is: the workspace's zone. The parser would read it in the HOST's zone, so it is
//     given to the parser as UTC wall clock (markFloating) and re-read here, per instance, in the workspace's.
//   • A cancelled event, or a cancelled single occurrence, yields nothing.
//   • Which workspace day an instant belongs to is decided at read time with the
//     workspace clock (store.ts), so changing the time zone or the day start
//     needs no refetch.

import { addDays, cutToUnits } from "@onden/markdown";
import { StatusError } from "../../statusError.js";
import { workspaceTimeZone } from "../../localDay.js";
import ical, { type EventInstance, type ParameterValue, type VEvent } from "node-ical";

export type CalendarInstance = {
  /** Stable across fetches: the event's UID plus which occurrence it is. */
  key: string;
  title: string;
  location: string;
  description: string;
  allDay: boolean;
  /** Instants (ISO). For an all-day event: the first day's start and the last day's end in UTC, only for ordering. */
  startsAt: string;
  endsAt: string;
  /** All-day only: YYYY-MM-DD, `endDate` exclusive. */
  startDate: string | null;
  endDate: string | null;
};

export class NotCalendarError extends StatusError {
  constructor() { super(422, "not an iCalendar document"); }
}

const TITLE_MAX = 200;
const LOCATION_MAX = 200;
const DESCRIPTION_MAX = 2000;
/** One calendar must not turn into an unbounded number of rows. */
export const MAX_INSTANCES = 5000;

const text = (value: ParameterValue | undefined, max: number): string => {
  const raw = value === undefined ? "" : typeof value === "string" ? value : String(value.val ?? "");
  return cutToUnits(raw.replace(/\r\n?/g, "\n").trim(), max);
};

// node-ical builds a date-only value (DTSTART;VALUE=DATE) at local midnight of the process's zone, so the date
// that was written is the date in THAT zone: formatted back here, whatever zone the server runs in. This is not
// a "which day is it" question (that is localDay.ts); it only undoes the parser's choice.
const WRITTEN_DATE = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
const dateOf = (d: Date): string => WRITTEN_DATE.format(d);

/** The parser's window is a day wider each side: a floating time moves by up to a day when re-read in another zone. */
const DAY_MS = 24 * 3_600_000;
const zoneFormats = new Map<string, Intl.DateTimeFormat>();
/** The wall clock of `zone` at `at`, read as if it were UTC (only differences mean anything). */
function wallAsUtc(at: number, zone: string): number {
  let f = zoneFormats.get(zone);
  if (!f) zoneFormats.set(zone, f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
}

/** A pseudo-UTC reading of a wall clock (see `markFloating`), read again as that wall clock in `zone`. */
function rereadInZone(pseudoUtc: Date, zone: string): Date {
  const wall = pseudoUtc.getTime();
  let at = wall - (wallAsUtc(wall, zone) - wall); // first guess: the offset at the wall time taken as UTC
  at = wall - (wallAsUtc(at, zone) - at); // again, at the offset of the guess: right except in a daylight-saving gap
  return new Date(at);
}

const FLOATING_VALUE = /^\d{8}T\d{6}$/;
const TIME_PROPERTY = /^(DTSTART|DTEND|EXDATE|RDATE|RECURRENCE-ID)((?:;[^:\r\n]*)?):([^\r\n]+)$/;

/** Events whose time has no zone at all are handed to the parser as UTC (a "Z" added to each of their times), so that
 *  their repeats step by whole wall-clock days whatever zone the host is in and no VTIMEZONE of the file is borrowed.
 *  The result reads the UTC clock of each instance as the wall clock (`rereadInZone`). Returns the text and the UIDs it did this to. */
function markFloating(icsText: string): { text: string; floatingUids: Set<string> } {
  const floatingUids = new Set<string>();
  const text = icsText.replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g, (block) => {
    const lines = block.replace(/\r?\n[ \t]/g, "").split(/(\r?\n)/);
    const timed = (line: string, name: string) => { const m = TIME_PROPERTY.exec(line); return m && m[1] === name && !/TZID=|VALUE=DATE/i.test(m[2]!) ? m[3]! : null; };
    const start = lines.map((l) => timed(l, "DTSTART")).find((v) => v !== null);
    if (!start || !FLOATING_VALUE.test(start.trim())) return block;
    const uid = lines.map((l) => /^UID:(.*)$/.exec(l)?.[1]).find((v) => v !== undefined);
    if (uid === undefined) return block;
    floatingUids.add(uid.trim());
    return lines.map((line) => {
      const m = TIME_PROPERTY.exec(line);
      if (m && !/TZID=|VALUE=DATE/i.test(m[2]!)) return `${m[1]}${m[2]}:${m[3]!.split(",").map((v) => FLOATING_VALUE.test(v.trim()) ? `${v.trim()}Z` : v).join(",")}`;
      return line.startsWith("RRULE:") ? line.replace(/UNTIL=(\d{8}T\d{6})(?=;|$)/, "UNTIL=$1Z") : line;
    }).join("");
  });
  return { text, floatingUids };
}

/** The instance of a floating event, its wall clock read in `zone`. */
function inZone(inst: EventInstance, zone: string): EventInstance {
  const recurrenceid = inst.event.recurrenceid instanceof Date ? rereadInZone(inst.event.recurrenceid, zone) : inst.event.recurrenceid;
  return { ...inst, start: rereadInZone(inst.start, zone), end: inst.end ? rereadInZone(inst.end, zone) : inst.end, event: { ...inst.event, recurrenceid } as VEvent };
}

function toInstance(inst: EventInstance, key: string): CalendarInstance | null {
  const event = inst.event;
  if (event.status === "CANCELLED") return null;
  const title = text(event.summary, TITLE_MAX);
  const common = { title, location: text(event.location, LOCATION_MAX), description: text(event.description as ParameterValue | undefined, DESCRIPTION_MAX) };
  if (inst.isFullDay) {
    const startDate = dateOf(inst.start);
    let endDate = inst.end ? dateOf(inst.end) : startDate;
    // A missing or empty end (DTEND = DTSTART) still covers its own day.
    if (endDate <= startDate) endDate = addDays(startDate, 1);
    return {
      key, ...common, allDay: true, startDate, endDate,
      startsAt: new Date(`${startDate}T00:00:00Z`).toISOString(), endsAt: new Date(`${endDate}T00:00:00Z`).toISOString(),
    };
  }
  const start = inst.start.getTime();
  const end = inst.end && inst.end.getTime() > start ? inst.end.getTime() : start;
  return { key, ...common, allDay: false, startDate: null, endDate: null, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() };
}

/** The instances that touch [from, to], sorted by start. Throws NotCalendarError for text that is no calendar. */
export function expandCalendar(icsText: string, range: { from: Date; to: Date }, floatingZone: string = workspaceTimeZone()): CalendarInstance[] {
  if (!/BEGIN:VCALENDAR/i.test(icsText)) throw new NotCalendarError();
  const floating = markFloating(icsText);
  let parsed: ReturnType<typeof ical.parseICS>;
  try {
    parsed = ical.parseICS(floating.text);
  } catch {
    throw new NotCalendarError();
  }
  const out = new Map<string, CalendarInstance>();
  for (const component of Object.values(parsed)) {
    if (!component || component.type !== "VEVENT") continue;
    const event = component as VEvent;
    if (!event.start || Number.isNaN(event.start.getTime())) continue;
    const uid = String(event.uid ?? "");
    if (!uid) continue;
    let instances: EventInstance[];
    try {
      instances = ical.expandRecurringEvent(event, { from: new Date(range.from.getTime() - DAY_MS), to: new Date(range.to.getTime() + DAY_MS), includeOverrides: true, excludeExdates: true, expandOngoing: true });
    } catch {
      continue; // one broken rule must not hide the rest of the calendar
    }
    for (const raw of instances) {
      const inst = !raw.isFullDay && floating.floatingUids.has(uid) ? inZone(raw, floatingZone) : raw;
      const occurrence = inst.isFullDay ? dateOf(inst.start) : inst.start.toISOString();
      // An override replaces the occurrence it names, so the key is the original slot's when the library reports it.
      const slot = inst.isOverride && inst.event.recurrenceid instanceof Date
        ? (inst.isFullDay ? dateOf(inst.event.recurrenceid) : inst.event.recurrenceid.toISOString())
        : occurrence;
      const made = toInstance(inst, `${uid}|${slot}`);
      if (made && made.startsAt <= range.to.toISOString() && made.endsAt >= range.from.toISOString()) out.set(made.key, made);
      if (out.size >= MAX_INSTANCES) break;
    }
    if (out.size >= MAX_INSTANCES) break;
  }
  return [...out.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.key.localeCompare(b.key));
}
