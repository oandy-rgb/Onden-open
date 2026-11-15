// Calendar dates as YYYY-MM-DD ids — the convention of task due dates, daily
// notes and the agenda. "Today" is the workspace's day: the server cuts every
// date rule on one clock (backend localDay.ts) — a time zone and the hour a
// day starts at (Settings › Time; 4 means 02:00 still belongs to the day
// before) — and ships both with the workspace, so an offline agenda buckets a
// task the way the server would. Before the bootstrap arrives (or from an
// older server) the browser's zone and a midnight start stand in.

// The clock comes from the app store, which registers itself below at load.
// localDate imports nothing of the app, so low-level modules (templates, capture syntax)
// can use it without pulling the store into their import graph.
let timeZoneSource: () => string | undefined = () => undefined;
let dayStartSource: () => number = () => 0;

/** Called once by lib/appStore: where the workspace's zone is read from. */
export function setWorkspaceTimeZoneSource(source: () => string | undefined): void {
  timeZoneSource = source;
}

/** Called once by lib/appStore: where the workspace's day start hour is read from. */
export function setWorkspaceDayStartSource(source: () => number): void {
  dayStartSource = source;
}

/** The workspace's IANA zone, or undefined (the browser's own). */
export function workspaceTimeZone(): string | undefined {
  try { return timeZoneSource(); } catch { return undefined; }
}

/** The hour (0–6) the workspace's day starts at; 0 is a plain calendar day. */
export function workspaceDayStartHour(): number {
  try {
    const hour = dayStartSource();
    return Number.isInteger(hour) && hour >= 0 && hour <= 6 ? hour : 0;
  } catch { return 0; }
}

function parts(at: Date, timeZone: string | undefined): Record<string, string> {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  return Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
}

/** The YYYY-MM-DD of an instant on the workspace clock (a timestamp's day):
 *  its wall time in the zone, less the day start hour. */
export function dateIdAt(at: Date, timeZone: string | undefined = workspaceTimeZone(), dayStartHour: number = workspaceDayStartHour()): string {
  const p = parts(new Date(at.getTime() - dayStartHour * 3_600_000), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** This device's own zone, as the browser reports it (not the workspace's). */
export function deviceTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** Minutes east of UTC that `timeZone` is at `at`. */
export function zoneOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  const p = parts(at, timeZone);
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** Today's YYYY-MM-DD on the workspace clock. Anything asking "what is
 *  today" uses this, not the browser's calendar. */
export function todayId(now: Date = new Date(), timeZone: string | undefined = workspaceTimeZone(), dayStartHour: number = workspaceDayStartHour()): string {
  return dateIdAt(now, timeZone, dayStartHour);
}

/** "YYYY-MM-DD HH:MM" of an instant in the workspace's zone (stamps, templates). */
export function dateTimeId(at: Date = new Date(), timeZone: string | undefined = workspaceTimeZone()): string {
  const p = parts(at, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Day arithmetic is @onden/markdown's (pure UTC calendar math, the one copy the
// server's localDay.ts re-exports too); this file owns which day "today" is.
export { addDays, daysBetween } from "@onden/markdown";

/** Now as YYYY-MM-DDTHH:MM:SS in the workspace's zone (compares with a timed due). */
export function nowDateTimeId(now: Date = new Date(), timeZone: string | undefined = workspaceTimeZone()): string {
  const p = parts(now, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** Today (YYYY-MM-DD, the workspace's day: it starts at its start hour) and the wall clock (HH:MM) in
 *  the workspace's zone: what a typed reading of "tomorrow 3pm" is made against (parseTaskInput). */
export function dayAndClock(now: Date = new Date()): { today: string; nowTime: string } {
  const time = nowDateTimeId(now).split("T")[1] ?? "";
  return { today: todayId(now), nowTime: time.split(":", 2).join(":") };
}

/** YYYY-MM of a calendar month (`month` counts from 0, like Date). */
export function monthId(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}
