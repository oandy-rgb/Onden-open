import { describe, expect, it } from "vitest";
import { readCapture, withoutLink } from "./captureText";

// A Friday.
const at = { today: "2026-10-30", nowTime: "09:00", locale: "en", tasksOn: true };

describe("reading a capture's words", () => {
  it("finds #tags, once each, and leaves the text alone", () => {
    const r = readCapture("read paper #school #school/ml", at);
    expect(r.tagPaths).toEqual(["school", "school/ml"]);
    expect(r.text).toBe("read paper #school #school/ml");
    expect(r.task).toBeNull();
  });

  it("finds [[note up to ]] or the end of the line", () => {
    expect(readCapture("idea for [[Data structures]] today", at).link).toEqual({ name: "Data structures", token: "[[Data structures]]" });
    expect(readCapture("idea\nfor [[Data structures", at).link).toEqual({ name: "Data structures", token: "[[Data structures" });
    expect(readCapture("trailing [[", at).link).toBeNull();
    expect(readCapture("closed [[]] empty", at).link).toBeNull();
    expect(readCapture("nothing here", at).link).toBeNull();
  });

  it("takes the token out of the text once it has been honoured", () => {
    expect(withoutLink("idea [[Data structures]] today", "[[Data structures]]")).toBe("idea today");
    expect(withoutLink("[[Data structures\nmore", "[[Data structures")).toBe("more");
  });

  it("a one-line day word with words is a task", () => {
    const r = readCapture("call dentist tomorrow", at);
    expect(r.task).toMatchObject({ title: "call dentist", when_date: "2026-10-31" });
    expect(readCapture("hand in the report next friday", at).task?.when_date).toBe("2026-11-06");
  });

  it("is not a task: no day, several lines, a [[note, no words, the module off", () => {
    expect(readCapture("call dentist", at).task).toBeNull();
    expect(readCapture("call dentist tomorrow\nand more", at).task).toBeNull();
    expect(readCapture("call dentist tomorrow [[People]]", at).task).toBeNull();
    expect(readCapture("tomorrow", at).task).toBeNull();
    expect(readCapture("call dentist tomorrow", { ...at, tasksOn: false }).task).toBeNull();
  });

  it("reads Chinese day words", () => {
    expect(readCapture("明天 交報告", { ...at, locale: "zh-TW" }).task).toMatchObject({ title: "交報告", when_date: "2026-10-31" });
  });
});
