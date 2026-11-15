import { describe, expect, it } from "vitest";
import { parseTaskInput, type ParsedTask } from "./taskParse.js";

// 2026-10-24 is a Saturday. Weeks run Monday to Sunday.
const SAT = "2026-10-24";
const SUN = "2026-10-25";
const MON = "2026-10-26";

const parse = (text: string, today = SAT, extra: { nowTime?: string; locale?: string } = {}) =>
  parseTaskInput(text, { today, ...extra });

type Case = [input: string, today: string, expected: Partial<ParsedTask>];

const cases: Case[] = [
  // ── relative days ──
  ["今天 買牛奶", SAT, { title: "買牛奶", when_date: SAT, anytime: false }],
  ["明天交報告", SAT, { title: "交報告", when_date: SUN }],
  ["後天開會", SAT, { title: "開會", when_date: MON }],
  ["大後天看牙醫", SAT, { title: "看牙醫", when_date: "2026-10-27" }],
  ["買菜 明天", SAT, { title: "買菜", when_date: SUN }],
  ["明日 散步", SAT, { title: "散步", when_date: SUN }],
  ["3天後 還書", SAT, { title: "還書", when_date: "2026-10-27" }],
  ["三天後還書", SAT, { title: "還書", when_date: "2026-10-27" }],
  ["8天後 繳費", SAT, { title: "繳費", when_date: "2026-11-01" }],
  ["70天後 續約", SAT, { title: "續約", when_date: "2027-01-02" }],
  ["兩週後 回診", SAT, { title: "回診", when_date: "2026-11-07" }],
  ["1個月後 檢查", SAT, { title: "檢查", when_date: "2026-11-24" }],
  ["2個月後 檢查", SAT, { title: "檢查", when_date: "2026-12-24" }],
  // ── weekdays ──
  ["週一 開會", SAT, { title: "開會", when_date: MON }],
  ["星期三 運動", SAT, { title: "運動", when_date: "2026-10-28" }],
  ["禮拜五 聚餐", SAT, { title: "聚餐", when_date: "2026-10-30" }],
  ["周日 打掃", SAT, { title: "打掃", when_date: SUN }],
  ["週天 打掃", SAT, { title: "打掃", when_date: SUN }],
  ["週六 爬山", SAT, { title: "爬山", when_date: "2026-10-31" }], // today is Saturday: the next one
  ["下週一 開會", SAT, { title: "開會", when_date: MON }],
  ["下週五 交件", SAT, { title: "交件", when_date: "2026-10-30" }],
  ["下週日 家庭日", SAT, { title: "家庭日", when_date: "2026-11-01" }],
  ["下週 規劃", SAT, { title: "規劃", when_date: MON }],
  ["下個星期二 面試", SAT, { title: "面試", when_date: "2026-10-27" }],
  ["這週六 野餐", SAT, { title: "野餐", when_date: SAT }],
  ["本週五 交件", SAT, { title: "交件", when_date: "2026-10-30" }],
  // Sunday and Monday edges
  ["週一 開會", SUN, { when_date: MON }],
  ["週日 打掃", SUN, { when_date: "2026-11-01" }],
  ["下週一 開會", SUN, { when_date: MON }],
  ["下週日 家庭日", SUN, { when_date: "2026-11-01" }],
  ["這週日 家庭日", SUN, { when_date: SUN }],
  ["週一 開會", MON, { when_date: "2026-11-02" }],
  ["下週一 開會", MON, { when_date: "2026-11-02" }],
  ["下週日 家庭日", MON, { when_date: "2026-11-08" }],
  ["這週一 開會", MON, { when_date: MON }],
  // ── months and years ──
  ["下個月 繳稅", SAT, { title: "繳稅", when_date: "2026-11-01" }],
  ["下個月15日 繳稅", SAT, { title: "繳稅", when_date: "2026-11-15" }],
  ["下個月 繳稅", "2026-12-30", { when_date: "2027-01-01" }],
  ["下個月31號 結帳", "2026-01-31", { when_date: "2026-02-28" }],
  ["後天 開會", "2026-12-30", { when_date: "2027-01-01" }],
  ["3天後 開會", "2026-12-30", { when_date: "2027-01-02" }],
  ["12/25 聖誕大餐", SAT, { title: "聖誕大餐", when_date: "2026-12-25" }],
  ["10/24 今天的事", SAT, { title: "今天的事", when_date: SAT }],
  ["10/23 去年的事", SAT, { when_date: "2027-10-23" }],
  ["1/5 開學", SAT, { title: "開學", when_date: "2027-01-05" }],
  ["2/29 閏日", SAT, { when_date: "2028-02-29" }],
  ["3月5日 生日", SAT, { title: "生日", when_date: "2027-03-05" }],
  ["12月31號 跨年", SAT, { title: "跨年", when_date: "2026-12-31" }],
  ["2027/1/5 考試", SAT, { title: "考試", when_date: "2027-01-05" }],
  ["2026-12-31 結算", SAT, { title: "結算", when_date: "2026-12-31" }],
  // ── time of day ──
  ["下午3點 開會", "2026-10-24", { title: "開會", time: "15:00", when_date: SAT }],
  ["晚上8點半 看電影", SAT, { title: "看電影", time: "20:30", when_date: SAT, evening: false }],
  ["上午9點 晨會", SAT, { time: "09:00" }],
  ["早上7:30 晨跑", SAT, { time: "07:30" }],
  ["中午12點 午餐", SAT, { time: "12:00" }],
  ["中午1點 午餐", SAT, { time: "13:00" }],
  ["下午三點 下課", SAT, { time: "15:00" }],
  ["下午3點15分 會議", SAT, { time: "15:15" }],
  ["凌晨1點 看球賽", SAT, { time: "01:00" }],
  ["晚上12點 跨年", SAT, { time: "00:00", when_date: SUN }],
  ["15:30 簡報", SAT, { title: "簡報", time: "15:30" }],
  ["明天 9:05 打卡", SAT, { title: "打卡", time: "09:05", when_date: SUN }],
  ["明天3點 開會", SAT, { title: "開會", time: "15:00", when_date: SUN }],
  ["明天9點 開會", SAT, { time: "09:00" }],
  ["3pm call mom", SAT, { title: "call mom", time: "15:00" }],
  ["call mom 3:30pm", SAT, { title: "call mom", time: "15:30" }],
  ["12am backup", SAT, { time: "00:00" }],
  ["12pm lunch", SAT, { time: "12:00" }],
  ["lunch at 15:00", SAT, { title: "lunch", time: "15:00" }],
  // a time already gone today means tomorrow; an explicit 今天 keeps today
  ["下午3點 開會", SAT, { when_date: SAT }],
  ["下午3點 開會", SAT, { when_date: SAT }],
  // ── evening ──
  ["今晚 看書", SAT, { title: "看書", when_date: SAT, evening: true, time: null }],
  ["明晚 聚餐", SAT, { title: "聚餐", when_date: SUN, evening: true }],
  ["今晚8點 看書", SAT, { title: "看書", when_date: SAT, evening: false, time: "20:00" }],
  ["tonight read", SAT, { title: "read", when_date: SAT, evening: true }],
  // ── recurrence ──
  ["每天 吃藥", SAT, { title: "吃藥", recur: "1d", when_date: SAT, recur_mode: "fixed" }],
  ["每週 倒垃圾", SAT, { title: "倒垃圾", recur: "1w", when_date: SAT }],
  ["每週一 週會", SAT, { title: "週會", recur: "1w", when_date: MON }],
  ["每週六 洗車", SAT, { title: "洗車", recur: "1w", when_date: SAT }], // a recurrence may start today
  ["每星期五 回顧", SAT, { recur: "1w", when_date: "2026-10-30" }],
  ["每個月 繳房租", SAT, { title: "繳房租", recur: "1m" }],
  ["每月 對帳", SAT, { recur: "1m" }],
  ["每年 保養", SAT, { recur: "12m" }],
  ["每3天 澆花", SAT, { title: "澆花", recur: "3d" }],
  ["每兩週 大掃除", SAT, { recur: "2w" }],
  ["每2個月 檢查", SAT, { recur: "2m" }],
  ["每天 完成後 吃藥", SAT, { title: "吃藥", recur: "1d", recur_mode: "after" }],
  ["澆花 每3天 完成後", SAT, { title: "澆花", recur: "3d", recur_mode: "after" }],
  ["明天 每週 倒垃圾", SAT, { when_date: SUN, recur: "1w" }],
  ["every day stretch", SAT, { title: "stretch", recur: "1d" }],
  ["every week review", SAT, { recur: "1w" }],
  ["every 2 weeks review", SAT, { recur: "2w" }],
  ["every mon standup", SAT, { title: "standup", recur: "1w", when_date: MON }],
  ["every year renew", SAT, { recur: "12m" }],
  // ── deadline ──
  ["週五前 交報告", SAT, { title: "交報告", deadline: "2026-10-30", when_date: null, anytime: true }],
  ["交報告 6/30截止", SAT, { title: "交報告", deadline: "2027-06-30", when_date: null }],
  ["明天做 週五前", SAT, { title: "做", when_date: SUN, deadline: "2026-10-30" }],
  ["截止 12/31 報稅", SAT, { title: "報稅", deadline: "2026-12-31" }],
  ["下週三前 繳交", SAT, { title: "繳交", deadline: "2026-10-28" }],
  ["報告 by fri", SAT, { title: "報告", deadline: "2026-10-30" }],
  ["報告 due 12/1", SAT, { title: "報告", deadline: "2026-12-01" }],
  // 日期後的「前」可隔空白、可接「交」；「前面」「前端」仍是標題
  ["資料結構作業 11/8 前", SAT, { title: "資料結構作業", deadline: "2026-11-08" }],
  ["資料結構作業 11月8日 前", SAT, { title: "資料結構作業", deadline: "2026-11-08" }],
  ["資料結構作業 11/8前交", SAT, { title: "資料結構作業", deadline: "2026-11-08" }],
  ["作業 11/8 以前", SAT, { title: "作業", deadline: "2026-11-08" }],
  ["作業 11/8 之前", SAT, { title: "作業", deadline: "2026-11-08" }],
  ["作業 11/8 到期", SAT, { title: "作業", deadline: "2026-11-08" }],
  ["作業 週五 前", SAT, { title: "作業", deadline: "2026-10-30" }],
  ["作業 明天 前", SAT, { title: "作業", deadline: SUN }],
  ["作業 下週一 前", SAT, { title: "作業", deadline: "2026-10-26" }],
  ["明天 前置作業", SAT, { title: "前置作業", when_date: SUN, deadline: null }],
  ["週五 前台報到", SAT, { title: "前台報到", when_date: "2026-10-30", deadline: null }],
  ["下週一 前三章", SAT, { title: "前三章", when_date: "2026-10-26", deadline: null }],
  ["複習 11/8 之前的筆記", SAT, { title: "複習 之前的筆記", when_date: "2026-11-08", deadline: null }],
  ["複習 11/8 以前的筆記", SAT, { title: "複習 以前的筆記", when_date: "2026-11-08", deadline: null }],
  ["作業 週五 前端", SAT, { title: "作業 前端", when_date: "2026-10-30", deadline: null }],
  // ── someday / anytime / default ──
  ["某天 學吉他", SAT, { title: "學吉他", someday: true, anytime: false, when_date: null }],
  ["有空 整理照片", SAT, { title: "整理照片", someday: true }],
  ["someday learn rust", SAT, { title: "learn rust", someday: true }],
  ["隨時 讀書", SAT, { title: "讀書", anytime: true, when_date: null }],
  ["買牛奶", SAT, { title: "買牛奶", anytime: true, when_date: null, time: null, deadline: null, recur: null }],
  ["", SAT, { title: "", anytime: true }],
  // ── remind ──
  ["提醒我 明天 吃藥", SAT, { title: "吃藥", remind: true, when_date: SUN }],
  ["明天 下午3點 吃藥 提醒", SAT, { title: "吃藥", remind: true, time: "15:00" }],
  ["remind me to call mom tomorrow", SAT, { title: "call mom", remind: true, when_date: SUN }],
  // ── tags ──
  ["買牛奶 #生活", SAT, { title: "買牛奶", tags: ["生活"] }],
  ["#工作 #urgent 寫週報", SAT, { title: "寫週報", tags: ["工作", "urgent"] }],
  ["明天 開會 #work/team", SAT, { title: "開會", tags: ["work/team"], when_date: SUN }],
  // ── English ──
  ["buy milk today", SAT, { title: "buy milk", when_date: SAT }],
  ["call mom tomorrow", SAT, { title: "call mom", when_date: SUN }],
  ["standup mon", SAT, { title: "standup", when_date: MON }],
  ["standup next mon", SAT, { when_date: MON }],
  ["plan next week", SAT, { title: "plan", when_date: MON }],
  ["plan next month", SAT, { when_date: "2026-11-01" }],
  ["pay rent in 3 days", SAT, { title: "pay rent", when_date: "2026-10-27" }],
  ["review this friday", SAT, { when_date: "2026-10-30" }],
  ["The Day After Tomorrow", SAT, { when_date: MON }],
  // ── NOT recognised: these are titles ──
  ["週末計畫", SAT, { title: "週末計畫", when_date: null, anytime: true, spans: [] }],
  ["下午茶", SAT, { title: "下午茶", spans: [] }],
  ["3 點重點", SAT, { title: "3 點重點", spans: [] }],
  ["下週末旅行", SAT, { title: "下週末旅行", spans: [] }],
  ["三週年紀念", SAT, { title: "三週年紀念", spans: [] }],
  ["上週一的會議紀錄", SAT, { title: "上週一的會議紀錄", spans: [] }],
  ["每日一句", SAT, { spans: [] }],
  ["提醒我媽買藥", SAT, { title: "提醒我媽買藥", remind: false, spans: [] }],
  ["提醒事項整理 明天", SAT, { remind: false }],
  ["某天的會議", SAT, { title: "某天的會議", someday: false, spans: [] }],
  ["有空間再說", SAT, { title: "有空間再說", someday: false, spans: [] }],
  ["完成後檢查", SAT, { title: "完成後檢查", recur_mode: "fixed", spans: [] }],
  ["週五前面的路口", SAT, { title: "前面的路口", when_date: "2026-10-30", deadline: null }],
  ["13/45 比例", SAT, { title: "13/45 比例", spans: [] }],
  ["2/30 不存在", SAT, { spans: [] }],
  ["25:99 不是時間", SAT, { time: null, spans: [] }],
  ["issue #123 修復", SAT, { title: "issue #123 修復", tags: [], spans: [] }],
  ["C# 筆記", SAT, { title: "C# 筆記", tags: [], spans: [] }],
  ["晚上的課程回顧", SAT, { title: "晚上的課程回顧", evening: false, spans: [] }],
  ["早上好", SAT, { title: "早上好", spans: [] }],
  ["monday blues playlist", SAT, { when_date: MON }], // a full weekday name counts anywhere
  ["Mon Pay 對帳", SAT, { title: "Mon Pay 對帳", when_date: null }],
  ["weekly report", SAT, { title: "weekly report", recur: null }],
  ["Sunday Times article", SAT, { when_date: SUN }],
];

describe("parseTaskInput", () => {
  it.each(cases.map((c, i) => [i, c[0], c[1], c[2]] as const))(
    "#%i %s (today %s)",
    (_i, input, today, expected) => {
      const extra = input === "Mon Pay 對帳" ? { locale: "zh-TW" } : {};
      expect(parse(input, today, extra)).toMatchObject(expected);
    },
  );

  it("moves a time that has already passed today to tomorrow", () => {
    expect(parse("下午3點 開會", SAT, { nowTime: "16:00" })).toMatchObject({ when_date: SUN, time: "15:00" });
    expect(parse("下午3點 開會", SAT, { nowTime: "14:00" })).toMatchObject({ when_date: SAT });
    expect(parse("今天下午3點 開會", SAT, { nowTime: "16:00" })).toMatchObject({ when_date: SAT });
    expect(parse("週一下午3點 開會", SAT, { nowTime: "16:00" })).toMatchObject({ when_date: MON });
  });

  it("takes the day as an id and the clock as nowTime, never from the device", () => {
    expect(parseTaskInput("下午3點 開會", { today: SAT, nowTime: "16:30" })).toMatchObject({ when_date: SUN });
    expect(parseTaskInput("明天", { today: SAT, nowTime: "16:30" })).toMatchObject({ when_date: SUN });
  });

  it("keeps bare English weekday abbreviations only outside a Chinese UI", () => {
    expect(parse("standup mon", SAT, { locale: "en" }).when_date).toBe(MON);
    expect(parse("standup mon", SAT, { locale: "zh-TW" }).when_date).toBeNull();
    expect(parse("standup monday", SAT, { locale: "zh-TW" }).when_date).toBe(MON);
    expect(parse("standup next mon", SAT, { locale: "zh-TW" }).when_date).toBe(MON);
  });

  it("reports spans with their kinds, in order", () => {
    const text = "明天下午3點 交報告 #學校";
    const r = parse(text);
    expect(r.spans.map((s) => [s.kind, text.slice(s.start, s.end)])).toEqual([
      ["date", "明天"],
      ["time", "下午3點"],
      ["tag", "#學校"],
    ]);
    expect(r.title).toBe("交報告");
  });

  it("marks the deadline word as part of the deadline span", () => {
    const text = "交報告 週五前";
    const r = parse(text);
    expect(r.spans.map((s) => [s.kind, text.slice(s.start, s.end)])).toEqual([["deadline", "週五前"]]);
  });

  it("leaves a reading the person took back in the title", () => {
    const r = parseTaskInput("明天 交報告", { today: SAT, ignore: [{ kind: "date", text: "明天" }] });
    expect(r).toMatchObject({ title: "明天 交報告", when_date: null, anytime: true, spans: [] });
    // another piece of the same kind is still read
    const r2 = parseTaskInput("明天 後天", { today: SAT, ignore: [{ kind: "date", text: "明天" }] });
    expect(r2).toMatchObject({ title: "明天", when_date: MON });
  });

  it("drops 完成後 when the recurrence is taken back", () => {
    const r = parseTaskInput("每天 完成後 吃藥", { today: SAT, ignore: [{ kind: "recur", text: "每天" }] });
    expect(r).toMatchObject({ recur: null, recur_mode: "fixed", title: "每天 完成後 吃藥" });
  });

  it("does not let a later phrase replace the first date", () => {
    const r = parse("明天 後天 開會");
    expect(r).toMatchObject({ when_date: SUN, title: "後天 開會" });
  });

  it("keeps a date over 某天", () => {
    expect(parse("某天 明天 做")).toMatchObject({ someday: false, when_date: SUN });
  });

  it("rejects a malformed today", () => {
    expect(() => parseTaskInput("x", { today: "tomorrow" })).toThrow();
  });
});
