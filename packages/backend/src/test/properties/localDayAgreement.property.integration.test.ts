// The SQL half of "which day is it": the helpers History, the agenda and the
// day lens build their queries from (localDay.ts sqlLocalDay / sqlLocalDate /
// sqlDayStart) against the JS clock and the frontend's lib/localDate.ts.
//
// Invariants, for any instant, IANA zone and day start hour 0–6:
//  S1  sqlLocalDay(t) = sqlLocalDate(t) = localDayId(t) = frontend dateIdAt(t).
//  S2  sqlDayStart(d) is on day d, and 1 ms earlier is on day d−1.
//  S3  sqlDayStart(d+1) − 1 ms (History's `end_at`, the only end-of-day the frontend uses) is in d; +1 ms is d+1.
//  S4  days do not overlap and leave no gap: an instant lies in
//      [sqlDayStart(day), sqlDayStart(day+1)) for exactly its own day.
// S2–S4 skip the documented one-hour slack around a DST jump with a day start
// hour > 0 (see localDayAgreement.property.test.ts).
//  S5  every zone the server accepts (supportedTimeZones, i.e. Intl's list) is a zone
//      the database knows, or a History query for a workspace set to it fails with
//      SQLSTATE 22023. S1–S4 draw from the zones in ZONES that the database knows,
//      and S5 names the ones it does not.
//
// SAFETY: skips unless DATABASE_URL points at a *_test database. Needs no tables.

import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pool } from "../../db.js";
import { localDayId, resetDayClock, setDayClock, sqlDayStart, sqlLocalDate, sqlLocalDay, supportedTimeZones } from "../../localDay.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { instantArb, offsetChangesNear, startHourArb, ZONES } from "../helpers/dayGenerators.js";
import { checkAsync } from "../helpers/propsConfig.js";

type FrontendDate = {
  dateIdAt(at: Date, timeZone: string | undefined, dayStartHour: number): string;
  addDays(id: string, days: number): string;
};
const lib: FrontendDate = await import(
  pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../frontend/src/lib/localDate.ts")).href
);

afterAll(async () => { resetDayClock(); await pool.end(); });

const databaseKnows = async (names: string[]): Promise<Set<string>> =>
  new Set((await pool.query<{ name: string }>(`SELECT name FROM pg_timezone_names WHERE name = ANY($1::text[])`, [names])).rows.map((r) => r.name));

/** The zones of ZONES whose UTC offset is the same in the database's tzdata and in Node's ICU for
 *  every 3rd day of 2020–2031. Different tzdata releases (Node 2025b vs Postgres 2026e put
 *  Africa/Casablanca on different offsets) make "the same day" depend on which side answers; that is
 *  data skew, not a logic error, so such a zone is left out of S1–S4 (and named in the test title's log). */
async function zonesWithSameOffsets(candidates: string[]): Promise<string[]> {
  const from = Date.UTC(2020, 0, 1), to = Date.UTC(2031, 0, 1);
  const out: string[] = [];
  for (const zone of candidates) {
    const sql = (await pool.query<{ at: Date; off: number }>(
      `SELECT t AS at, extract(epoch FROM ((t AT TIME ZONE '${zone}') - (t AT TIME ZONE 'UTC')))::int / 60 AS off
         FROM generate_series($1::timestamptz, $2::timestamptz, interval '3 days') t`, [new Date(from), new Date(to)])).rows;
    const wall = (at: number) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
      return Math.round((Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(at / 1000) * 1000) / 60_000);
    };
    if (sql.every((r) => r.off === wall(r.at.getTime()))) out.push(zone);
    else console.warn(`[props] ${zone}: Postgres and Node disagree on its UTC offset (tzdata skew); left out of S1–S4`);
  }
  return out;
}

describe.skipIf(!isTestDatabase())("calendar day: SQL = JS = frontend", () => {
  it("S5: the database knows every zone the server accepts", async () => {
    const known = await databaseKnows(supportedTimeZones());
    // pg_timezone_names omits "UTC"-style aliases on some builds; ask the parser for those.
    const missing = supportedTimeZones().filter((z) => !known.has(z));
    const unparsable: string[] = [];
    for (const z of missing) {
      try { await pool.query(`SELECT now() AT TIME ZONE '${z}'`); } catch { unparsable.push(z); }
    }
    expect(unparsable).toEqual([]);
  });

  it("S1–S4", async () => {
    const zones = await zonesWithSameOffsets([...await databaseKnows(ZONES)]);
    zones.push("UTC");
    await checkAsync(fc.asyncProperty(instantArb, fc.constantFrom(...zones), startHourArb, async (at, zone, hour) => {
      setDayClock({ timeZone: zone, dayStartHour: hour });
      const iso = new Date(at).toISOString();
      const day = localDayId(new Date(at));
      expect(lib.dateIdAt(new Date(at), zone, hour)).toBe(day);
      const { rows: [r] } = await pool.query<{ day: string; date: string; start: Date; next_start: Date; before_start: Date }>(
        `SELECT ${sqlLocalDay("$1::timestamptz")} AS day, to_char(${sqlLocalDate("$1::timestamptz")}, 'YYYY-MM-DD') AS date,
                ${sqlDayStart("$2::date")} AS start, ${sqlDayStart("$2::date + 1")} AS next_start,
                ${sqlDayStart("$3::date")} AS before_start`,
        [iso, day, lib.addDays(day, -1)],
      );
      expect({ sqlDay: r!.day, sqlDate: r!.date }).toEqual({ sqlDay: day, sqlDate: day });

      const start = r!.start.getTime();
      const nextStart = r!.next_start.getTime();
      if (hour > 0 && offsetChangesNear(nextStart - 1, zone)) return;
      // S2
      expect(localDayId(new Date(start))).toBe(day);
      expect(localDayId(new Date(start - 1))).toBe(lib.addDays(day, -1));
      expect(r!.before_start.getTime()).toBeLessThan(start);
      // S3
      expect(lib.dateIdAt(new Date(nextStart - 1), zone, hour)).toBe(day);
      expect(lib.dateIdAt(new Date(nextStart), zone, hour)).toBe(lib.addDays(day, 1));
      // S4
      expect(at).toBeGreaterThanOrEqual(start);
      expect(at).toBeLessThan(nextStart);
    }), 300);
  }, 120_000);
});
