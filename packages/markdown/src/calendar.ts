// Calendar arithmetic on YYYY-MM-DD ids — the one copy. Pure UTC math, so a
// daylight-saving jump can never move a date; the zone only decides which day
// is "today" (frontend lib/localDate.ts, backend localDay.ts), never how days
// are counted. Those two re-export these; nothing else adds days by hand
// (test/guards/tasks-time.guard.test.ts). No imports: taskParse reaches it from
// the local-DB worker, which must stay free of the Markdown pipeline.

const DAY_MS = 86_400_000;

/** The id `days` after `date` (negative goes back). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The id `months` after `date`, keeping the day of the month when the target
 *  month has it, else its last day (Jan 31 + 1 month is Feb 28/29, not Mar 3). */
export function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

/** The month `delta` months from `year`/`month` (month counts from 0, like Date); how a month picker steps. */
export function stepMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + month + delta;
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 };
}

/** 0 = Sunday … 6 = Saturday: the weekday a calendar day id falls on. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export type MonthCell = {
  /** YYYY-MM-DD */
  key: string;
  /** 1..31 */
  day: number;
  /** False for the leading/trailing days of the neighbouring months. */
  inMonth: boolean;
  isToday: boolean;
};

/** The Monday-first grid of whole weeks that covers a month — the one month
 *  grid of every calendar in the app. `month` counts from 0 (like Date and
 *  lib/localDate monthId); `today` is the workspace's day id, never read from
 *  the device clock here. */
export function buildMonthGrid(year: number, month: number, today: string): MonthCell[] {
  const monthStart = addMonths(`${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`, 0);
  const lead = (weekdayOf(monthStart) + 6) % 7;
  const monthEnd = addMonths(monthStart, 1);
  const total = Math.ceil((lead + daysBetween(monthStart, monthEnd)) / 7) * 7;
  const start = addDays(monthStart, -lead);
  const cells: MonthCell[] = [];
  for (let i = 0; i < total; i++) {
    const key = addDays(start, i);
    cells.push({ key, day: Number(key.slice(8, 10)), inMonth: key >= monthStart && key < monthEnd, isToday: key === today });
  }
  return cells;
}

// Time-zone names. ICU in Node (and so Intl.supportedValuesOf) still lists the
// pre-rename ids for these zones, while browsers (Firefox, Safari, Chrome's
// DateTimeFormat) and the database's tzdata use the modern ones. A workspace
// stores one name, the modern one, so the server's list, the database and the
// frontend's picker (ZH_NAMES) all key the same string.
const RENAMED_ZONES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata", "Asia/Katmandu": "Asia/Kathmandu", "Asia/Rangoon": "Asia/Yangon", "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Europe/Kiev": "Europe/Kyiv", "America/Buenos_Aires": "America/Argentina/Buenos_Aires", "America/Godthab": "America/Nuuk",
  "Atlantic/Faeroe": "Atlantic/Faroe", "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville", "America/Cordoba": "America/Argentina/Cordoba",
  "America/Jujuy": "America/Argentina/Jujuy", "America/Mendoza": "America/Argentina/Mendoza",
  "America/Catamarca": "America/Argentina/Catamarca", "Pacific/Truk": "Pacific/Chuuk", "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton", "Africa/Asmera": "Africa/Asmara",
};

/** The one name a zone is stored and listed under: a renamed id becomes its modern name, anything else is unchanged. */
export function canonicalZoneName(zone: string): string {
  return RENAMED_ZONES[zone] ?? zone;
}
