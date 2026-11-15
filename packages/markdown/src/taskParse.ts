// Quick-add task text → what the person meant ("明天下午3點 交報告 #學校").
//
// A pure function shared by the app (live preview while typing) and anything
// that wants the same reading later (server, agent). No pipeline imports: the
// local-DB worker must stay free of the Markdown pipeline, so this is reached through
// the `@onden/markdown/task-parse` subpath only.
//
// Rule of thumb: recognise only phrasing that is unmistakably a schedule.
// A word that is also a plausible title ("週末計畫", "下午茶", "3 點重點")
// stays in the title. Each recognised piece is reported as a span so the UI
// can colour it and let the person take the reading back ("ignore").
//
// Dates are calendar days (YYYY-MM-DD) with no time zone; `today` decides
// what "tomorrow" is. Weeks run Monday to Sunday. A bare weekday ("週五")
// is the next such day AFTER today; "這週五" and recurrences ("每週五")
// may be today.

// Only the calendar arithmetic is imported (pure, no Markdown pipeline), so the
// worker rule above still holds.
import { addDays as addDaysTo, addMonths as addMonthsTo, weekdayOf } from "./calendar.js";
import { CLOCK_24H_SOURCE } from "./taskTime.js";

export type TaskSpanKind =
  | "date"
  | "evening"
  | "time"
  | "deadline"
  | "recur"
  | "recur_mode"
  | "remind"
  | "someday"
  | "anytime"
  | "daypart"
  | "duration"
  | "tag";

/** A part of the day named without a clock time. Only the evening is stored (the task's
 *  「今晚」 flag); the others are read, shown and kept out of the title, but have no field to
 *  go in — a made-up clock time would put the task on the timeline at an hour nobody said. */
export type Daypart = "morning" | "noon" | "afternoon" | "evening";

/** A piece of the input that looks like half of a date or time and was not understood.
 *  It stays in the title; the screen points at it so the person rewrites it or keeps it. */
export type DoubtfulPiece = { start: number; end: number; text: string };

export type TaskSpan = { start: number; end: number; kind: TaskSpanKind };

export type ParsedTask = {
  title: string;
  /** YYYY-MM-DD, or null (someday / anytime). */
  when_date: string | null;
  /** "This evening" of when_date; false when a clock time was given. */
  evening: boolean;
  someday: boolean;
  anytime: boolean;
  /** HH:MM, 24-hour. */
  time: string | null;
  /** HH:MM it ends, later than `time` ("3點到5點", or `time` plus `duration`); null otherwise. */
  until: string | null;
  /** Minutes it takes ("30分鐘", "1小時", or `time` to `until`); null when nothing said. */
  duration: number | null;
  /** "週五下午", "明早", "中午": a part of the day without a clock time; null when a time was given. */
  daypart: Daypart | null;
  /** YYYY-MM-DD */
  deadline: string | null;
  /** `<n><d|w|m>` (a year is 12m), or null. */
  recur: string | null;
  /** fixed = next date follows the calendar; after = counts from completion. */
  recur_mode: "fixed" | "after";
  remind: boolean;
  tags: string[];
  /** Recognised pieces of the input, sorted, never overlapping. */
  spans: TaskSpan[];
  /** The words named a day ("明天", "週五", "每週五"); false when `when_date` is only today or a default. */
  when_stated: boolean;
  /** Fragments that look like a date or time and were not understood (still in the title). */
  doubtful: DoubtfulPiece[];
};

export type TaskParseOptions = {
  /** The current day ("YYYY-MM-DD") on the workspace clock; never read off the device. */
  today: string;
  /** Clock time "HH:MM" now; only used to move a past time to tomorrow. */
  nowTime?: string;
  /** "zh…" keeps bare English weekday abbreviations ("mon") in the title. */
  locale?: string;
  /** Readings the person took back: same kind and same text is not recognised. */
  ignore?: ReadonlyArray<{ kind: TaskSpanKind | "doubtful"; text: string }>;
};

// ── calendar arithmetic on YYYY-MM-DD (UTC math: no daylight-saving drift) ──

type Ymd = { y: number; m: number; d: number };

const pad = (n: number): string => String(n).padStart(2, "0");
const fmt = ({ y, m, d }: Ymd): string => `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
const toUtc = ({ y, m, d }: Ymd): number => Date.UTC(y, m - 1, d);
const ofId = (id: string): Ymd => ({ y: Number(id.slice(0, 4)), m: Number(id.slice(5, 7)), d: Number(id.slice(8, 10)) });
const addDays = (a: Ymd, n: number): Ymd => ofId(addDaysTo(fmt(a), n));
const dow = (a: Ymd): number => weekdayOf(fmt(a)); // 0 = Sunday
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const validYmd = (y: number, m: number, d: number): boolean =>
  y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
/** Add months, keeping the day when the month has it, else its last day. */
const addMonths = (a: Ymd, n: number): Ymd => ofId(addMonthsTo(fmt(a), n));
/** The next `weekday` (0 = Sunday); today itself only when `inclusive`. */
function nextWeekday(from: Ymd, weekday: number, inclusive: boolean): Ymd {
  let diff = (weekday - dow(from) + 7) % 7;
  if (diff === 0 && !inclusive) diff = 7;
  return addDays(from, diff);
}
/** `weekday` of the Monday-to-Sunday week that starts `weeksAhead` weeks after this one. */
function weekdayOfWeek(from: Ymd, weekday: number, weeksAhead: number): Ymd {
  const monday = addDays(from, -((dow(from) + 6) % 7));
  return addDays(monday, weeksAhead * 7 + ((weekday + 6) % 7));
}
/** The first month/day on or after `from` (this year, else the next that has it). */
function nextMonthDay(from: Ymd, m: number, d: number): Ymd | null {
  for (let y = from.y; y <= from.y + 8; y++) {
    if (!validYmd(y, m, d)) continue;
    const cand = { y, m, d };
    if (toUtc(cand) >= toUtc(from)) return cand;
  }
  return null;
}

// ── words ────────────────────────────────────────────────────────────────

const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_NUM = "[一二兩两三四五六七八九十]{1,3}";
const NUM = `(?:\\d{1,3}|${CN_NUM})`;

/** "12" / "三" / "十二" / "二十" → number; null for anything else. */
function toNumber(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  const ten = word.indexOf("十");
  if (ten < 0) return word.length === 1 && word in CN_DIGIT ? CN_DIGIT[word]! : null;
  const head = word.slice(0, ten);
  const tail = word.slice(ten + 1);
  const tens = head === "" ? 1 : head.length === 1 && head in CN_DIGIT ? CN_DIGIT[head]! : null;
  const ones = tail === "" ? 0 : tail.length === 1 && tail in CN_DIGIT ? CN_DIGIT[tail]! : null;
  return tens === null || ones === null ? null : tens * 10 + ones;
}

const ZH_WEEKDAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
export const EN_WEEKDAY_FULL: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
export const EN_WEEKDAY_SHORT: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};
// Spelled out rather than built from the tables above: a module-level `.sort()` with a callback is a
// side effect to the bundler, which then keeps this whole file in the first screen's JavaScript for
// everything that imports the package (date picker → parseDateText). taskParse.test.ts holds them to the tables.
export const EN_WEEKDAY_FULL_PATTERN = "sunday|monday|tuesday|wednesday|thursday|friday|saturday";
export const EN_WEEKDAY_SHORT_PATTERN = "thurs|tues|thur|sun|mon|tue|wed|thu|fri|sat";
const EN_FULL = EN_WEEKDAY_FULL_PATTERN;
const EN_SHORT = EN_WEEKDAY_SHORT_PATTERN;
const EN_WEEKDAY = `(?:${EN_FULL}|${EN_SHORT})`;
const enWeekday = (word: string): number => {
  const w = word.toLowerCase();
  return EN_WEEKDAY_FULL[w] ?? EN_WEEKDAY_SHORT[w] ?? 0;
};

const ZH_WEEK = "(?:週|周|星期|禮拜|礼拜)";
const ZH_WD = "[一二三四五六日天]";

// A deadline is marked after the date ("週五前", "6/30 截止") or before it.
const DEADLINE_AFTER = new RegExp(
  // tight to the date ("週五前", "6/30截止"): the word after 前 must not make a word of it ("前面", "前端"…)
  "^(?:(?:之前|以前)(?!的)|前交?(?![面後后方進进往天晚端輩辈列])|截止日?|到期日?|為止|为止)" +
  // after a space ("11/8 前", "週五 以前 交"): the marker must stand alone, so "明天 前置作業" and "11/8 之前的筆記" stay titles
  "|^\\s+(?:之前|以前|前交?|截止日?|到期日?|為止|为止)(?=\\s|$|[，,。.;；、!！?？])",
);
const DEADLINE_BEFORE = /(?:截止於?|截止日期?|期限|到期於?|deadline:?|due(?: on)?|by)\s*$/i;

const TAG_CHAR = "[\\p{L}\\p{N}_\\-/]";

const PERIOD = "凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚間|晚间|夜裡|夜里|夜晚";
/** "點" forms of a clock hour: 3點, 3點半, 3點10分, 3點整 (not 3點整理). */
const HOUR_WORD = `(?:點|点|時|时)(?:(半)|(\\d{1,2})\\s*分|整(?![理頓顿合]))?`;
const DAYPART_OF: Array<[RegExp, Daypart]> = [
  [/^(?:凌晨|清晨|早上|早晨|上午)$/, "morning"],
  [/^中午$/, "noon"],
  [/^下午$/, "afternoon"],
  [/^(?:傍晚|晚上|晚間|晚间|夜裡|夜里|夜晚)$/, "evening"],
];
const daypartOf = (word: string): Daypart => DAYPART_OF.find(([re]) => re.test(word))![1];
/** When a part of the day is over: a daypart already past today means tomorrow. */
const DAYPART_END: Record<Daypart, string> = { morning: "12:00", noon: "13:00", afternoon: "18:00", evening: "24:00" };

/** The clock hour a period word + number means ("下午3" → 15, "晚上12" → 0 of the next day). */
function periodHour(period: string, raw: number): { h: number; shift: number } {
  if (/^(凌晨|清晨|早上|早晨|上午)$/.test(period)) return { h: raw === 12 ? 0 : raw, shift: 0 };
  if (period === "中午") return { h: raw >= 1 && raw <= 4 ? raw + 12 : raw, shift: 0 };
  if (raw < 12) return { h: raw + 12, shift: 0 }; // 下午 傍晚 晚上 夜
  if (raw === 12 && /晚|夜/.test(period)) return { h: 0, shift: 1 };
  return { h: raw, shift: 0 };
}

/** The end of a time range right after a start ("到5點", "-15:30", "至晚上8點"): "到" / "至" / a dash, then a
 *  clock. Groups: 1 period, 2-3 24-hour clock, 4 hour word, 5 半, 6 minutes. */
const RANGE_AFTER = new RegExp(
  `^\\s*(?:到|至|~|～|-|–|—)\\s*(?:(${PERIOD})\\s*)?(?:${CLOCK_24H_SOURCE}|(\\d{1,2}|${CN_NUM})\\s*${HOUR_WORD})`,
);

/** Parts that, standing alone after a date, are leftovers of a date or time that was not read. */
const DOUBT_PATTERNS: RegExp[] = [
  new RegExp(`[到至~～]\\s*(?:(?:${PERIOD})\\s*)?(?:\\d{1,2}|${CN_NUM})\\s*(?:[點点時时]|:\\d\\d)`),
  /(?<![\d:])\d{1,2}:\d{2}(?![\d:])/,
  new RegExp(`(?:${PERIOD})\\s*\\d{1,2}(?![\\d:點点時时月日號号週周個人場次份題頁章篇本])`),
  /(?<![\d第])\d{1,2}[點点](?![重半整鐘钟分])/,
  /\d{1,2}月\d{1,2}(?![\d日號号])/,
  /\d{1,2}月(?![\d份底末初中日號号])/,
];

// ── the parser ───────────────────────────────────────────────────────────

export function parseTaskInput(raw: string, opts: TaskParseOptions): ParsedTask {
  // Full-width colon ("14：00") reads as a colon; one character for one, so spans stay valid for `raw`.
  const text = raw.replace(/：/g, ":");
  const todayYmd = parseToday(opts.today);
  const nowTime = opts.nowTime ?? null;
  const zhLocale = (opts.locale ?? "").toLowerCase().startsWith("zh");
  const ignore = opts.ignore ?? [];

  const spans: TaskSpan[] = [];
  // Every date/deadline phrase found; the earliest in the text wins (a phrase
  // lost to an earlier one is released back into the title).
  const dateCands: Array<{ span: TaskSpan; date: string; evening: boolean }> = [];
  const deadlineCands: Array<{ span: TaskSpan; date: string }> = [];
  let time = null as string | null;
  let until = null as string | null;
  let duration = null as number | null;
  let daypart = null as Daypart | null;
  let timeDayShift = 0; // 晚上12點 is midnight at the END of the day
  let someday = false;
  let anytime = false;
  let recur = null as string | null;
  let recurWeekday = null as number | null;
  let recurMode = "fixed" as "fixed" | "after";
  const tags: string[] = [];
  const reminders: Array<{ start: number; end: number }> = [];

  const isIgnored = (start: number, end: number, kind: string): boolean => {
    const piece = raw.slice(start, end);
    return ignore.some((i) => i.kind === kind && i.text === piece);
  };
  // Words the person took back as one piece: no other reading may take a part of them.
  const blocked: Array<{ start: number; end: number }> = [];
  const overlaps = (start: number, end: number): boolean =>
    spans.some((s) => start < s.end && end > s.start) || blocked.some((s) => start < s.end && end > s.start);
  /** Take [start,end) as a recognised piece unless something else owns it or the person ignored it. */
  const take = (start: number, end: number, kind: TaskSpanKind): boolean => {
    if (overlaps(start, end)) return false;
    if (isIgnored(start, end, kind)) return false;
    spans.push({ start, end, kind });
    return true;
  };

  const each = (re: RegExp, fn: (m: RegExpExecArray) => void): void => {
    for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) fn(m as RegExpExecArray);
  };

  /** A date phrase: a deadline when marked as one, else the day to do it. */
  const dateSlot = (m: RegExpExecArray, date: Ymd | null, extraEnd = 0): void => {
    if (!date) return;
    let start = m.index;
    let end = m.index + m[0].length + extraEnd;
    const after = DEADLINE_AFTER.exec(text.slice(end));
    const before = DEADLINE_BEFORE.exec(text.slice(0, start));
    if (after || before) {
      const s = before ? start - before[0].length : start;
      const e = after ? end + after[0].length : end;
      if (take(s, e, "deadline")) deadlineCands.push({ span: spans[spans.length - 1]!, date: fmt(date) });
      return;
    }
    if (take(start, end, "date")) dateCands.push({ span: spans[spans.length - 1]!, date: fmt(date), evening: false });
  };

  // tags
  each(new RegExp(`(?<=^|\\s)#(${TAG_CHAR}*\\p{L}${TAG_CHAR}*)`, "u"), (m) => {
    if (take(m.index, m.index + m[0].length, "tag") && !tags.includes(m[1]!)) tags.push(m[1]!);
  });

  // recurrence (before weekdays: "每週五" is not the date "週五")
  const setRecur = (m: RegExpExecArray, token: string, weekday: number | null = null): void => {
    if (recur) return;
    if (take(m.index, m.index + m[0].length, "recur")) { recur = token; recurWeekday = weekday; }
  };
  each(new RegExp(`每個?${ZH_WEEK}(${ZH_WD})`), (m) => setRecur(m, "1w", ZH_WEEKDAY[m[1]!]!));
  each(new RegExp(`每(${NUM})個?(?:天|日)`), (m) => { const n = toNumber(m[1]!); if (n && n <= 365) setRecur(m, `${n}d`); });
  each(new RegExp(`每(${NUM})個?(?:${ZH_WEEK})(?!${ZH_WD})`), (m) => { const n = toNumber(m[1]!); if (n && n <= 52) setRecur(m, `${n}w`); });
  each(new RegExp(`每(${NUM})個月`), (m) => { const n = toNumber(m[1]!); if (n && n <= 120) setRecur(m, `${n}m`); });
  each(new RegExp(`每個?${ZH_WEEK}(?!${ZH_WD})`), (m) => setRecur(m, "1w"));
  each(/每(?:天|日)(?![子一])/, (m) => setRecur(m, "1d"));
  each(/每個?月/, (m) => setRecur(m, "1m"));
  each(/每年/, (m) => setRecur(m, "12m"));
  each(new RegExp(`\\bevery\\s+(${EN_WEEKDAY})\\b`, "i"), (m) => setRecur(m, "1w", enWeekday(m[1]!)));
  each(/\bevery\s+(\d{1,3})\s+(day|week|month)s?\b/i, (m) => {
    const n = Number(m[1]);
    if (n > 0) setRecur(m, `${n}${m[2]!.toLowerCase()[0]}`);
  });
  each(/\bevery\s+(day|week|month|year)\b/i, (m) => {
    const unit = m[1]!.toLowerCase();
    setRecur(m, unit === "day" ? "1d" : unit === "week" ? "1w" : unit === "month" ? "1m" : "12m");
  });

  // absolute dates
  each(/(?<![\d/-])(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?![\d/-])/, (m) => {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (validYmd(y, mo, d)) dateSlot(m, { y, m: mo, d });
  });
  each(new RegExp(`(\\d{1,2})月(\\d{1,2})[日號号]`), (m) => dateSlot(m, nextMonthDay(todayYmd, Number(m[1]), Number(m[2]))));
  each(/(?<![\d/.-])(\d{1,2})\/(\d{1,2})(?![\d/])/, (m) => dateSlot(m, nextMonthDay(todayYmd, Number(m[1]), Number(m[2]))));

  // relative to today
  each(new RegExp(`(${NUM})\\s*(?:天|日)(?:之?後|以後|后)`), (m) => { const n = toNumber(m[1]!); if (n !== null && n <= 3650) dateSlot(m, addDays(todayYmd, n)); });
  each(new RegExp(`(${NUM})\\s*個?(?:${ZH_WEEK}|禮拜)(?:之?後|以後|后)`), (m) => { const n = toNumber(m[1]!); if (n !== null && n <= 520) dateSlot(m, addDays(todayYmd, n * 7)); });
  each(new RegExp(`(${NUM})\\s*個月(?:之?後|以後|后)`), (m) => { const n = toNumber(m[1]!); if (n !== null && n <= 120) dateSlot(m, addMonths(todayYmd, n)); });
  each(/\bin\s+(\d{1,3})\s+(day|week|month)s?\b/i, (m) => {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    dateSlot(m, unit === "day" ? addDays(todayYmd, n) : unit === "week" ? addDays(todayYmd, n * 7) : addMonths(todayYmd, n));
  });

  // 今晚8點 / 明晚7:30: the day and the clock in one phrase
  each(new RegExp(`(今晚|今夜|明晚)\\s*(\\d{1,2}|${CN_NUM})\\s*(?:(?:點|点|時|时)(?:(半)|(\\d{1,2})\\s*分|整)?|:([0-5]\\d))`), (m) => {
    const raw = toNumber(m[2]!);
    if (raw === null || raw > 24 || time) return;
    const min = m[3] ? 30 : m[4] ? Number(m[4]) : m[5] ? Number(m[5]) : 0;
    const h = raw < 12 ? raw + 12 : raw === 12 ? 0 : raw;
    if (h > 23 || !take(m.index, m.index + m[0].length, "time")) return;
    time = `${pad(h)}:${pad(min)}`;
    const day = addDays(todayYmd, m[1] === "明晚" ? 1 : 0);
    dateCands.push({ span: spans[spans.length - 1]!, date: fmt(addDays(day, raw === 12 ? 1 : 0)), evening: false });
  });

  // 今晚/明晚 (a date plus "this evening")
  const eveningSlot = (m: RegExpExecArray, shift: number): void => {
    if (take(m.index, m.index + m[0].length, "evening")) dateCands.push({ span: spans[spans.length - 1]!, date: fmt(addDays(todayYmd, shift)), evening: true });
  };
  each(/今晚|今夜/, (m) => eveningSlot(m, 0));
  each(/明晚/, (m) => eveningSlot(m, 1));
  each(/\btonight\b|\bthis\s+evening\b/i, (m) => eveningSlot(m, 0));

  each(/大後天|大后天/, (m) => dateSlot(m, addDays(todayYmd, 3)));
  each(/後天|后天/, (m) => dateSlot(m, addDays(todayYmd, 2)));
  each(/明天|明日/, (m) => dateSlot(m, addDays(todayYmd, 1)));
  each(/今天|今日/, (m) => dateSlot(m, todayYmd));
  each(/\bday after tomorrow\b/i, (m) => dateSlot(m, addDays(todayYmd, 2)));
  each(/\b(?:tomorrow|tmrw|tmr)\b/i, (m) => dateSlot(m, addDays(todayYmd, 1)));
  each(/\btoday\b/i, (m) => dateSlot(m, todayYmd));

  // 月底 / 下個月底: the last day of the month (月底前 is a deadline, like any date + 前)
  each(/(下個?|這個?|本)?月[底末]/, (m) => {
    const first = addMonths({ ...todayYmd, d: 1 }, m[1]?.startsWith("下") ? 1 : 0);
    dateSlot(m, { ...first, d: daysInMonth(first.y, first.m) });
  });

  // weeks and months
  each(new RegExp(`下個?${ZH_WEEK}(${ZH_WD})`), (m) => dateSlot(m, weekdayOfWeek(todayYmd, ZH_WEEKDAY[m[1]!]!, 1)));
  each(new RegExp(`下個?${ZH_WEEK}(?!${ZH_WD}|末|年|一)`), (m) => dateSlot(m, weekdayOfWeek(todayYmd, 1, 1)));
  each(new RegExp(`下個月(?:(\\d{1,2})[日號号])?`), (m) => {
    const first = addMonths({ ...todayYmd, d: 1 }, 1);
    if (m[1] === undefined) return dateSlot(m, first);
    const d = Number(m[1]);
    if (d >= 1) dateSlot(m, { ...first, d: Math.min(d, daysInMonth(first.y, first.m)) });
  });
  each(new RegExp(`(?<![上前])(?:這個?|本)${ZH_WEEK}(${ZH_WD})`), (m) => {
    const d = weekdayOfWeek(todayYmd, ZH_WEEKDAY[m[1]!]!, 0);
    dateSlot(m, toUtc(d) < toUtc(todayYmd) ? addDays(d, 7) : d);
  });
  each(new RegExp(`(?<![上前每這这本個])${ZH_WEEK}(${ZH_WD})`), (m) => dateSlot(m, nextWeekday(todayYmd, ZH_WEEKDAY[m[1]!]!, false)));
  each(/\bnext\s+week\b/i, (m) => dateSlot(m, weekdayOfWeek(todayYmd, 1, 1)));
  each(/\bnext\s+month\b/i, (m) => dateSlot(m, addMonths({ ...todayYmd, d: 1 }, 1)));
  each(new RegExp(`\\bnext\\s+(${EN_WEEKDAY})\\b`, "i"), (m) => dateSlot(m, weekdayOfWeek(todayYmd, enWeekday(m[1]!), 1)));
  each(new RegExp(`\\bthis\\s+(${EN_WEEKDAY})\\b`, "i"), (m) => {
    const d = weekdayOfWeek(todayYmd, enWeekday(m[1]!), 0);
    dateSlot(m, toUtc(d) < toUtc(todayYmd) ? addDays(d, 7) : d);
  });
  // "mon" alone is easy to meet in a title; in a Chinese UI only the full name counts
  each(new RegExp(`(?<![\\w-])(${zhLocale ? EN_FULL : EN_WEEKDAY})(?![\\w-])`, "i"), (m) => dateSlot(m, nextWeekday(todayYmd, enWeekday(m[1]!), false)));

  // ── time of day ──
  /** The end of a range that begins at `end` for a start of `startH:startMin`: HH:MM and where it ends, or null. */
  const rangeEnd = (end: number, startH: number, startMin: number): { until: string; end: number } | null => {
    const r = RANGE_AFTER.exec(text.slice(end));
    if (!r) return null;
    let h: number;
    let min: number;
    if (r[2] !== undefined) {
      h = Number(r[2]);
      min = Number(r[3]);
    } else {
      const rawH = toNumber(r[4]!);
      if (rawH === null || rawH > 24) return null;
      min = r[5] ? 30 : r[6] ? Number(r[6]) : 0;
      // "下午3點到5點": the end follows the start's half of the day unless it names its own
      h = r[1] ? periodHour(r[1], rawH).h : rawH <= startH && rawH < 12 ? rawH + 12 : rawH;
    }
    if (h > 23 || min > 59 || h * 60 + min <= startH * 60 + startMin) return null;
    return { until: `${pad(h)}:${pad(min)}`, end: end + r[0].length };
  };
  /** Takes [start,end) as the time (and its range end, if one follows). */
  const setTime = (start: number, end: number, h: number, min: number, shift = 0): void => {
    if (time || h > 23 || min > 59) return;
    const range = rangeEnd(end, h, min);
    if (range && isIgnored(start, range.end, "time")) { blocked.push({ start, end: range.end }); return; }
    if (!take(start, range ? range.end : end, "time")) return;
    time = `${pad(h)}:${pad(min)}`;
    until = range ? range.until : null;
    timeDayShift = shift;
  };
  each(new RegExp(`(${PERIOD})\\s*(\\d{1,2}|${CN_NUM})\\s*(?:${HOUR_WORD}|:([0-5]\\d))`), (m) => {
    const raw = toNumber(m[2]!);
    if (raw === null || raw > 24) return;
    const min = m[3] ? 30 : m[4] ? Number(m[4]) : m[5] ? Number(m[5]) : 0;
    const { h, shift } = periodHour(m[1]!, raw);
    setTime(m.index, m.index + m[0].length, h, min, shift);
  });
  each(/\b(?:at\s+)?(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?m\b\.?/i, (m) => {
    const h12 = Number(m[1]) % 12;
    setTime(m.index, m.index + m[0].length, m[3]!.toLowerCase() === "p" ? h12 + 12 : h12, m[2] ? Number(m[2]) : 0);
  });
  each(new RegExp(`\\bat\\s+${CLOCK_24H_SOURCE}(?![\\d:])`, "i"), (m) => setTime(m.index, m.index + m[0].length, Number(m[1]), Number(m[2])));
  each(new RegExp(`(?<![\\d:])${CLOCK_24H_SOURCE}(?![\\d:])`), (m) => setTime(m.index, m.index + m[0].length, Number(m[1]), Number(m[2])));
  // A bare hour ("3點") is a time only when something else says it is one: right after a date word
  // ("明天3點", "明天 3點"), a half / minutes / sharp ("3點半"), or a range ("3點到5點"). 1–6 means the afternoon.
  each(new RegExp(`(?<![\\d第])(\\d{1,2})${HOUR_WORD}`), (m) => {
    if (time) return;
    const end = m.index + m[0].length;
    const raw = Number(m[1]);
    const h = raw >= 1 && raw <= 6 ? raw + 12 : raw;
    const min = m[2] ? 30 : m[3] ? Number(m[3]) : 0;
    const afterDate = spans.some((s) => (s.kind === "date" || s.kind === "evening") && text.slice(s.end, m.index).trim() === "");
    const stated = !!(m[2] || m[3] || /整$/.test(m[0]));
    if (afterDate || stated || rangeEnd(end, h, min)) setTime(m.index, end, h, min);
  });

  // ── a part of the day, without a clock ──
  // 明早 / 今早 name the day too. 下午 / 中午 / 晚上… count only standing apart: right after a date or
  // repeat, or as the first / last word — 下午茶 and 晚上的課 stay in the title.
  each(/([今明])早(?![上晨餐飯饭])/, (m) => {
    if (daypart) return;
    if (take(m.index, m.index + m[0].length, "daypart")) {
      daypart = "morning";
      dateCands.push({ span: spans[spans.length - 1]!, date: fmt(addDays(todayYmd, m[1] === "明" ? 1 : 0)), evening: false });
    }
  });
  each(new RegExp(`(${PERIOD})(?=\\s|$|[，,。.、；;])`), (m) => {
    if (daypart) return;
    const start = m.index;
    const end = start + m[0].length;
    const before = text.slice(0, start);
    const standsApart = before.trim() === "" || text.slice(end).trim() === ""
      || spans.some((s) => (s.kind === "date" || s.kind === "evening" || s.kind === "recur") && text.slice(s.end, start).trim() === "");
    if (!standsApart || (before !== "" && !/\s$/.test(before) && !spans.some((s) => s.end === start))) return;
    if (take(start, end, "daypart")) daypart = daypartOf(m[1]!);
  });

  // ── how long ──
  const setDuration = (m: RegExpExecArray, minutes: number): void => {
    if (duration !== null || !(minutes > 0 && minutes <= 24 * 60)) return;
    if (take(m.index, m.index + m[0].length, "duration")) duration = Math.round(minutes);
  };
  const SPAN_END = "(?![後后內内前\\p{L}])";
  each(new RegExp(`(?<![\\d.:])(\\d{1,3}|${CN_NUM})\\s*(?:分鐘|分钟|minutes?|mins?)${SPAN_END}`, "iu"), (m) => { const n = toNumber(m[1]!); if (n !== null) setDuration(m, n); });
  each(new RegExp(`(?<![\\d.:])(\\d{1,2}(?:\\.\\d)?|${CN_NUM})\\s*個?(?:小時|小时|hours?|hrs?)(?![後后內内前\\p{L}])`, "iu"), (m) => { const n = /^[\d.]+$/.test(m[1]!) ? Number(m[1]) : toNumber(m[1]!); if (n !== null) setDuration(m, n * 60); });
  each(/(?<![\d.])(?:一個半|1\.5個?|一个半)(?:小時|小时)/, (m) => setDuration(m, 90));
  each(/半個?(?:小時|小时)/, (m) => setDuration(m, 30));

  // ── mode, parking, reminders ──
  if (recur) {
    each(/完成(?:之?後|后)|做完(?:之?後|后)|\bafter\s+(?:done|completion|completing|finishing)\b/i, (m) => {
      if (recurMode === "after") return;
      if (take(m.index, m.index + m[0].length, "recur_mode")) recurMode = "after";
    });
  }
  const dated = dateCands.length > 0 || time !== null || recur !== null || daypart !== null;
  if (!dated) {
    each(/某天(?![的子])|有空(?!間|间)(?:再)?|\bsomeday\b/i, (m) => {
      if (!someday && take(m.index, m.index + m[0].length, "someday")) someday = true;
    });
  }
  if (!dated && !someday) {
    each(/隨時|随时|\banytime\b/i, (m) => {
      if (!anytime && take(m.index, m.index + m[0].length, "anytime")) anytime = true;
    });
  }
  if (dated || recur) {
    // a reminder phrase counts only at an edge of the sentence or next to another piece
    const trimmedStart = text.length - text.trimStart().length;
    const trimmedEnd = text.trimEnd().length;
    each(/提醒我?(?!事項|事项|功能|設定|设置)|\bremind\s+me(?:\s+to)?\b|\breminder\b/i, (m) => {
      const start = m.index;
      const end = m.index + m[0].length;
      const next = spans.some((s) => s.start === end || s.start === end + 1 || s.end === start || s.end + 1 === start);
      if (!(start === trimmedStart || end === trimmedEnd || next)) return;
      if (take(start, end, "remind")) reminders.push({ start, end });
    });
  }

  // ── fill in what the words imply ──
  // the earliest phrase in the text is the day; later ones go back to the title
  const keep = (cands: Array<{ span: TaskSpan }>): number => {
    let best = -1;
    cands.forEach((c, i) => { if (best < 0 || c.span.start < cands[best]!.span.start) best = i; });
    cands.forEach((c, i) => { if (i !== best) spans.splice(spans.indexOf(c.span), 1); });
    return best;
  };
  const dateAt = keep(dateCands);
  const deadlineAt = keep(deadlineCands);
  let whenDate = dateAt < 0 ? null : dateCands[dateAt]!.date;
  let evening = dateAt >= 0 && dateCands[dateAt]!.evening;
  const deadline = deadlineAt < 0 ? null : deadlineCands[deadlineAt]!.date;
  if (recurWeekday !== null && !whenDate) whenDate = fmt(nextWeekday(todayYmd, recurWeekday, true));
  if (!whenDate && (time || recur || daypart) && !someday) {
    const timePassed = nowTime !== null && (time !== null ? time <= nowTime : daypart !== null && DAYPART_END[daypart] <= nowTime);
    whenDate = fmt(addDays(todayYmd, timePassed ? 1 : 0));
  }
  if (whenDate && timeDayShift) whenDate = fmt(addDays(parseToday(whenDate), timeDayShift));
  if (time) evening = false;
  else if (daypart === "evening") evening = true;
  if (time) daypart = null;
  if (time && duration !== null && until === null) {
    const [h, m] = time.split(":").map(Number) as [number, number];
    const end = h * 60 + m + duration;
    if (end < 24 * 60) until = `${pad(Math.floor(end / 60))}:${pad(end % 60)}`;
  }
  if (time && until && duration === null) {
    const [h, m] = time.split(":").map(Number) as [number, number];
    const [uh, um] = until.split(":").map(Number) as [number, number];
    duration = uh * 60 + um - (h * 60 + m);
  }
  if (!whenDate && !someday) anytime = true;

  spans.sort((a, b) => a.start - b.start);
  return {
    title: titleWithout(raw, spans),
    when_date: whenDate,
    evening,
    someday,
    anytime: anytime && whenDate === null && !someday,
    time,
    until,
    duration,
    daypart,
    deadline,
    recur,
    recur_mode: recurMode,
    remind: reminders.length > 0,
    tags,
    spans,
    when_stated: dateAt >= 0 || recurWeekday !== null,
    doubtful: doubtfulPieces(text, raw, spans, ignore),
  };
}

/** Pieces left in the title that look like part of a date or time (see DOUBT_PATTERNS). */
function doubtfulPieces(text: string, raw: string, spans: TaskSpan[], ignore: NonNullable<TaskParseOptions["ignore"]>): DoubtfulPiece[] {
  const found: DoubtfulPiece[] = [];
  for (const pattern of DOUBT_PATTERNS) {
    for (const m of text.matchAll(new RegExp(pattern.source, "gu"))) {
      const start = m.index!;
      const end = start + m[0].length;
      const piece = raw.slice(start, end);
      if (spans.some((s) => start < s.end && end > s.start) || found.some((f) => start < f.end && end > f.start)) continue;
      if (ignore.some((i) => i.kind === "doubtful" && i.text === piece)) continue;
      found.push({ start, end, text: piece });
    }
  }
  // "下午3點到" with nothing after the 到: the end of a range that was never given
  for (const s of spans) {
    const dangling = /^\s*[到至~～]/.exec(text.slice(s.end));
    if (s.kind !== "time" || !dangling) continue;
    const start = s.end + dangling[0].length - 1;
    const piece = raw.slice(start, start + 1);
    if (!found.some((f) => start < f.end && start + 1 > f.start) && !spans.some((o) => start < o.end && start + 1 > o.start)
      && !ignore.some((i) => i.kind === "doubtful" && i.text === piece)) found.push({ start, end: start + 1, text: piece });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** `text` minus the spans, as a title: no doubled spaces, no gap where two words would fuse. */
function titleWithout(text: string, spans: TaskSpan[]): string {
  let out = "";
  let at = 0;
  const append = (piece: string): void => {
    if (!piece) return;
    const last = out[out.length - 1];
    // two latin words must not glue together after a piece is cut out between them
    if (last !== undefined && /[\p{L}\p{N}]/u.test(last) && /[\p{L}\p{N}]/u.test(piece[0]!) && /[\x21-\x7e]/.test(last) && /[\x21-\x7e]/.test(piece[0]!)) out += " ";
    out += piece;
  };
  for (const s of spans) { append(text.slice(at, s.start)); at = s.end; }
  append(text.slice(at));
  return out.replace(/\s+/g, " ").trim();
}

function parseToday(today: string): Ymd {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(today);
  if (!m) throw new Error("parseTaskInput: today must be YYYY-MM-DD");
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}
