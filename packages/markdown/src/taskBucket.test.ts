import { describe, expect, it } from "vitest";
import { dayBucket, taskBucket, taskHome } from "./taskBucket.js";

const today = "2026-10-27";

describe("taskBucket", () => {
  it("cuts the days around today", () => {
    const at = (when: string | null) => taskBucket({ status: "todo", when }, today);
    expect(at(null)).toBe("unscheduled");
    expect(at("2026-10-26")).toBe("overdue");
    expect(at("2026-10-27")).toBe("today");
    expect(at("2026-11-03")).toBe("upcoming");
    expect(at("2026-11-04")).toBe("scheduled");
    expect(at("2026-10-26T09:00")).toBe("overdue");
  });
  it("lets status and the someday flag win over the day", () => {
    expect(taskBucket({ status: "done", when: "2026-10-26" }, today)).toBe("done");
    expect(taskBucket({ status: "cancelled", when: null }, today)).toBe("done");
    expect(taskBucket({ status: "waiting", when: "2026-10-26" }, today)).toBe("waiting");
    expect(taskBucket({ status: "todo", when: "2026-10-26", someday: true }, today)).toBe("later");
  });
});

describe("taskHome", () => {
  it("folds overdue into today and keeps the rest apart", () => {
    expect(dayBucket({ when: "2026-10-01" }, today)).toBe("overdue");
    expect(taskHome({ when: "2026-10-01" }, today)).toBe("today");
    expect(taskHome({ when: today }, today)).toBe("today");
    expect(taskHome({ when: "2026-12-01" }, today)).toBe("upcoming");
    expect(taskHome({ when: null }, today)).toBe("anytime");
    expect(taskHome({ when: null, someday: true }, today)).toBe("someday");
    expect(taskHome({ when: "2026-12-01", someday: true }, today)).toBe("someday");
  });
});
