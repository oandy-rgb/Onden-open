// Random quick-add text against the parser (packages/markdown/src/taskParse.ts).
//
// The input mixes real schedule phrases with free text and noise, because a
// random string alone almost never contains "明天". Invariants:
//   • it never throws, for any text and any day
//   • spans are sorted, non-empty, inside the text and never overlap
//   • nothing is lost: the title plus the recognised pieces are exactly the
//     characters of the input (whitespace aside), so a reading can be taken back
//   • every field it fills is well formed (dates, HH:MM, recurrence token)
//   • taking back every reading gives a title equal to the input (trimmed)
//
// Replay a failure:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/taskParse

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseTaskInput, type TaskParseOptions } from "@onden/markdown/task-parse";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const PHRASES = [
  "今天", "明天", "後天", "大後天", "今晚", "明晚", "週五", "星期日", "禮拜三", "下週一", "下週", "下個月", "下個月5日",
  "3天後", "兩週後", "1個月後", "12/25", "1/5", "3月5日", "2027/1/5", "下午3點", "晚上8點半", "上午9:30", "15:30", "明天3點",
  "每天", "每週", "每週一", "每月", "每年", "每3天", "每兩週", "完成後", "週五前", "6/30截止", "截止 12/31", "某天", "有空",
  "隨時", "提醒我", "提醒", "#工作", "#a/b", "#", "today", "tomorrow", "mon", "next week", "every week", "by fri", "3pm",
  "at 15:00", "remind me to", "週末", "下午茶", "3 點", "13/45", "25:99", "晚上12點", "今晚8點",
];
const FREE = ["買牛奶", "開會", "report", "Pay", "、", "，", " ", "  ", "\n", "😀", "​", "é", "一", "十", "點", "前", "後"];

const text = fc
  .array(fc.oneof({ weight: 5, arbitrary: fc.constantFrom(...PHRASES) }, { weight: 3, arbitrary: fc.constantFrom(...FREE) }, { weight: 1, arbitrary: fc.string({ maxLength: 6 }) }), { maxLength: 8 })
  .chain((parts) => fc.constantFrom("", " ").map((glue) => parts.join(glue)));

const day = fc
  .date({ min: new Date("2020-01-01T00:00:00Z"), max: new Date("2032-12-31T00:00:00Z"), noInvalidDate: true })
  .map((d): TaskParseOptions["today"] => d.toISOString().slice(0, 10));

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const sortedChars = (s: string) => [...s.replace(/\s/gu, "")].sort().join("");

describe("parseTaskInput (random text)", () => {
  it("never throws; spans are ordered, in range and disjoint; title + pieces rebuild the input", () => {
    fc.assert(
      fc.property(text, day, fc.constantFrom("zh-TW", "en"), (input, today, locale) => {
        const r = parseTaskInput(input, { today, locale });
        let end = 0;
        for (const s of r.spans) {
          expect(s.start).toBeGreaterThanOrEqual(end);
          expect(s.end).toBeGreaterThan(s.start);
          expect(s.end).toBeLessThanOrEqual(input.length);
          end = s.end;
        }
        const pieces = r.spans.map((s) => input.slice(s.start, s.end)).join("");
        expect(sortedChars(r.title + pieces)).toBe(sortedChars(input));
        expect(r.title).toBe(r.title.trim());
        expect(r.title).not.toMatch(/\s{2,}/);
      }),
      { numRuns: PROPS_RUNS, seed: PROPS_SEED },
    );
  });

  it("fills only well-formed fields", () => {
    fc.assert(
      fc.property(text, day, (input, today) => {
        const r = parseTaskInput(input, { today });
        if (r.when_date !== null) expect(r.when_date).toMatch(YMD);
        if (r.deadline !== null) expect(r.deadline).toMatch(YMD);
        if (r.time !== null) expect(r.time).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
        if (r.recur !== null) expect(r.recur).toMatch(/^[1-9]\d*[dwm]$/);
        if (r.recur === null) expect(r.recur_mode).toBe("fixed");
        // the day, the parking lot and "any time" are exclusive
        expect([r.when_date !== null, r.someday, r.anytime].filter(Boolean).length).toBe(1);
        if (r.evening) expect(r.when_date).not.toBeNull();
        for (const tag of r.tags) expect(input).toContain(`#${tag}`);
      }),
      { numRuns: PROPS_RUNS, seed: PROPS_SEED },
    );
  });

  it("taking back every reading leaves the input as the title", () => {
    fc.assert(
      fc.property(text, day, (input, today) => {
        const first = parseTaskInput(input, { today });
        const ignore = first.spans.map((s) => ({ kind: s.kind, text: input.slice(s.start, s.end) }));
        // Ignoring readings can expose others hidden behind them, so repeat until nothing is read.
        let r = parseTaskInput(input, { today, ignore });
        for (let i = 0; i < 20 && r.spans.length > 0; i++) {
          ignore.push(...r.spans.map((s) => ({ kind: s.kind, text: input.slice(s.start, s.end) })));
          r = parseTaskInput(input, { today, ignore });
        }
        expect(r.spans).toEqual([]);
        expect(r.title).toBe(input.replace(/\s+/g, " ").trim());
      }),
      { numRuns: PROPS_RUNS, seed: PROPS_SEED },
    );
  });
});
