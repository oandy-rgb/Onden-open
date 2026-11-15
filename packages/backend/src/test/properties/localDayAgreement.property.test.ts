// Which calendar day an instant belongs to, and where a day ends, is computed in
// three places that must agree: the backend (localDay.ts localDayId), the
// frontend (lib/localDate.ts dateIdAt) and an independent reference here
// (wall clock from Intl, shifted by the day start hour). Where a day ends is
// the server's alone (History's `end_at`, SQL): `endOfDay` below only probes
// the boundary the two clocks must agree on.
// The SQL half (sqlLocalDay / sqlLocalDate / sqlDayStart) is in
// localDayAgreement.property.integration.test.ts, on the same generators.
//
// Invariants, for any instant, IANA zone and day start hour 0–6:
//  D1  localDayId (backend) = dateIdAt (frontend) = the reference day.
//  D2  endOfDay(day) is in `day`, and +1 ms is in the next day
//      (backend and frontend clocks both say so).
//  D3  the days partition time: an instant belongs to exactly the day whose
//      [endOfDay(day-1)+1ms, endOfDay(day)] range holds it — no overlap, no gap.
//  D4  the ranges are in order: endOfDay(day) < endOfDay(day+1).
//
// Known: localDay.ts says that on the two days a year a DST jump falls inside
// [00:00, start hour) the cut "can sit an hour off". D2–D4 therefore skip
// (zone, day, start hour) triples where start hour > 0 and the zone's offset
// changes within 24 h of the day's start; D1 never skips.
//
// Replay: PROPS_SEED=… PROPS_RUNS=… npx vitest run src/test/properties/localDayAgreement.property.test.ts

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalTimeZone, isValidTimeZone, localDayId, supportedTimeZones } from "../../localDay.js";
import { check } from "../helpers/propsConfig.js";

type FrontendDate = {
  dateIdAt(at: Date, timeZone: string | undefined, dayStartHour: number): string;
  addDays(id: string, days: number): string;
};
const lib: FrontendDate = await import(
  pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../frontend/src/lib/localDate.ts")).href
);

import { DAY, HOUR, instantArb, offsetChangesNear, referenceDay, startHourArb, zoneArb } from "../helpers/dayGenerators.js";

const backendDay = (at: number, timeZone: string, dayStartHour: number) => localDayId(new Date(at), { timeZone, dayStartHour });
const frontendDay = (at: number, timeZone: string, dayStartHour: number) => lib.dateIdAt(new Date(at), timeZone, dayStartHour);

/** The last millisecond of `dateId` on the clock (zone, start hour): the next day's start less 1 ms,
 *  with the zone's offset applied twice so a day with a clock change lands on its own boundary. */
function endOfDay(dateId: string, timeZone: string, dayStartHour: number): number {
  const midnightAsUtc = Date.parse(`${lib.addDays(dateId, 1)}T00:00:00Z`) + dayStartHour * HOUR;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const offsetAt = (instant: number): number => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(instant / 1000) * 1000;
  };
  let instant = midnightAsUtc;
  for (let i = 0; i < 2; i++) instant = midnightAsUtc - offsetAt(instant);
  return instant - 1;
}

describe("calendar day: backend = frontend = reference", () => {
  it("D1: the same instant is on the same day everywhere", () => {
    check(fc.property(instantArb, zoneArb, startHourArb, (at, zone, hour) => {
      const ref = referenceDay(at, zone, hour);
      expect({ backend: backendDay(at, zone, hour), frontend: frontendDay(at, zone, hour) }).toEqual({ backend: ref, frontend: ref });
    }));
  });

  it("D2–D4: a day's end is in the day, +1 ms is the next day, ranges tile time in order", () => {
    check(fc.property(instantArb, zoneArb, startHourArb, (at, zone, hour) => {
      const day = frontendDay(at, zone, hour);
      const prev = lib.addDays(day, -1);
      const next = lib.addDays(day, 1);
      const end = endOfDay(day, zone, hour);
      if (hour > 0 && offsetChangesNear(end, zone)) return; // documented one-hour slack
      for (const id of [backendDay, frontendDay]) {
        expect(id(end, zone, hour)).toBe(day);
        expect(id(end + 1, zone, hour)).toBe(next);
      }
      const prevEnd = endOfDay(prev, zone, hour);
      const nextEnd = endOfDay(next, zone, hour);
      expect(prevEnd).toBeLessThan(end);
      expect(end).toBeLessThan(nextEnd);
      // the instant itself lies in (prevEnd, end]
      expect(at).toBeGreaterThan(prevEnd);
      expect(at).toBeLessThanOrEqual(end);
      expect(backendDay(prevEnd + 1, zone, hour)).toBe(day);
    }));
  }, 120_000);
});

// Node 22's ICU names India and Nepal by their pre-rename ids (Asia/Calcutta, Asia/Katmandu). The names browsers,
// the database and the frontend's ZH_NAMES use are Asia/Kolkata and Asia/Kathmandu; both spellings are accepted
// and stored as the modern one. The same goes for the other renamed zones the ICU list still carries.
describe("zone allow-list", () => {
  it("accepts the modern names of the renamed zones, and stores the legacy spelling under them", () => {
    expect(["Asia/Kolkata", "Asia/Kathmandu"].map(isValidTimeZone)).toEqual([true, true]);
    expect(["Asia/Calcutta", "Asia/Katmandu"].map(canonicalTimeZone)).toEqual(["Asia/Kolkata", "Asia/Kathmandu"]);
    expect(canonicalTimeZone("Mars/Olympus")).toBeNull();
  });

  it("lists no pre-rename name, and every listed name is one Intl accepts", () => {
    const zones = supportedTimeZones();
    for (const legacy of ["Asia/Calcutta", "Asia/Katmandu", "Europe/Kiev", "America/Buenos_Aires"]) expect(zones).not.toContain(legacy);
    for (const z of ["Asia/Kolkata", "Asia/Kathmandu", "Europe/Kyiv", "America/Argentina/Buenos_Aires"]) expect(zones).toContain(z);
    for (const z of zones) expect(() => new Intl.DateTimeFormat("en", { timeZone: z })).not.toThrow();
  });
});
