// A task due "today" is on the agenda whatever the hour. The review-extract e2e once failed at 20:40–21:10 UTC looking
// for the study task (due on the workspace's today) in the agenda; this pins that the agenda's day rule cannot lose an
// open task at any instant of a UTC day or across a workspace day boundary, in any zone or day-start hour.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect } from "vitest";
import { q } from "../db.js";
import { taskBucketCaseSql } from "../services/tasksStore.js";
import { localDayId, type DayClock } from "../localDay.js";
import { addDays } from "@onden/markdown";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const CLOCKS: DayClock[] = [
  { timeZone: "UTC", dayStartHour: 0 },
  { timeZone: "Asia/Taipei", dayStartHour: 0 },
  { timeZone: "Asia/Taipei", dayStartHour: 4 },
  { timeZone: "America/Los_Angeles", dayStartHour: 0 },
  { timeZone: "Pacific/Kiritimati", dayStartHour: 6 },
];
// Every half hour of 2026-11-18 UTC, plus the instants around the e2e failures (20:40–21:10) and the day edges.
const INSTANTS = Array.from({ length: 48 }, (_, i) => new Date(Date.UTC(2026, 10, 18, Math.floor(i / 2), (i % 2) * 30)));

async function bucketsAt(clock: DayClock, at: Date, whens: string[]): Promise<string[]> {
  const rule = taskBucketCaseSql(localDayId(at, clock)); // the agenda's call, with the clock handed in instead of read from the wall
  const rows = await q<{ i: number; bucket: string }>(
    `SELECT c.i, ${rule} AS bucket
       FROM jsonb_to_recordset($1::jsonb) AS c(i int, status text, "when" text)
       CROSS JOIN LATERAL (SELECT c.status AS value) s
       CROSS JOIN LATERAL (SELECT c."when" AS value) w
       CROSS JOIN LATERAL (SELECT NULL::text AS value) sd
      ORDER BY c.i`,
    [JSON.stringify(whens.map((when, i) => ({ i, status: "todo", when })))],
  );
  return rows.rows.map((r) => r.bucket);
}

describe.skipIf(!isTestDb)("agenda day rule across the day (server)", () => {
  for (const clock of CLOCKS) {
    it(`an open task due the workspace's today is in 'today', and no day falls outside the agenda (${clock.timeZone}, day starts ${clock.dayStartHour}h)`, async () => {
      for (const at of INSTANTS) {
        const today = localDayId(at, clock);
        const whens = [-9, -1, 0, 1, 7, 8, 30].map((n) => addDays(today, n));
        const buckets = await bucketsAt(clock, at, whens);
        expect(buckets, `${at.toISOString()} ${clock.timeZone}`).toEqual(["overdue", "overdue", "today", "upcoming", "upcoming", "scheduled", "scheduled"]);
      }
    });
  }
});
