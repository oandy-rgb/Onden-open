import { describe, it, expect } from "vitest";
import { expandCalendar, NotCalendarError } from "./ical.js";

const wrap = (body: string, head = "") => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n${head}${body}END:VCALENDAR\r\n`;
const range = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-03-31T23:59:59Z") };

describe("expandCalendar", () => {
  it("rejects text that is not a calendar", () => {
    expect(() => expandCalendar("<html>hi</html>", range)).toThrow(NotCalendarError);
  });

  it("reads a UTC event and keeps the instant", () => {
    const [e] = expandCalendar(wrap("BEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260105T090000Z\r\nDTEND:20260105T100000Z\r\nSUMMARY:Standup\r\nLOCATION:Room 2\r\nDESCRIPTION:Line one\\nLine two\r\nEND:VEVENT\r\n"), range);
    expect(e).toMatchObject({ title: "Standup", location: "Room 2", description: "Line one\nLine two", allDay: false, startsAt: "2026-01-05T09:00:00.000Z", endsAt: "2026-01-05T10:00:00.000Z" });
  });

  it("resolves a VTIMEZONE and a named zone to the right instant", () => {
    const tz = "BEGIN:VTIMEZONE\r\nTZID:Asia/Taipei\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0800\r\nTZOFFSETTO:+0800\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n";
    const [e] = expandCalendar(wrap("BEGIN:VEVENT\r\nUID:tz\r\nDTSTAMP:20260101T000000Z\r\nDTSTART;TZID=Asia/Taipei:20260110T230000\r\nDTEND;TZID=Asia/Taipei:20260111T010000\r\nSUMMARY:Late\r\nEND:VEVENT\r\n", tz), range);
    // 23:00 in Taipei is 15:00 UTC; the event crosses local midnight.
    expect(e!.startsAt).toBe("2026-01-10T15:00:00.000Z");
    expect(e!.endsAt).toBe("2026-01-10T17:00:00.000Z");
  });

  it("keeps an all-day event as dates, whatever the server zone", () => {
    const [e] = expandCalendar(wrap("BEGIN:VEVENT\r\nUID:d\r\nDTSTAMP:20260101T000000Z\r\nDTSTART;VALUE=DATE:20260120\r\nDTEND;VALUE=DATE:20260122\r\nSUMMARY:Trip\r\nEND:VEVENT\r\n"), range);
    expect(e).toMatchObject({ allDay: true, startDate: "2026-01-20", endDate: "2026-01-22" });
  });

  it("gives a one-day all-day event with no end its own day", () => {
    const [e] = expandCalendar(wrap("BEGIN:VEVENT\r\nUID:d1\r\nDTSTAMP:20260101T000000Z\r\nDTSTART;VALUE=DATE:20260120\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\n"), range);
    expect(e).toMatchObject({ allDay: true, startDate: "2026-01-20", endDate: "2026-01-21" });
  });

  it("expands a repeat, drops an EXDATE and applies a single-occurrence change", () => {
    const body = [
      "BEGIN:VEVENT", "UID:r", "DTSTAMP:20260101T000000Z", "DTSTART:20260105T090000Z", "DTEND:20260105T100000Z",
      "RRULE:FREQ=WEEKLY;COUNT=4", "EXDATE:20260112T090000Z", "SUMMARY:Weekly", "END:VEVENT",
      "BEGIN:VEVENT", "UID:r", "DTSTAMP:20260101T000000Z", "RECURRENCE-ID:20260119T090000Z", "DTSTART:20260119T130000Z", "DTEND:20260119T140000Z", "SUMMARY:Weekly (moved)", "END:VEVENT",
    ].join("\r\n") + "\r\n";
    const got = expandCalendar(wrap(body), range);
    expect(got.map((g) => [g.title, g.startsAt])).toEqual([
      ["Weekly", "2026-01-05T09:00:00.000Z"],
      ["Weekly (moved)", "2026-01-19T13:00:00.000Z"],
      ["Weekly", "2026-01-26T09:00:00.000Z"],
    ]);
  });

  it("drops a cancelled event and a cancelled occurrence", () => {
    const body = [
      "BEGIN:VEVENT", "UID:c", "DTSTAMP:20260101T000000Z", "DTSTART:20260105T090000Z", "STATUS:CANCELLED", "SUMMARY:Gone", "END:VEVENT",
      "BEGIN:VEVENT", "UID:c2", "DTSTAMP:20260101T000000Z", "DTSTART:20260105T090000Z", "RRULE:FREQ=DAILY;COUNT=2", "SUMMARY:Daily", "END:VEVENT",
      "BEGIN:VEVENT", "UID:c2", "DTSTAMP:20260101T000000Z", "RECURRENCE-ID:20260106T090000Z", "DTSTART:20260106T090000Z", "STATUS:CANCELLED", "SUMMARY:Daily", "END:VEVENT",
    ].join("\r\n") + "\r\n";
    expect(expandCalendar(wrap(body), range).map((g) => g.title)).toEqual(["Daily"]);
  });

  it("leaves out events outside the range and keeps one still running into it", () => {
    const body = [
      "BEGIN:VEVENT", "UID:o1", "DTSTAMP:20260101T000000Z", "DTSTART:20250601T090000Z", "DTEND:20250601T100000Z", "SUMMARY:Old", "END:VEVENT",
      "BEGIN:VEVENT", "UID:o2", "DTSTAMP:20260101T000000Z", "DTSTART:20251231T220000Z", "DTEND:20260101T020000Z", "SUMMARY:Overnight", "END:VEVENT",
    ].join("\r\n") + "\r\n";
    expect(expandCalendar(wrap(body), range).map((g) => g.title)).toEqual(["Overnight"]);
  });
});
