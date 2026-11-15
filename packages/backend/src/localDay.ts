// The workspace's calendar day. Everything that asks "what is today" — task due
// dates and recurrence, the agenda buckets, the day lens, `$today`, History's
// day cuts, the review module's new-cards-per-day budget — goes through the ONE
// clock here: a time zone (IANA name, e.g. Asia/Taipei) and an hour the day
// starts at (0–6; 4 means 02:00 still belongs to the day before).
//
// Where the clock comes from, in order: the workspace's own setting
// (workspaces.time_zone / day_start_hour, owner-set in Settings › Time,
// services/workspaceTime.ts), then ONDEN_TIMEZONE, then UTC. The setting is
// loaded at boot and replaced the moment it changes; other instances pick it up
// from the periodic reload.
//
// Postgres sessions stay on UTC (db.ts). Day arithmetic in SQL names the zone
// and the start hour explicitly through the sql* helpers below — never
// CURRENT_DATE, LOCALTIMESTAMP or a bare timestamp→date cast — so a changed
// setting cannot be contradicted by a pooled connection that remembers the old
// zone.
//
// A day shifted by the start hour subtracts elapsed hours, so on the two days a
// year a DST jump falls inside [00:00, start hour) the cut can sit an hour off.

// Day arithmetic is the markdown package's (pure UTC calendar math); it is
// re-exported here so server code asks the clock module for every day question.
import { canonicalZoneName } from "@onden/markdown";
import { config } from "./config.js";
export { addDays, daysBetween } from "@onden/markdown";

export type DayClock = { timeZone: string; dayStartHour: number };

export const MAX_DAY_START_HOUR = 6;

// Intl.supportedValuesOf lists the pre-rename ids (Asia/Calcutta, Europe/Kiev) that a database built from
// current tzdata may not know, so the list is the modern names (canonicalZoneName).
const zoneNames: Set<string> = new Set([...Intl.supportedValuesOf("timeZone").map(canonicalZoneName), "UTC"]);

/** The name `name` is stored under (Asia/Calcutta → Asia/Kolkata), or null when it is no zone the
 *  server lists. Only these names reach Intl and SQL; that the database knows each of them is the
 *  integration test's S5. */
export function canonicalTimeZone(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const canonical = canonicalZoneName(name);
  if (zoneNames.has(canonical)) return canonical;
  return null;
}

/** Whether `name` is an IANA zone the server knows, under its modern name or a
 *  pre-rename one (canonicalTimeZone gives the name to store). */
export function isValidTimeZone(name: unknown): name is string {
  return canonicalTimeZone(name) !== null;
}

export function isValidDayStartHour(hour: unknown): hour is number {
  return typeof hour === "number" && Number.isInteger(hour) && hour >= 0 && hour <= MAX_DAY_START_HOUR;
}

/** Every zone name a workspace may pick. */
export function supportedTimeZones(): string[] {
  return [...zoneNames].sort();
}

/** ONDEN_TIMEZONE, else UTC: what a workspace that never chose gets. An unknown
 *  name throws at startup rather than quietly running on UTC. */
export function envDefaultTimeZone(): string {
  const raw = config.str("ONDEN_TIMEZONE")?.trim();
  if (!raw) return "UTC";
  new Intl.DateTimeFormat("en-US", { timeZone: raw });
  return raw;
}

type Formatters = { day: Intl.DateTimeFormat; minute: Intl.DateTimeFormat };

function formattersFor(timeZone: string): Formatters {
  return {
    day: new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }),
    minute: new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }),
  };
}

let clock: DayClock = { timeZone: envDefaultTimeZone(), dayStartHour: 0 };
let formatters = formattersFor(clock.timeZone);

/** The clock "today" is read from right now. */
export function dayClock(): DayClock {
  return clock;
}

/** The zone the days are cut in (what `TIME_ZONE` used to be). */
export function workspaceTimeZone(): string {
  return clock.timeZone;
}

/** Replace the clock. Rejects what could not be used, so a bad value never
 *  becomes the process's zone. */
export function setDayClock(next: DayClock): void {
  if (!isValidTimeZone(next.timeZone) && next.timeZone !== envDefaultTimeZone()) throw new Error(`unknown time zone: ${next.timeZone}`);
  if (!isValidDayStartHour(next.dayStartHour)) throw new Error(`day start hour must be 0–${MAX_DAY_START_HOUR}`);
  const timeZone = canonicalTimeZone(next.timeZone) ?? next.timeZone;
  if (timeZone !== clock.timeZone) formatters = formattersFor(timeZone);
  clock = { timeZone, dayStartHour: next.dayStartHour };
}

/** Back to what an unconfigured workspace gets (tests, and a deleted setting). */
export function resetDayClock(): void {
  setDayClock({ timeZone: envDefaultTimeZone(), dayStartHour: 0 });
}

function parts(fmt: Intl.DateTimeFormat, at: Date): Record<string, string> {
  return Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
}

/** YYYY-MM-DD of `at` on the workspace clock: wall time in the zone, less the
 *  start hour. `clockOverride` answers for a clock that is not the current one. */
export function localDayId(at: Date = new Date(), clockOverride?: DayClock): string {
  const c = clockOverride ?? clock;
  const fmt = clockOverride && clockOverride.timeZone !== clock.timeZone ? formattersFor(c.timeZone).day : formatters.day;
  const part = parts(fmt, new Date(at.getTime() - c.dayStartHour * 3_600_000));
  return `${part.year}-${part.month}-${part.day}`;
}

/** "YYYY-MM-DD HH:MM" of `at` in the zone — a template's `{datetime}`. This is
 *  the wall clock, not shifted by the start hour: it says what time it is, while
 *  `{date}` says which day the workspace counts it in. */
export function localDateTimeId(at: Date = new Date()): string {
  const part = parts(formatters.minute, at);
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}`;
}

// ── SQL ─────────────────────────────────────────────────────────────────────
// The zone is interpolated, not bound, because `AT TIME ZONE $1` inside a
// larger expression is awkward to thread through callers' positional params.
// It is safe only because every value that reaches `clock` was checked against
// the IANA list (or is ONDEN_TIMEZONE, which Intl accepted); the regex below is
// the second lock on the same door.

function zoneLiteral(): string {
  if (!/^[A-Za-z0-9_+\-/]+$/.test(clock.timeZone)) throw new Error("unsafe time zone name");
  return `'${clock.timeZone}'`;
}

const startInterval = () => `interval '${clock.dayStartHour} hours'`;

/** SQL `date` of the timestamptz expression `ts` on the workspace clock. */
export function sqlLocalDate(ts: string): string {
  return `((${ts} AT TIME ZONE ${zoneLiteral()}) - ${startInterval()})::date`;
}

/** SQL text 'YYYY-MM-DD' of `ts` on the workspace clock. */
export function sqlLocalDay(ts: string): string {
  return `to_char(${sqlLocalDate(ts)}, 'YYYY-MM-DD')`;
}

/** SQL timestamptz at which the day `dateExpr` (a `date` expression) begins. */
export function sqlDayStart(dateExpr: string): string {
  return `((${dateExpr})::timestamp + ${startInterval()}) AT TIME ZONE ${zoneLiteral()}`;
}

/** The first instant of the workspace day `day` (YYYY-MM-DD): when "tomorrow"
 *  begins for a card put off until then. Found by search, so it holds across
 *  daylight-saving changes and a late day-start hour. */
export function dayStartInstant(day: string): Date {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const noon = Date.UTC(year, month - 1, date, 12);
  // The day's first instant lies within a day and a half of its UTC noon.
  let low = noon - 36 * 3_600_000, high = noon + 36 * 3_600_000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (localDayId(new Date(mid)) >= day) high = mid; else low = mid;
  }
  return new Date(high);
}
