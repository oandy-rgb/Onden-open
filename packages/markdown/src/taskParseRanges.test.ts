// Quick-add phrasing added in the 2026-11 batch: time ranges, a bare half hour, a part of the day,
// durations, month end, and the "did not understand this part" report. today = Mon 2026-11-02, 03:20.

import { describe, expect, it } from "vitest";
import { EN_WEEKDAY_FULL, EN_WEEKDAY_FULL_PATTERN, EN_WEEKDAY_SHORT, EN_WEEKDAY_SHORT_PATTERN, parseTaskInput, type ParsedTask } from "./taskParse.js";

const TODAY = "2026-11-02";
const parse = (text: string, ignore: Parameters<typeof parseTaskInput>[1]["ignore"] = []) =>
  parseTaskInput(text, { today: TODAY, nowTime: "03:20", locale: "zh-TW", ignore });
const pick = (p: ParsedTask) => ({ title: p.title, date: p.when_date, time: p.time, until: p.until, duration: p.duration, daypart: p.daypart, evening: p.evening, deadline: p.deadline, recur: p.recur });

describe("time ranges", () => {
  it.each<[string, Partial<ReturnType<typeof pick>>]>([
    ["下午3點到5點 讀OS", { title: "讀OS", date: TODAY, time: "15:00", until: "17:00", duration: 120 }],
    ["14:00-15:30 讀書", { title: "讀書", time: "14:00", until: "15:30", duration: 90 }],
    ["14：00～15：30 讀書", { title: "讀書", time: "14:00", until: "15:30" }],
    ["明天 3點到5點 讀書", { title: "讀書", date: "2026-11-03", time: "15:00", until: "17:00" }],
    ["10點到12點 看展", { title: "看展", time: "10:00", until: "12:00" }],
    ["上午10點到下午1點 看展", { title: "看展", time: "10:00", until: "13:00" }],
    ["3點半 開會", { title: "開會", date: TODAY, time: "15:30", until: null }],
    ["8點10分 起床", { title: "起床", time: "08:10" }],
    ["明天下午3點 讀書 1小時", { title: "讀書", date: "2026-11-03", time: "15:00", until: "16:00", duration: 60 }],
  ])("%s", (input, expected) => expect(pick(parse(input))).toMatchObject(expected));

  it("keeps the whole range as one time piece so taking it back returns every word", () => {
    const p = parse("下午3點到5點 讀OS");
    expect(p.spans).toEqual([{ start: 0, end: 7, kind: "time" }]);
    expect(parse("下午3點到5點 讀OS", [{ kind: "time", text: "下午3點到5點" }]).time).toBeNull();
  });

  it("an end that is not later than the start is not an end", () => {
    expect(pick(parse("下午5點到3點 讀書"))).toMatchObject({ time: "17:00", until: null });
  });
});

describe("a part of the day", () => {
  it.each<[string, Partial<ReturnType<typeof pick>>]>([
    ["週五下午 交報告", { title: "交報告", date: "2026-11-06", daypart: "afternoon", time: null }],
    ["每週五晚上 健身", { title: "健身", date: "2026-11-06", recur: "1w", daypart: "evening", evening: true }],
    ["明早 跑步", { title: "跑步", date: "2026-11-03", daypart: "morning" }],
    ["中午 吃飯", { title: "吃飯", date: TODAY, daypart: "noon" }],
    ["晚上 健身", { title: "健身", date: TODAY, daypart: "evening", evening: true }],
    ["交報告 週五下午", { title: "交報告", date: "2026-11-06", daypart: "afternoon" }],
  ])("%s", (input, expected) => expect(pick(parse(input))).toMatchObject(expected));

  it("a part of the day already over today means tomorrow", () => {
    const p = parseTaskInput("早上 跑步", { today: TODAY, nowTime: "15:00", locale: "zh-TW" });
    expect(p.when_date).toBe("2026-11-03");
  });

  it.each(["下午茶", "週末計畫", "晚上的課", "3 點重點"])("%s stays in the title", (input) => {
    const p = parse(input);
    expect(p.title).toBe(input);
    expect(p.spans).toEqual([]);
    expect(p.daypart).toBeNull();
  });
});

describe("how long", () => {
  it.each<[string, number, string]>([
    ["讀書 30分鐘", 30, "讀書"],
    ["1小時 讀書", 60, "讀書"],
    ["讀書 1.5小時", 90, "讀書"],
    ["讀書 一個半小時", 90, "讀書"],
    ["讀書 半小時", 30, "讀書"],
    ["讀書 兩個小時", 120, "讀書"],
    ["read 45 min", 45, "read"],
  ])("%s", (input, minutes, title) => {
    const p = parse(input);
    expect(p.duration).toBe(minutes);
    expect(p.title).toBe(title);
    expect(p.time).toBeNull();
    expect(p.until).toBeNull();
  });

  it("with a clock time the end follows; without one only the length is kept", () => {
    expect(pick(parse("15:00 讀書 90分鐘"))).toMatchObject({ time: "15:00", until: "16:30", duration: 90 });
    expect(pick(parse("23:30 讀書 1小時"))).toMatchObject({ time: "23:30", until: null, duration: 60 });
  });

  it("3點10分 is a clock, not a length", () => {
    expect(parse("3點10分 開會").duration).toBeNull();
  });
});

describe("month end", () => {
  it("月底前 is a deadline on the last day", () => {
    expect(pick(parse("月底前 交報告"))).toMatchObject({ title: "交報告", deadline: "2026-11-30", date: null });
  });
  it("月底 alone is the day to do it; 下個月底 is next month's", () => {
    expect(parse("月底 交報告").when_date).toBe("2026-11-30");
    expect(parse("下個月底 交報告").when_date).toBe("2026-12-31");
  });
});

describe("unchanged readings", () => {
  it.each<[string, Partial<ReturnType<typeof pick>>]>([
    ["明天下午3點", { date: "2026-11-03", time: "15:00" }],
    ["15:00", { time: "15:00" }],
    ["早上9點", { time: "09:00" }],
    ["下午三點", { time: "15:00" }],
    ["明天晚上8點", { date: "2026-11-03", time: "20:00" }],
    ["今晚", { date: TODAY, evening: true }],
    ["下禮拜三", { date: "2026-11-11" }],
    ["11/5", { date: "2026-11-05" }],
    ["11月5日 23:59", { date: "2026-11-05", time: "23:59" }],
    ["下週一前", { deadline: "2026-11-09" }],
    ["截止週五", { deadline: "2026-11-06" }],
    ["每兩週", { recur: "2w" }],
    ["每週五晚上8點", { recur: "1w", time: "20:00", date: "2026-11-06" }],
  ])("%s", (input, expected) => expect(pick(parse(input))).toMatchObject(expected));

  it("recurrence after completion, someday, remind, tag, mention-less title", () => {
    expect(parse("每天 讀書 完成後")).toMatchObject({ recur: "1d", recur_mode: "after", title: "讀書" });
    expect(parse("某天 學吉他")).toMatchObject({ someday: true, title: "學吉他" });
    expect(parse("明天 提醒我 交報告")).toMatchObject({ remind: true, title: "交報告" });
    expect(parse("寫作 #標籤").tags).toEqual(["標籤"]);
  });
});

describe("a piece that was only half understood", () => {
  it("is reported and stays in the title", () => {
    const p = parse("下午3點到 讀書");
    expect(p.time).toBe("15:00");
    expect(p.doubtful.map((d) => d.text)).toEqual(["到"]);
    expect(p.title).toContain("到");
  });

  it.each<[string, string]>([
    ["3點 開會", "3點"],
    ["14:00 15:00 開會", "15:00"],
    ["25:70 開會", "25:70"],
    ["11月5 交報告", "11月5"],
    ["11月 交報告", "11月"],
    ["下午3 讀書", "下午3"],
    ["到5點 讀書", "到5點"],
  ])("%s → 「%s」", (input, piece) => {
    expect(parse(input).doubtful.map((d) => d.text)).toContain(piece);
  });

  it("positions point into the typed text", () => {
    const text = "3點 開會";
    const [d] = parse(text).doubtful;
    expect(text.slice(d!.start, d!.end)).toBe("3點");
  });

  it("keeping it in the title (ignoring the warning) silences it", () => {
    expect(parse("3點 開會", [{ kind: "doubtful", text: "3點" }]).doubtful).toEqual([]);
  });

  it.each(["週末計畫", "下午茶", "3 點重點", "第3點結論", "3點重點"])("%s is plain title, not doubtful", (input) => {
    expect(parse(input).doubtful).toEqual([]);
  });

  it("a reading with nothing odd reports nothing", () => {
    for (const ok of ["明天下午3點到5點 讀書", "14:00-15:30 讀書", "每週五晚上 健身", "讀書 30分鐘"]) expect(parse(ok).doubtful).toEqual([]);
  });
});

describe("English weekday patterns", () => {
  it("are the tables' keys, longest first (written out so the bundler can drop this file when unused)", () => {
    expect(EN_WEEKDAY_FULL_PATTERN).toBe(Object.keys(EN_WEEKDAY_FULL).join("|"));
    expect(EN_WEEKDAY_SHORT_PATTERN).toBe(Object.keys(EN_WEEKDAY_SHORT).sort((a, b) => b.length - a.length).join("|"));
  });
});
