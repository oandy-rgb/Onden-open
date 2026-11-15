// Where a day sits on the clock, for the 日子 page's timeline. A day is not
// always 00:00–24:00: the workspace's day start hour (Settings › Time; 4 means
// 02:00 still belongs to the day before) moves its edges, and a daylight-saving
// day is 23 or 25 hours long. So the window is two instants computed in the
// workspace's zone, and everything on the timeline is measured from the first.

import { addDays, isClockTime, type DayWindow } from "@onden/markdown";
import { dateTimeId, deviceTimeZone, workspaceDayStartHour, workspaceTimeZone, zoneOffsetMinutes } from "./localDate";

/** The instant (ms) at which the wall clock of `zone` reads `date` + `hour:minute`. */
function wallInstant(date: string, hour: number, minute: number, zone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const wall = Date.UTC(year!, month! - 1, day!, hour, minute);
  // The offset depends on the instant being asked for, so settle it in two steps.
  const first = wall - zoneOffsetMinutes(zone, new Date(wall)) * 60_000;
  return wall - zoneOffsetMinutes(zone, new Date(first)) * 60_000;
}

function zoneOf(timeZone: string | undefined): string {
  return timeZone ?? workspaceTimeZone() ?? deviceTimeZone();
}

/** The window of the workspace day `date`: from its start hour to the next day's. */
export function dayWindow(date: string, timeZone?: string, dayStartHour: number = workspaceDayStartHour()): DayWindow {
  const zone = zoneOf(timeZone);
  return {
    startMs: wallInstant(date, dayStartHour, 0, zone),
    endMs: wallInstant(addDays(date, 1), dayStartHour, 0, zone),
  };
}

/** The ISO instant of a wall-clock `HH:MM` that belongs to the workspace day
 *  `date`. With a day start of 4, "01:30" on the 30th is the early hours of the
 *  31st: still the 30th's day. null when `time` is not HH:MM. */
export function clockInstant(date: string, time: string, timeZone?: string, dayStartHour: number = workspaceDayStartHour()): string | null {
  if (!isClockTime(time)) return null;
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const calendarDate = hour < dayStartHour ? addDays(date, 1) : date;
  return new Date(wallInstant(calendarDate, hour, minute, zoneOf(timeZone))).toISOString();
}

/** "HH:MM" of an instant on the workspace's wall clock. */
export function clockLabel(instant: string, timeZone?: string): string {
  return dateTimeId(new Date(instant), zoneOf(timeZone)).slice(11);
}
