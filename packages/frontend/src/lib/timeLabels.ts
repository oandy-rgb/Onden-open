// The app's one time formatter (depth audit D46). Every date or time the app
// UI shows goes through here: the language is the app UI's (lib/i18n
// getLocale) and the zone is the workspace's (lib/localDate
// workspaceTimeZone), the zone the server buckets days in — so "Today" in a
// list is the same day as the agenda's today, whatever the browser's zone.
// The published site formats its own dates (components/templates/siteLocale.ts,
// in the site's language and zone). eslint-rules/time-through-labels.js keeps
// bare toLocale*String / Intl.DateTimeFormat calls out of everything else.
import { getLocale, t } from "./i18n";
import { dateIdAt, daysBetween, workspaceTimeZone } from "./localDate";

/** The fixed date/time shapes the app shows:
 *  - short          "Oct 5"
 *  - medium         "Oct 5, 2026"
 *  - long           "October 5, 2026"
 *  - numeric        "10/5/2026"
 *  - shortDateTime  "Oct 5, 03:04 PM"
 *  - dateTime       "10/5/2026, 3:04:05 PM"
 *  - month          "Oct" (zh-TW "10月")
 *  - weekdayShort   "Fri" (zh-TW "週五")
 *  - dayOnly        "5" (zh-TW "5日") */
export type DateStyle = "short" | "medium" | "long" | "numeric" | "shortDateTime" | "dateTime" | "month" | "weekdayShort" | "dayOnly" | "monthDay";

const STYLES: Record<DateStyle | "time" | "weekday" | "clock" | "monthDay", Intl.DateTimeFormatOptions> = {
  short: { month: "short", day: "numeric" },
  medium: { month: "short", day: "numeric", year: "numeric" },
  long: { year: "numeric", month: "long", day: "numeric" },
  numeric: { year: "numeric", month: "numeric", day: "numeric" },
  shortDateTime: { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  dateTime: { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" },
  month: { month: "short" },
  weekdayShort: { weekday: "short" },
  dayOnly: { day: "numeric" },
  time: { hour: "2-digit", minute: "2-digit" },
  weekday: { weekday: "long" },
  clock: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  monthDay: { month: "numeric", day: "numeric" },
};

// Long lists (event log, timeline) format hundreds of rows; a formatter per
// language × zone × shape is built once.
const formats = new Map<string, Intl.DateTimeFormat>();
function format(style: keyof typeof STYLES, timeZone: string | undefined): Intl.DateTimeFormat {
  const locale = getLocale();
  const key = `${locale}|${timeZone ?? ""}|${style}`;
  let f = formats.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...STYLES[style], timeZone });
    } catch {
      // An unknown zone name: the browser's own rather than no label.
      f = new Intl.DateTimeFormat(locale, STYLES[style]);
    }
    formats.set(key, f);
  }
  return f;
}

function safeDayId(at: Date, timeZone: string | undefined): string {
  try { return dateIdAt(at, timeZone); } catch { return dateIdAt(at, undefined); }
}

/** "Today", "Yesterday", the weekday within the last week, else a short date
 *  — with the year when it is not this year. Days are the workspace's. */
export function dayLabel(iso: string, now: Date = new Date(), timeZone: string | undefined = workspaceTimeZone()): string {
  const d = new Date(iso);
  const day = safeDayId(d, timeZone);
  const today = safeDayId(now, timeZone);
  const diffDays = daysBetween(day, today);
  if (diffDays <= 0) return t("Today");
  if (diffDays === 1) return t("Yesterday");
  if (diffDays <= 6) return format("weekday", timeZone).format(d);
  return format(day.slice(0, 4) === today.slice(0, 4) ? "short" : "medium", timeZone).format(d);
}

/** Hour and minute in the workspace's zone. */
export function timeLabel(iso: string, timeZone: string | undefined = workspaceTimeZone()): string {
  return format("time", timeZone).format(new Date(iso));
}

/** The short "when" of a table cell: today the clock time (14:05), this year
 *  month/day (10/16), any other year the full date (2025/10/16). Days are the
 *  workspace's, like dayLabel; the exact instant belongs in a tooltip
 *  (dateLabel "dateTime"). Empty for a missing or unparsable value. */
export function compactWhenLabel(iso: string | null | undefined, now: Date = new Date(), timeZone: string | undefined = workspaceTimeZone()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = safeDayId(d, timeZone);
  const today = safeDayId(now, timeZone);
  if (day === today) return format("clock", timeZone).format(d);
  return format(day.slice(0, 4) === today.slice(0, 4) ? "monthDay" : "numeric", timeZone).format(d);
}

/** A date (or date and time) in one of the app's shapes, in the workspace's
 *  zone. Empty for a missing or unparsable value. */
export function dateLabel(iso: string | null | undefined, style: DateStyle = "medium", timeZone: string | undefined = workspaceTimeZone()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return format(style, timeZone).format(d);
}

/** A calendar day id (YYYY-MM-DD) in one of the app's shapes. A day is not an instant, so no zone applies. */
export function dayIdLabel(date: string, style: DateStyle = "medium"): string {
  return dateLabel(`${date}T12:00:00Z`, style, "UTC");
}

/** A calendar day id as a short date for a list: 「11/5」, with the year only when it is not `today`'s year. */
export function nearDayLabel(date: string, today: string): string {
  const year = (dayId: string) => dayId.split("-", 1)[0];
  return dayIdLabel(date, year(date) === year(today) ? "monthDay" : "numeric");
}

/** "October 2026" for a calendar month (0-based `month`). A calendar cell,
 *  not an instant, so no zone applies. */
export function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat(getLocale(), { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month, 1)));
}

/** Compact age: "now", "5m", "3h", "2d". Floored, so "1h" means at least an
 *  hour. Empty when there is no time. An age, so no zone applies. */
export function relTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return t("now");
  if (minutes < 60) return t("{n}m", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{n}h", { n: hours });
  return t("{n}d", { n: Math.floor(hours / 24) });
}

/** Spoken age: "3 minutes ago", "yesterday", "2 months ago" (zh-TW: "3 分鐘前",
 *  "昨天") — the app language's own wording (Intl.RelativeTimeFormat). Under a
 *  minute is "now"; past a year a date (dateLabel medium). Empty when there is
 *  no time. An age, so no zone applies. */
export function agoLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return "";
  if (seconds < 60) return t("now");
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  if (days < 365) return rtf.format(-Math.floor(days / 30), "month");
  return dateLabel(iso, "medium");
}

/** The browser's own name for a zone in `locale` ("台北時間"), or null. */
export function zoneGenericName(timeZone: string, locale: string): string | null {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "longGeneric" }).formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? null;
  } catch { return null; }
}

const canonicalZones = new Map<string, string>();
/** The zone's name as this browser spells it ("Asia/Kolkata" is "Asia/Calcutta"
 *  in Chrome and Node), so tables written in IANA's names meet its list. An
 *  unknown name comes back as it was. */
export function canonicalZone(timeZone: string): string {
  let zone = canonicalZones.get(timeZone);
  if (zone === undefined) {
    try { zone = new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone; } catch { zone = timeZone; }
    canonicalZones.set(timeZone, zone);
  }
  return zone;
}
