// Generators and reference helpers for the calendar-day property tests
// (properties/localDayAgreement.property*.test.ts).

import fc from "fast-check";

// Asia/Kolkata and Asia/Kathmandu are the names stored (the ICU ones, Asia/Calcutta and Asia/Katmandu, are renamed on the way in).
export const ZONES = [
  "UTC", "Asia/Taipei", "Asia/Kolkata", "Asia/Kathmandu", "America/Sao_Paulo", "America/New_York", "America/St_Johns",
  "Europe/London", "Europe/Berlin", "Australia/Lord_Howe", "Pacific/Auckland", "Pacific/Apia", "America/Santiago", "Africa/Casablanca",
];
export const zoneArb = fc.constantFrom(...ZONES);
export const startHourArb = fc.integer({ min: 0, max: 6 });
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** A random instant, or one within a few ms of a UTC midnight / a guessed local midnight / a DST-ish date. */
export const instantArb = fc.oneof(
  fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2031, 0, 1) }),
  fc.tuple(fc.integer({ min: 18_262, max: 22_000 }), fc.integer({ min: -14, max: 14 }), fc.integer({ min: -3, max: 3 }))
    .map(([day, hours, ms]) => day * DAY + hours * HOUR + ms),
  fc.tuple(fc.integer({ min: 2021, max: 2030 }), fc.constantFrom(2, 3, 9, 10, 11), fc.integer({ min: 1, max: 31 }), fc.integer({ min: -6, max: 6 }), fc.integer({ min: -2, max: 2 }))
    .map(([y, m, d, hours, ms]) => Date.UTC(y, m, d) + hours * HOUR + ms),
);

const formats = new Map<string, Intl.DateTimeFormat>();
function wall(at: number, timeZone: string): { day: string; ms: number } {
  let format = formats.get(timeZone);
  if (!format) formats.set(timeZone, format = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }));
  const p = Object.fromEntries(format.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, ms: Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) };
}
/** Independent reference: the day of (instant − start hours) on the wall clock. */
export const referenceDay = (at: number, timeZone: string, startHour: number): string => wall(at - startHour * HOUR, timeZone).day;

const offsetMin = (at: number, timeZone: string): number => (wall(at, timeZone).ms - Math.floor(at / 1000) * 1000) / 60_000;
/** Whether the zone's UTC offset changes anywhere in [from − 2 days, from + 1 day]. */
export function offsetChangesNear(from: number, timeZone: string): boolean {
  const base = offsetMin(from - 2 * DAY, timeZone);
  for (let t = from - 2 * DAY; t <= from + DAY; t += 6 * HOUR) if (offsetMin(t, timeZone) !== base) return true;
  return false;
}

