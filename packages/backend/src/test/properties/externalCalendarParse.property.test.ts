// Random iCalendar text against the parser (modules/external_calendars/ical.ts expandCalendar).
//
// The input is built from events of five kinds (UTC, named zone, floating, all-day, and
// repeats of each with EXDATE across daylight-saving changes), written with odd line folding,
// bare-LF line ends, a byte-order mark, escaped text and non-Latin titles. The reference is
// computed here from the written wall clock and the zone (Intl), not from node-ical.
//
// The host's zone is switched with process.env.TZ between runs of the same text (the parser
// module is loaded once per zone: its all-day formatter fixes the zone when it is loaded).
//
// Invariants:
//  C1  parsing never throws anything but NotCalendarError, and never that for a well-formed
//      calendar; text cut off, or with a junk line inserted, at a random place only ever throws NotCalendarError
//      (the junk half is KNOWN to fail: one spoiled event takes the calendar down).
//  C2  UTC and named-zone events (and their repeats, minus EXDATE) come out at the instants
//      the written wall clock and zone say, whatever zone the host runs in; a repeat keeps its
//      wall time across a daylight-saving change.
//  C3  an all-day event stays on the dates written, in every host zone; a repeat steps by
//      calendar days; EXDATE removes the date it names.
//  C4  instances are within the requested window (they touch [from, to]) and sorted by start.
//  C5  titles survive folding, escaping and encodings.
//  C6  an event with no zone is read in the WORKSPACE zone, so the same text gives the same
//      instants on every host (expandCalendar's third argument; scan 10 #12).
//
// Replay: PROPS_SEED=… PROPS_RUNS=… npx vitest run src/test/properties/externalCalendarParse.property.test.ts

import { afterAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { check } from "../helpers/propsConfig.js";

type Parser = typeof import("../../modules/external_calendars/ical.js");
type Instance = ReturnType<Parser["expandCalendar"]>[number];

const HOST_ZONES = ["UTC", "Asia/Taipei", "America/New_York", "Pacific/Auckland", "America/Los_Angeles", "Europe/Berlin"] as const;
const originalTz = process.env.TZ;
const parsers = new Map<string, Parser>();
for (const zone of HOST_ZONES) {
  process.env.TZ = zone;
  vi.resetModules(); // a fresh copy per zone: the all-day formatter is built when the module loads
  parsers.set(zone, await import("../../modules/external_calendars/ical.js"));
}
if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
afterAll(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });

/** Parse `text` as a host running in `zone` would. */
function parseOn(zone: string, text: string, range: { from: Date; to: Date }, floatingZone?: string): Instance[] {
  process.env.TZ = zone;
  try { return parsers.get(zone)!.expandCalendar(text, range, floatingZone); }
  finally { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; }
}
const isNotCalendar = (e: unknown, zone: string): boolean => e instanceof parsers.get(zone)!.NotCalendarError;

// ── reference clock ──────────────────────────────────────────────────────────
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const dayId = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDaysId = (id: string, n: number) => dayId(Date.parse(`${id}T00:00:00Z`) + n * DAY);

const formats = new Map<string, Intl.DateTimeFormat>();
function wallMs(at: number, zone: string): number {
  let f = formats.get(zone);
  if (!f) formats.set(zone, f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
}
/** The instant at which `zone`'s wall clock reads `day` `minutes` after midnight (times that exist once only). */
function instantAt(day: string, minutes: number, zone: string): number {
  const asUtc = Date.parse(`${day}T00:00:00Z`) + minutes * 60_000;
  let at = asUtc;
  for (let i = 0; i < 3; i++) at = asUtc - (wallMs(at, zone) - at);
  return at;
}

// ── generators ───────────────────────────────────────────────────────────────
const ZONES = ["UTC", "Asia/Taipei", "Asia/Kolkata", "America/New_York", "Europe/Berlin", "Australia/Lord_Howe", "Pacific/Auckland", "America/Sao_Paulo"] as const;
// Days a clock change falls on in 2026 (US, EU, NZ / Lord Howe) so repeats cross one.
const DST_DAYS = ["2026-03-08", "2026-03-29", "2026-04-05", "2026-09-27", "2026-10-25", "2026-11-01"];
const dayArb = fc.oneof(
  fc.integer({ min: 0, max: 300 }).map((n) => addDaysId("2026-01-10", n)),
  fc.tuple(fc.constantFrom(...DST_DAYS), fc.integer({ min: -12, max: 3 })).map(([d, n]) => addDaysId(d, n)),
);
// Hours 5–22: a wall time inside a clock change's gap or repeat is no single instant, so it has no reference.
const minutesArb = fc.tuple(fc.integer({ min: 5, max: 22 }), fc.constantFrom(0, 15, 30, 45)).map(([h, m]) => h * 60 + m);
const wallText = (day: string, minutes: number) => `${day.replace(/-/g, "")}T${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}00`;

const TITLES = ["Standup", "週會 Weekly", "Dentist, 3rd floor; bring card", "back\\slash", "😀 launch", "Zürich ☕", "a".repeat(120), "line\nbreak", "日本語のとても長いタイトル".repeat(6), "x"];
const titleArb = fc.constantFrom(...TITLES);
const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

type Repeat = { step: number; count: number; skip: number[] };
const repeatArb: fc.Arbitrary<Repeat | null> = fc.option(fc.record({
  step: fc.constantFrom(1, 2, 3, 7, 14),
  count: fc.integer({ min: 1, max: 10 }),
  skip: fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 3 }),
}), { nil: null, freq: 2 });

type Timed = { kind: "utc" | "zoned" | "floating"; zone: string; day: string; minutes: number; length: number; repeat: Repeat | null; title: string };
type AllDay = { kind: "allday"; day: string; days: number; hasEnd: boolean; repeat: Repeat | null; title: string };
type Spec = Timed | AllDay;

const timedArb = (kinds: Array<Timed["kind"]>): fc.Arbitrary<Timed> => fc.record({
  kind: fc.constantFrom(...kinds), zone: fc.constantFrom(...ZONES), day: dayArb, minutes: minutesArb,
  length: fc.constantFrom(0, 30, 60, 90, 180), repeat: repeatArb, title: titleArb,
});
const allDayArb: fc.Arbitrary<AllDay> = fc.record({
  kind: fc.constant("allday" as const), day: dayArb, days: fc.integer({ min: 1, max: 4 }), hasEnd: fc.boolean(), repeat: repeatArb, title: titleArb,
});

// ── writing ICS ──────────────────────────────────────────────────────────────
type Fold = "none" | "crlf-space" | "crlf-tab" | "lf-space";
/** RFC 5545 folds a line at 75 octets with CRLF + one space or tab; here by characters, and sometimes a bare LF. */
function fold(line: string, mode: Fold): string {
  if (mode === "none") return line;
  const chars = [...line];
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += 60) parts.push(chars.slice(i, i + 60).join(""));
  const join = mode === "crlf-space" ? "\r\n " : mode === "crlf-tab" ? "\r\n\t" : "\n ";
  return parts.join(join);
}

type Written = { text: string; expected: Array<{ spec: Spec; uid: string }> };
function writeCalendar(specs: Spec[], opts: { fold: Fold; eol: "\r\n" | "\n"; bom: boolean }): Written {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//props//EN"];
  specs.forEach((spec, i) => {
    const uid = `uid-${i}@props`;
    lines.push("BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z");
    const rule = spec.repeat ? `RRULE:FREQ=DAILY;INTERVAL=${spec.repeat.step};COUNT=${spec.repeat.count}` : null;
    if (spec.kind === "allday") {
      lines.push(`DTSTART;VALUE=DATE:${spec.day.replace(/-/g, "")}`);
      if (spec.hasEnd) lines.push(`DTEND;VALUE=DATE:${addDaysId(spec.day, spec.days).replace(/-/g, "")}`);
      if (rule) lines.push(rule);
      for (const k of spec.repeat?.skip ?? []) lines.push(`EXDATE;VALUE=DATE:${addDaysId(spec.day, k * spec.repeat!.step).replace(/-/g, "")}`);
    } else {
      const text = wallText(spec.day, spec.minutes);
      const endText = (day: string) => {
        const end = spec.minutes + spec.length;
        return wallText(addDaysId(day, Math.floor(end / 1440)), end % 1440);
      };
      const withZone = (v: string) => spec.kind === "zoned" ? `;TZID=${spec.zone}:${v}` : spec.kind === "utc" ? `:${v}Z` : `:${v}`;
      lines.push(`DTSTART${withZone(text)}`);
      if (spec.length > 0) lines.push(`DTEND${withZone(endText(spec.day))}`);
      if (rule) lines.push(rule);
      for (const k of spec.repeat?.skip ?? []) lines.push(`EXDATE${withZone(wallText(addDaysId(spec.day, k * spec.repeat!.step), spec.minutes))}`);
    }
    lines.push(`SUMMARY:${escapeText(spec.title)}`, "END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  const body = lines.map((l) => fold(l, opts.fold)).join(opts.eol) + opts.eol;
  return { text: (opts.bom ? "\uFEFF" : "") + body, expected: specs.map((spec, i) => ({ spec, uid: `uid-${i}@props` })) };
}

const foldArb = fc.constantFrom<Fold>("none", "crlf-space", "crlf-tab", "lf-space");
const formArb = fc.record({ fold: foldArb, eol: fc.constantFrom<"\r\n" | "\n">("\r\n", "\n"), bom: fc.boolean() });

// The window refresh.ts asks for: whole UTC days, 00:00:00Z of the first to 23:59:59Z of the last.
// (A window ending at some other instant makes an all-day event on its last day come or go with the host's zone.)
const rangeArb = fc.tuple(fc.integer({ min: 0, max: 330 }), fc.integer({ min: 3, max: 120 })).map(([from, len]) => ({
  from: new Date(`${addDaysId("2026-01-01", from)}T00:00:00Z`),
  to: new Date(`${addDaysId("2026-01-01", from + len)}T23:59:59Z`),
}));
const hostPairArb = fc.tuple(fc.constantFrom(...HOST_ZONES), fc.constantFrom(...HOST_ZONES)).filter(([a, b]) => a !== b);

// ── expectations ─────────────────────────────────────────────────────────────
/** Start days of the occurrences the repeat leaves (EXDATE out). */
function occurrenceDays(spec: Spec): string[] {
  const n = spec.repeat ? spec.repeat.count : 1;
  const step = spec.repeat ? spec.repeat.step : 0;
  const skipped = new Set(spec.repeat?.skip ?? []);
  return Array.from({ length: n }, (_, k) => k).filter((k) => !skipped.has(k)).map((k) => addDaysId(spec.day, k * step));
}
const touches = (startMs: number, endMs: number, range: { from: Date; to: Date }) => startMs <= range.to.getTime() && endMs >= range.from.getTime();

/** What the instances of one event must be, as `${instant}` for timed events. */
function expectedTimed(spec: Timed, zone: string, range: { from: Date; to: Date }): string[] {
  const out: string[] = [];
  for (const day of occurrenceDays(spec)) {
    const start = instantAt(day, spec.minutes, zone);
    const end = instantAt(addDaysId(day, Math.floor((spec.minutes + spec.length) / 1440)), (spec.minutes + spec.length) % 1440, zone);
    if (touches(start, end, range)) out.push(new Date(start).toISOString());
  }
  return out;
}
/** Dates an all-day event must show on, and those it may show on: an event whose exclusive end is exactly the window's first
 *  instant touches it only by the library's `>=`, and whether the host's zone puts that midnight inside is not a promise. */
function expectedAllDay(spec: AllDay, range: { from: Date; to: Date }): { must: string[]; may: string[] } {
  const length = spec.hasEnd ? spec.days : 1;
  const runs = occurrenceDays(spec).map((day) => ({ run: `${day}..${addDaysId(day, length)}`, start: Date.parse(`${day}T00:00:00Z`), end: Date.parse(`${addDaysId(day, length)}T00:00:00Z`) }));
  const inside = runs.filter((r) => touches(r.start, r.end, range));
  return { must: inside.filter((r) => r.end > range.from.getTime()).map((r) => r.run), may: inside.map((r) => r.run) };
}

const instancesOf = (all: Instance[], uid: string) => all.filter((i) => i.key.startsWith(`${uid}|`));
const describeCase = (text: string) => `ICS:\n${JSON.stringify(text)}`;

describe("external calendar parser (random iCalendar text)", () => {
  it("C1 + C4: parsing a well-formed calendar never throws, and instances are in the window, sorted", () => {
    check(fc.property(
      fc.array(fc.oneof(timedArb(["utc", "zoned", "floating"]), allDayArb), { minLength: 1, maxLength: 5 }), formArb, rangeArb, fc.constantFrom(...HOST_ZONES),
      (specs, form, range, host) => {
        const { text } = writeCalendar(specs, form);
        const got = parseOn(host, text, range);
        const starts = got.map((i) => i.startsAt);
        expect(starts, `sorted by start\n${describeCase(text)}`).toEqual([...starts].sort());
        for (const i of got) {
          expect(Date.parse(i.startsAt), describeCase(text)).toBeLessThanOrEqual(range.to.getTime());
          expect(Date.parse(i.endsAt), describeCase(text)).toBeGreaterThanOrEqual(range.from.getTime());
          expect(Date.parse(i.endsAt)).toBeGreaterThanOrEqual(Date.parse(i.startsAt));
        }
      },
    ), 300);
  });

  const asCalendar = (events: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//props//EN\r\n${events}END:VCALENDAR\r\n`;
  const spoilArb = (hows: Array<"cut" | "junk">) => fc.oneof(
    ...hows.map((how) => how === "cut"
      ? fc.record({ how: fc.constant("cut" as const), at: fc.double({ min: 0, max: 1, noNaN: true }), junk: fc.constant(""), inValue: fc.constant(false) })
      : fc.record({ how: fc.constant("junk" as const), at: fc.double({ min: 0, max: 1, noNaN: true }), inValue: fc.boolean(), junk: fc.constantFrom("\0", "BEGIN:VEVENT", "END:VEVENT", "DTSTART:garbage", "RRULE:FREQ=NEVER", "EXDATE:", ":::", "\uD800", " ", "DTSTART;TZID=Mars/Olympus:20260101T090000", "RRULE:FREQ=DAILY;COUNT=99999999") })),
  );
  const spoilProperty = (hows: Array<"cut" | "junk">) => check(fc.property(
    fc.array(fc.oneof(timedArb(["utc", "zoned", "floating"]), allDayArb), { minLength: 1, maxLength: 4 }), formArb, rangeArb, fc.constantFrom(...HOST_ZONES), spoilArb(hows),
    (specs, form, range, host, spoil) => {
      const { text } = writeCalendar(specs, form);
      let at = Math.floor(spoil.at * text.length);
      // Half the junk lands inside a DTSTART value (a line broken in transit), the rest anywhere.
      const starts = [...text.matchAll(/DTSTART/g)].map((m) => m.index!);
      if (spoil.how === "junk" && spoil.inValue && starts.length > 0) at = starts[Math.floor(spoil.at * starts.length)]! + 9 + (Math.floor(spoil.at * 1000) % 4);
      const spoiled = spoil.how === "cut" ? text.slice(0, at) : `${text.slice(0, at)}\n${spoil.junk}\n${text.slice(at)}`;
      try { parseOn(host, spoiled, range); }
      catch (error) { expect(isNotCalendar(error, host), `${(error as Error)?.stack}\n${describeCase(spoiled)}`).toBe(true); }
    },
  ), 300);

  it("C1: text cut off at a random place throws only NotCalendarError", () => { spoilProperty(["cut"]); });

  // KNOWN (C1). One event whose DTSTART is not a date ("DTSTART:2", a line cut or mangled in transit) makes
  // node-ical hand back a start that is not a Date, and ical.ts expandCalendar calls `.getTime()` on it
  // (the `Number.isNaN(event.start.getTime())` guard) — a TypeError, which is not NotCalendarError and is outside
  // the per-event try/catch below it ("one broken rule must not hide the rest of the calendar"). fetchCalendar
  // then answers "not_calendar" for the whole calendar and the good events are lost.
  // Turns red the day it is fixed: change `it.fails` to `it`.
  describe("C1 one spoiled event does not take the calendar with it", () => {
    it.fails("random junk lines inside a calendar throw only NotCalendarError", () => { spoilProperty(["junk"]); });
    it.fails("named case: DTSTART:2 on one event, a good event beside it", () => {
      const good = "BEGIN:VEVENT\r\nUID:good\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260110T050000Z\r\nSUMMARY:good\r\nEND:VEVENT\r\n";
      const bad = "BEGIN:VEVENT\r\nUID:bad\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:2\r\nSUMMARY:bad\r\nEND:VEVENT\r\n";
      const got = parseOn("UTC", asCalendar(good + bad), { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-31T23:59:59Z") });
      expect(got.map((i) => i.title)).toEqual(["good"]);
    });
  });

  it("C2 + C5: UTC and named-zone events (repeats, EXDATE, folding, titles) come out at the written instants on any host", () => {
    check(fc.property(
      fc.array(timedArb(["utc", "zoned"]), { minLength: 1, maxLength: 4 }), formArb, rangeArb, hostPairArb,
      (specs, form, range, [hostA, hostB]) => {
        const { text, expected } = writeCalendar(specs, form);
        for (const host of [hostA, hostB]) {
          const got = parseOn(host, text, range);
          for (const { spec, uid } of expected as Array<{ spec: Timed; uid: string }>) {
            const zone = spec.kind === "utc" ? "UTC" : spec.zone;
            const mine = instancesOf(got, uid);
            expect(mine.map((i) => i.startsAt).sort(), `host ${host}, zone ${zone}\n${describeCase(text)}`).toEqual(expectedTimed(spec, zone, range).sort());
            for (const i of mine) {
              expect(i.title, `title, host ${host}`).toBe(spec.title.trim());
              expect(i.allDay).toBe(false);
            }
          }
        }
      },
    ), 300);
  });

  it("C3: an all-day event stays on its dates in every host zone", () => {
    check(fc.property(
      fc.array(allDayArb, { minLength: 1, maxLength: 4 }), formArb, rangeArb, hostPairArb,
      (specs, form, range, [hostA, hostB]) => {
        const { text, expected } = writeCalendar(specs, form);
        for (const host of [hostA, hostB]) {
          const got = parseOn(host, text, range);
          for (const { spec, uid } of expected as Array<{ spec: AllDay; uid: string }>) {
            const mine = instancesOf(got, uid);
            expect(mine.every((i) => i.allDay), `allDay flag, host ${host}`).toBe(true);
            const runs = mine.map((i) => `${i.startDate}..${i.endDate}`);
            const { must, may } = expectedAllDay(spec, range);
            expect(runs.sort(), `host ${host}\n${describeCase(text)}`).toEqual(expect.arrayContaining(must));
            expect(may, `host ${host}: no date written was moved\n${describeCase(text)}`).toEqual(expect.arrayContaining(runs));
          }
        }
      },
    ), 300);
  });

  // Fixed (C6, scan 10 #12). An event with no zone ("floating": DTSTART:20260310T090000) means the wall clock
  // wherever the owner is; in Onden that is the workspace's zone. expandCalendar takes the workspace zone and
  // re-reads the parser's host-zone reading of such a time in it, so the same text gives the same instants on
  // every host. (A wall time a clock change skips in either zone has no instant to compare: such a case is left out.)
  describe("C6 floating times are read in the workspace zone, not the host's", () => {
    const wallExists = (day: string, minutes: number, zone: string) => wallMs(instantAt(day, minutes, zone), zone) === Date.parse(`${day}T00:00:00Z`) + minutes * 60_000;
    const usable = (spec: Timed, zones: string[]) => occurrenceDays(spec).every((day) => zones.every((zone) =>
      wallExists(day, spec.minutes, zone) && wallExists(addDaysId(day, Math.floor((spec.minutes + spec.length) / 1440)), (spec.minutes + spec.length) % 1440, zone)));

    it("random floating events come out at the written wall clock of the workspace zone, on any host", () => {
      check(fc.property(
        fc.array(timedArb(["floating"]), { minLength: 1, maxLength: 3 }), formArb, hostPairArb, fc.constantFrom(...ZONES),
        (specs, form, [hostA, hostB], workspace) => {
          const range = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2027-01-31T00:00:00Z") };
          const { text, expected } = writeCalendar(specs, form);
          for (const host of [hostA, hostB]) {
            const got = parseOn(host, text, range, workspace);
            for (const { spec, uid } of expected as Array<{ spec: Timed; uid: string }>) {
              if (!usable(spec, [host, workspace])) continue;
              expect(instancesOf(got, uid).map((i) => i.startsAt).sort(), `host ${host}, workspace ${workspace}\n${describeCase(text)}`).toEqual(expectedTimed(spec, workspace, range).sort());
            }
          }
        },
      ), 300);
    });

    // Minimal case. Workspace zone Asia/Taipei: "09:00 on 2026-03-10" is 01:00Z, whatever zone the host runs in.
    it("named case: DTSTART:20260310T090000 (no zone) is 09:00 in the workspace zone on a UTC host and a New York host", () => {
      const text = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:float\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260310T090000\r\nDTEND:20260310T100000\r\nSUMMARY:floating\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
      const range = { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-03-31T00:00:00Z") };
      for (const host of ["UTC", "America/New_York", "Asia/Taipei"]) expect(parseOn(host, text, range, "Asia/Taipei").map((i) => [i.startsAt, i.endsAt]), host).toEqual([["2026-03-10T01:00:00.000Z", "2026-03-10T02:00:00.000Z"]]);
    });
  });
});
