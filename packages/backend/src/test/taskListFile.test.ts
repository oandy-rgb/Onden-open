// The standalone task list file (services/taskListFile.ts): what it looks like
// (the snapshot is the contract a vault with the Obsidian Tasks plugin reads),
// and that reading it back gives every field the export wrote.

import { describe, expect, it } from "vitest";
import { isTaskList, parseTaskList, recurAsWords, recurFromWords, renderTaskList, taskLine, taskRef, refMatchesId, type TaskListItem } from "../services/taskListFile.js";

const task = (over: Partial<TaskListItem> & { fields?: Record<string, string> }): TaskListItem => ({
  id: "0f3a9c2b-1d44-4e0a-9a52-aaaaaaaaaaaa", title: "買牛奶", bodyLink: null, doneOn: null,
  ...over, fields: { _task_status: "todo", ...over.fields },
});

const TASKS: TaskListItem[] = [
  task({ id: "0f3a9c2b-1d44-4e0a-9a52-aaaaaaaaaaaa", title: "買牛奶", fields: { _task_when: "2026-10-24", _task_deadline: "2026-10-30", _task_recur: "1w" } }),
  task({ id: "1a000000-0000-4000-8000-000000000001", title: "寫報告", bodyLink: "任務/寫報告", fields: { _task_when: "2026-11-03", _task_evening: "true" } }),
  task({ id: "2b000000-0000-4000-8000-000000000002", title: "整理書桌", fields: {} }),
  task({ id: "3c000000-0000-4000-8000-000000000003", title: "學吉他", fields: { _task_someday: "true", _task_remind_at: "2026-12-01T09:30" } }),
  task({ id: "4d000000-0000-4000-8000-000000000004", title: "等回信", fields: { _task_status: "waiting", _task_due: "2026-10-20", _task_recur: "2w", _task_recur_mode: "after_done" } }),
  task({ id: "5e000000-0000-4000-8000-000000000005", title: "寄信", doneOn: "2026-10-20", fields: { _task_status: "done", _task_when: "2026-10-19" } }),
];

const OPTIONS = { lang: "zh-TW" as const, today: "2026-10-24", exportedAt: "2026-10-24T08:00:00.000Z" };

describe("the task list file", () => {
  it("is written as a vault with the Obsidian Tasks plugin reads it", () => {
    expect(renderTaskList(TASKS, OPTIONS)).toBe(`---
onden_export: tasks
exported_at: "2026-10-24T08:00:00.000Z"
---

> 這份清單由 Onden 匯出，每一行是一個獨立任務（不屬於任何筆記）。日期與重複用 Obsidian Tasks 外掛的寫法：⏳ 何時做、📅 截止、🔁 重複、✅ 完成。行尾的 ^代碼請保留，匯回 Onden 時用來對回同一個任務；標題下的段落只是分類，可以隨意搬動。

## 今天

- [ ] 等回信 🔁 every 2 weeks ⏳ 2026-10-20 [status:: waiting] [recur_mode:: after_done] ^t-4d0000000000
- [ ] 買牛奶 🔁 every week ⏳ 2026-10-24 📅 2026-10-30 ^t-0f3a9c2b1d44

## 接下來

- [ ] 寫報告 [[任務/寫報告]] ⏳ 2026-11-03 [evening:: true] ^t-1a0000000000

## 隨時

- [ ] 整理書桌 ^t-2b0000000000

## 某天

- [ ] 學吉他 [remind_at:: 2026-12-01T09:30] [someday:: true] ^t-3c0000000000

## 已完成

- [x] 寄信 ⏳ 2026-10-19 ✅ 2026-10-20 ^t-5e0000000000
`);
  });

  it("names its sections in English for an English export", () => {
    const text = renderTaskList([TASKS[0]!, TASKS[5]!], { ...OPTIONS, lang: "en" });
    expect(text).toContain("## Today\n");
    expect(text).toContain("## Done\n");
    expect(text).toContain("> This list was exported from Onden;");
  });

  it("reads every field back from the lines it wrote", () => {
    const text = renderTaskList(TASKS, OPTIONS);
    expect(isTaskList(text)).toBe(true);
    const read = parseTaskList(text);
    expect(read).toHaveLength(TASKS.length);
    for (const want of TASKS) {
      const got = read.find((r) => r.ref === taskRef(want.id))!;
      expect(got, want.title).toBeDefined();
      expect(got.link ? got.title : got.titleWithLink).toBe(want.title);
      expect(got.link).toBe(want.bodyLink);
      // "何時做" is read under its new name whichever key it was written from.
      const { _task_due, ...rest } = want.fields;
      // …and the ✅ day is read as the instant it was completed (midday UTC of that day).
      expect(got.fields).toEqual({ ...rest, ...(_task_due ? { _task_when: _task_due } : {}), ...(want.doneOn ? { _task_done_at: `${want.doneOn}T12:00:00.000Z` } : {}) });
    }
  });

  it("matches a reference to the node id it came from", () => {
    expect(taskRef("0f3a9c2b-1d44-4e0a-9a52-aaaaaaaaaaaa")).toBe("t-0f3a9c2b1d44");
    expect(refMatchesId("t-0f3a9c2b1d44", "0f3a9c2b-1d44-4e0a-9a52-aaaaaaaaaaaa")).toBe(true);
    expect(refMatchesId("t-0f3a9c2b1d45", "0f3a9c2b-1d44-4e0a-9a52-aaaaaaaaaaaa")).toBe(false);
    expect(refMatchesId("not-a-ref", "0f3a9c2b-1d44-4e0a-9a52-aaaaaaaaaaaa")).toBe(false);
  });

  it("writes a repeat as words and reads the words back", () => {
    for (const rule of ["1d", "2d", "1w", "3w", "1m", "12m"]) expect(recurFromWords(recurAsWords(rule)), rule).toBe(rule);
    expect(recurAsWords("2w")).toBe("every 2 weeks");
    expect(recurFromWords("every day")).toBe("1d");
    // Onden has no year unit: years are months, and a count too big for a rule stays text.
    expect(recurFromWords("every year")).toBe("12m");
    expect(recurFromWords("every 2 years")).toBe("24m");
    expect(recurFromWords("every 100 years")).toBe("every 100 years");
    expect(recurAsWords("1y")).toBe("1y");
    // A rule the words do not cover travels as it is.
    expect(recurFromWords(recurAsWords("every weekday when done"))).toBe("every weekday when done");
  });

  it("keeps a value that is not a date out of the date symbols", () => {
    const line = taskLine(task({ fields: { _task_when: "today", _task_deadline: "soon" } }));
    expect(line).not.toMatch(/⏳|📅/);
    const [read] = parseTaskList(`- [ ] x\n${line}\n`).slice(1);
    expect(read!.fields).toMatchObject({ _task_when: "today", _task_deadline: "soon" });
  });

  it("reads a line written by hand in Obsidian, without a reference", () => {
    const [read] = parseTaskList("- [/] 練習 ⏳ 2026-10-25 🔁 every 3 days\n");
    expect(read).toMatchObject({ title: "練習", ref: null, fields: { _task_status: "doing", _task_when: "2026-10-25", _task_recur: "3d" } });
  });

  it("is not fooled by a note that merely has checkboxes", () => {
    expect(isTaskList("---\ntitle: 任務\n---\n- [ ] a\n")).toBe(false);
    expect(isTaskList("- [ ] a ⏳ 2026-10-24\n")).toBe(false);
  });

  it("writes a title with a line break on one line", () => {
    expect(taskLine(task({ title: "a\nb" }))).toMatch(/^- \[ \] a b /);
  });
});

describe("code fences in a task list file", () => {
  const titles = (md: string) => parseTaskList(md).map((read) => read.title);

  it("a ~~~ line inside a ``` block does not end it", () => {
    expect(titles("```\n~~~\n- [ ] 程式碼裡\n```\n- [ ] 外面")).toEqual(["外面"]);
  });

  it("a ``` line inside a ~~~ block does not end it", () => {
    expect(titles("~~~\n```\n- [ ] 程式碼裡\n~~~\n- [ ] 外面")).toEqual(["外面"]);
  });

  it("a longer fence closes only with one at least as long", () => {
    expect(titles("````\n```\n- [ ] 程式碼裡\n````\n- [ ] 外面")).toEqual(["外面"]);
  });

  it("an unclosed fence runs to the end", () => {
    expect(titles("- [ ] 前面\n```\n- [ ] 程式碼裡")).toEqual(["前面"]);
  });
});
