// Quick-add writes a task as a line of a note: the one it named, else the note dayNotes.openTaskHome
// picks for the chosen space (today's diary, the 任務 note, a shared space's 任務 note — its rules are
// tested in dailyModule.test.tsx). A clock time with the day is the time at the start of the line
// (`time`), not a reminder.
import { beforeEach, describe, expect, it, vi } from "vitest";

const createStandaloneTask = vi.hoisted(() => vi.fn());
const openTaskHome = vi.hoisted(() => vi.fn());
vi.mock("../lib/data", async (original) => ({
  ...await original<typeof import("../lib/data")>(),
  taskWriter: { createStandaloneTask },
  dayNotes: { openTaskHome },
}));

import { createQuickTask, type QuickTaskFields } from "../modules/tasks/createQuickTask";

const base: QuickTaskFields = {
  title: "回覆提案", when_date: null, time: null, evening: false, someday: false, deadline: null,
  recur: null, recur_mode: "fixed", remind_at: null, note: null,
};

beforeEach(() => {
  createStandaloneTask.mockReset().mockResolvedValue({ status: "synced" });
  openTaskHome.mockReset().mockResolvedValue({ node: { id: "day-note", title: "2026-10-24" }, created: false });
});

describe("createQuickTask", () => {
  it("writes into the space's home note with the day, evening, deadline and repeat", async () => {
    expect(await createQuickTask({ ...base, when_date: "2026-10-25", evening: true, deadline: "2026-10-30", recur: "1w", recur_mode: "after" }))
      .toEqual({ saved: "saved", noteTitle: "2026-10-24" });
    expect(openTaskHome).toHaveBeenCalledWith(undefined);
    expect(createStandaloneTask).toHaveBeenCalledWith("回覆提案", expect.objectContaining({
      when: "2026-10-25", evening: true, deadline: "2026-10-30", recur: "1w", recurMode: "after", remindAt: null, into: "day-note",
    }));
  });

  it("keeps someday, and a clock time as the time of the line, not as a reminder", async () => {
    await createQuickTask({ ...base, someday: true });
    expect(createStandaloneTask.mock.calls[0]![1]).toMatchObject({ when: null, someday: true });
    await createQuickTask({ ...base, when_date: "2026-10-25", time: "15:00" });
    expect(createStandaloneTask.mock.calls[1]![1]).toMatchObject({ when: "2026-10-25", time: "15:00", remindAt: null });
  });

  it("goes where it was told: the named note, else the chosen space's home note", async () => {
    await createQuickTask({ ...base, note: { id: "n1", title: "專題" } });
    expect(createStandaloneTask.mock.calls[0]![1]).toMatchObject({ into: "n1" });
    expect(openTaskHome).not.toHaveBeenCalled();

    openTaskHome.mockResolvedValue({ node: { id: "shared-tasks", title: "任務" }, created: true, status: "synced" });
    expect(await createQuickTask({ ...base, spaceId: "sp-shared" })).toEqual({ saved: "saved", noteTitle: "任務" });
    expect(openTaskHome).toHaveBeenCalledWith("sp-shared");
    expect(createStandaloneTask.mock.calls[1]![1]).toMatchObject({ into: "shared-tasks" });
  });

  it("lets a named note win over the chosen space", async () => {
    await createQuickTask({ ...base, spaceId: "sp-shared", note: { id: "n1", title: "專題" } });
    expect(openTaskHome).not.toHaveBeenCalled();
    expect(createStandaloneTask.mock.calls[0]![1]).toMatchObject({ into: "n1" });
  });

  it("says queued when it waits for the network, and writes nothing when the note could not be started", async () => {
    createStandaloneTask.mockResolvedValue({ status: "queued" });
    expect((await createQuickTask(base)).saved).toBe("queued");
    createStandaloneTask.mockClear();
    openTaskHome.mockRejectedValue(new Error("refused"));
    await expect(createQuickTask(base)).rejects.toThrow("refused");
    expect(createStandaloneTask).not.toHaveBeenCalled();
  });
});

describe("placementLabel", () => {
  it("says the Today list for today or an earlier day, Up next for later days", async () => {
    const { placementLabel } = await import("../modules/tasks/quickAddTask");
    const reading = (when_date: string | null, extra = {}) => ({ when_date, evening: false, someday: false, ...extra }) as never;
    expect(placementLabel(reading("2026-10-24"), "2026-10-24")).toBe("Today list");
    expect(placementLabel(reading("2026-10-24T15:00", { evening: true }), "2026-10-24")).toBe("Today list · tonight");
    expect(placementLabel(reading("2026-10-25"), "2026-10-24")).toBe("Up next · Tomorrow");
    expect(placementLabel(reading(null, { someday: true }), "2026-10-24")).toBe("Someday list");
  });

  it("names the note the line was written in", async () => {
    const { placementLabel } = await import("../modules/tasks/quickAddTask");
    expect(placementLabel({ when_date: "2026-10-24", evening: false, someday: false } as never, "2026-10-24", "2026-10-24"))
      .toBe("Today list · written in 2026-10-24");
  });
});

describe("readMention", () => {
  it("takes the @name out of the text, wherever it is", async () => {
    const { readMention } = await import("../modules/tasks/quickAddTask");
    expect(readMention("明天 交報告 @專題")).toEqual({ name: "專題", rest: "明天 交報告" });
    expect(readMention("@專題 交報告")).toEqual({ name: "專題", rest: "交報告" });
    expect(readMention("交 @專題 報告")).toEqual({ name: "專題", rest: "交 報告" });
  });
  it("leaves an email address and plain text alone", async () => {
    const { readMention } = await import("../modules/tasks/quickAddTask");
    expect(readMention("寄給 a@b.com")).toBeNull();
    expect(readMention("沒有提到")).toBeNull();
  });
});
